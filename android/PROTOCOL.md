# MarkNotes phone sync - wire protocol v1

The phone (Android app, `android/core/.../sync`) talks straight to MarkNotes on the PC (`src/host/Sync`) over the home
network. No server, account or other company is involved: a pairing code, a pinned PC key, ECDH + AES-GCM.

## 0. Conventions

* TCP port **47830** (sync), UDP port **47831** (LAN discovery).
* Integers are big-endian. `str` = `u16 byteLength` + UTF-8 bytes. `tail` = the rest of the message.
* Crypto: NIST P-256 (ECDH, ECDSA), SHA-256, HMAC-SHA256, AES-256-GCM (16-byte tag).
* Only home-network peers are served: loopback, private and link-local IPv4, 100.64.0.0/10, IPv6 loopback, link-local
  and unique-local (fc00::/7); IPv4-mapped IPv6 counts as its IPv4. Anything else is closed at once.

## 1. Discovery (UDP 47831, plaintext)

* Phone → broadcast (255.255.255.255 and each Wi-Fi subnet broadcast, at 0 / 300 / 800 ms), or unicast to a known PC:
  ASCII `MARKNOTES?1`.
* PC → unicast reply: ASCII `MARKNOTES!1` followed by UTF-8 JSON
  `{"id":"<32 hex host id>","name":"ASUS-PC","port":47830,"fp":"<64 hex fingerprint>","pairing":false,"ver":1}`.
  `pairing` = the PC's *Pair a phone* window is open.

## 2. Handshake (TCP 47830)

Handshake messages are framed `u32 length` + body (length ≤ 4096).

ClientHello (102 bytes): `"MNSY"` · `u8 version = 1` · client ephemeral P-256 public key `04‖X‖Y` (65) · clientRandom (32).

ServerHello (231 bytes): `"MNSY"` · `u8 1` · host ephemeral key (65) · hostRandom (32) · host **identity** key (65) ·
signature (64, raw `r‖s`) = `ECDSA-P256-SHA256(identity, ClientHello ‖ ServerHello[0..167))`.

* fingerprint = `SHA256(identity public key, 65 bytes)` as 64 lowercase hex; short form = first 6 bytes `AB12-CD34-EF56`.
* The phone pins the fingerprint at pairing and refuses a PC whose key changed.
* Keys: `Z` = ECDH X coordinate (32 bytes, big-endian); `TH = SHA256(ClientHello ‖ ServerHello)`;
  `PRK = HMAC(TH, Z)`; `K1 = HMAC(PRK, "marknotes-sync-v1-keys" ‖ 01)`; `K2 = HMAC(PRK, K1 ‖ "marknotes-sync-v1-keys" ‖ 02)`.
  K1 encrypts phone → PC, K2 PC → phone.

## 3. Records (everything after ServerHello)

`u32 len` (ciphertext + 16-byte tag, 17 ≤ len ≤ 32 MiB) · ciphertext ‖ tag. Nonce = `00000000 ‖ u64 seq` (per
direction, from 0). AAD = the 4 length bytes. Plaintext = `u8 type ‖ payload`. A bad record closes the connection.

## 4. Pairing and authentication

After the handshake the phone sends `AUTH` (paired) or `PAIR_REQUEST`. Nothing within 15 s → closed.

Pairing (numeric comparison with a commitment, so a man in the middle cannot force matching codes):
1. phone → `PAIR_REQUEST` `commit = SHA256(nonceC)`;
2. PC → `PAIR_CHALLENGE nonceH` (or `PAIR_RESULT PAIRING_CLOSED` when *Pair a phone* isn't open on the PC);
3. phone → `PAIR_REVEAL nonceC`; the PC checks the commitment;
4. both show `code = u32(SHA256("marknotes-sync-v1-sas" ‖ TH ‖ nonceC ‖ nonceH)[0..4)) mod 1 000 000` as `123 456`;
   the PC asks *"<phone> wants to sync with this PC · code 123 456 · Allow / Deny"* (120 s);
5. PC → `PAIR_RESULT`. On success the phone keeps `{hostId, name, fingerprint, deviceId, token, addresses}` and
   continues with `AUTH` on the same connection.

The PC stores only `SHA256(token)` per phone. Its identity key is DPAPI-encrypted (current user).

| type | name | dir | payload |
|---|---|---|---|
| 0x01 | AUTH | P→PC | `deviceId[16] token[32] str deviceName u16 clientVersion(1)` |
| 0x02 | PAIR_REQUEST | P→PC | `commit[32] str deviceName str deviceModel` |
| 0x03 | PAIR_REVEAL | P→PC | `nonceC[32]` |
| 0x80 | AUTH_RESULT | PC→P | `u8 status str message` |
| 0x81 | PAIR_CHALLENGE | PC→P | `nonceH[32]` |
| 0x82 | PAIR_RESULT | PC→P | `u8 status`; if 0: `deviceId[16] token[32] hostId[16] str hostName`; then `str message` |

Status: `0 OK, 1 UNKNOWN_DEVICE, 2 BAD_TOKEN, 3 BUSY, 4 PAIRING_CLOSED, 5 DENIED, 6 RATE_LIMITED, 7 VERSION, 8 TIMEOUT`.
Ten failed tries from one address block it for 10 minutes.

## 5. Sync requests (after AUTH_RESULT OK)

Strictly one request at a time: the phone sends `REQUEST` and waits for its `RESPONSE`.

| type | name | dir | payload |
|---|---|---|---|
| 0x10 | REQUEST | P→PC | `tail` UTF-8 JSON `{op, …}` |
| 0x90 | RESPONSE | PC→P | `tail` UTF-8 JSON `{ok:true, …}` or `{ok:false, code, error}` |
| 0x11 / 0x91 | DATA | P→PC / PC→P | `tail` file bytes (≤ 1 MiB per record) |
| 0x12 / 0x92 | END | P→PC / PC→P | - end of a file's bytes |
| 0x5F | BYE | both | `u8 reason str message` |

Paths (`p`) are relative to the workspace folder, with `/`. Workspaces have the same id (`w-xxxxxxxx`) on both sides.

| op | request | response |
|---|---|---|
| `info` | - | `{host:{id,name,ver}, features:["history"], addresses:[…], workspaces:[{id,name,dir,color,linked,notes}]}` |
| `manifest` | `ws` | `{entries:[{p,s,m,h}` or `{p,d:true}]}` - size, mtime (ms), SHA-256 hex; `d` = folder |
| `get` | `ws p` | `{s,m,h}` then DATA… END; `{ok:false, code:"missing"}` when gone |
| `put` | `ws p s m h base [run]` then DATA… END | `{h}` (the hash the PC will list); `code:"changed"` when the PC's copy no longer has hash `base` (`base:null` = must not exist) |
| `delete` | `ws p base [run]` | `{}`; `code:"changed"` as above. The PC moves the file to the Recycle Bin |
| `restore` | `run ws p expect [undo]` | `{p, h}`: §7 |
| `forget` | `runs:[…]` | `{}`: the PC deletes the old versions it kept for those runs |
| `mkdir` / `rmdir` | `ws p` | `{}`; `rmdir` only removes an empty folder (`code:"notEmpty"`) |
| `createWs` | `ws dir meta` (base64 `.workspace.json`) | `{dir}`; creates the workspace folder with that metadata (no-op if the id exists) |
| `done` | `changed:[ws…]` | `{}`; the PC reloads those workspaces and refreshes its window |

What is synced: every file of the workspace folder except temp/system files (`*.tmp`, `~$*`, `.DS_Store`, `Thumbs.db`,
`desktop.ini`), folders `node_modules`, `$RECYCLE.BIN`, `System Volume Information`, `.git`, `.trash`, and in
`.obsidian` only what MarkNotes reads (`app.json`, `appearance.json`, `snippets/`, `plugins/obsidian-kanban/data.json`).
For a folder opened in place on the PC (an Obsidian vault), the PC presents its metadata as a virtual
`.workspace.json` (icon/banner as `.workspace-icon.*` / `.workspace-banner.*`) and maps them back on writes.

## 6. Sync rules (the phone decides; the PC only answers)

For each workspace the phone keeps, per PC, the state of the last sync: per path `{l, r}` = the local and the PC's
hash then. With L/R = hash now (or none):

* L = l and R = r → nothing. L = R → in sync (record it).
* only the PC changed (L = l) → download, or delete on the phone if the PC deleted it.
* only the phone changed (R = r) → upload (`base` = r), or delete on the PC if the phone deleted it.
* both changed → a deletion loses against an edit; `.workspace.json` is merged key by key (folders and notes entry by
  entry); any other file: the PC's version keeps the name and the phone's is kept next to it as
  `<name> (conflict <phone> <date>).<ext>` on both sides. Nothing is overwritten without a copy.
* Deletions go to the Recycle Bin on the PC and to MarkNotes' trash on the phone. If one sync would delete more than
  20 files and more than a third of a workspace on one side, the phone asks first.
* Folders: created where missing; removed only when the other side removed them and they are empty.

## 7. History and undo (PC `features` has `"history"`: MarkNotes 2.5.1 and later)

* Every run has an id `r<yyyyMMdd>-<HHmmssSSS>-<4 hex>`, sent as `run` with each `put` and `delete`. Before such a
  request replaces or deletes a file, the PC copies its version to `%LOCALAPPDATA%\MarkNotes\sync\history\<phone's
  device id>\<run>\<ws>\<p>` (the first copy of a run wins; `.workspace.json` is never kept). Deletions still go to the
  Recycle Bin as well.
* The phone records each run that changed something in `<files>/SyncHistory/<pc>/<run>/run.json`: items
  `{side here|pc|both, kind replaced|deleted|added|conflict, ws, p, old, new, trash}`, and keeps its own replaced
  versions under `<run>/files/<ws>/<p>`. Files it deleted are in MarkNotes' Trash (`trash` = the Trash item's id).
* Undo of run R (the phone; both devices on the same network) is itself a run U, so it can be undone too. For each item
  of R, newest first, only `replaced` and `deleted` ones (what R added stays):
  * on the phone: a deleted file comes back from the Trash; a replaced one comes back from R's copy if the phone's file
    still has the hash R wrote (`new`) or is gone, its current version kept under U first; otherwise the old version is
    written next to it as `<name> (before sync).<ext>`.
  * on the PC: `restore {run: R, ws, p, expect, undo: U}`: `expect` = the hash R left (`new`) for a replaced file, null
    for a deleted one. If the PC's copy still matches, R's copy takes its place (the current one is kept under U);
    otherwise R's copy is written next to it as `<name> (before sync).<ext>`. Answer `{p, h}` = where it went;
    `code:"missing"` when R's copy is gone (forgotten).
  * then a normal sync recorded in U makes both sides match. R is marked undone; items put back are marked in R, so an
    interrupted undo can be resumed.
* Nothing is deleted by date unless the user picks "Keep old versions: 30 days" on the phone; the runs it drops (and
  the ones the user deletes) are sent to the PC with `forget` at the next sync. The PC user can also delete what is
  kept for a phone in Settings › Phone.
