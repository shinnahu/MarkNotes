# MarkNotes for Android

MarkNotes on the phone, with the same interface as on the PC (the same web UI, themes, live-preview editor, kanban
boards and canvases), and a sync with MarkNotes on your PC that goes straight over your Wi‑Fi: no internet, no account,
no other company or service.

| part | file |
|---|---|
| Android app | `MarkNotes-Android-<version>.apk` (package `com.marknotes.app`) |
| PC side | MarkNotes 2.5.1 or later for Windows (`installer\MarkNotes-Setup-<version>.exe`) - the sync is built into MarkNotes |

## 1. On the PC (once)

1. Install MarkNotes 2.5.1 or later (it updates the installed MarkNotes; your notes and settings stay).
2. Open **Settings › Phone** and turn on **Sync with my phone**.
   * Windows may ask whether MarkNotes may use the network: click **Allow** (private networks).

## 2. On the phone (once)

1. Copy `MarkNotes-Android-<version>.apk` to the phone and open it. Allow installing from that source if Android asks; Play
   Protect may warn about an unknown developer: **Install anyway**.
2. Open MarkNotes. On the PC, click **Settings › Phone › Pair a phone…**.
3. On the phone: tap **Sync with PC** at the bottom of the list (or ⚙ › Sync with PC › Add a PC…) and pick your PC (same
   Wi‑Fi). If it isn't listed, type the address the PC shows in its Pair a phone window.
4. Both show the same 6-digit code. If they match, click **Allow** on the PC.
5. Pick the workspaces to keep on the phone (and phone workspaces to send to the PC), then **Sync**.

## Using it

* **☰** (or a swipe from the left edge) shows the workspaces and the folders/notes list, like Discord's server and
  channel lists. Tap a note to open it; **Back** returns to the list.
* The formatting bar sits on the keyboard (headings, bold, lists, checklists, code, tables, links, pictures, undo/redo).
* Touch and hold a note, folder or workspace for its menu (a sheet from the bottom). The note's **⋯** is at the top right.
* Canvases: drag with one finger to move around, pinch to zoom, double-tap to add a card.
* Share text or a link from any app → **MarkNotes**: it becomes a new note.

**Sync** happens by itself while the PC can be reached: when MarkNotes opens, when you come back to it, a few seconds
after you edit, when you leave the app, and every 3 minutes while it is open. Tap the sync line at the bottom of the
list to sync now (it shows "Synced 2 min ago", or "Can't reach …" away from home). MarkNotes must be open on the PC.

* A note edited on both sides is kept twice: the PC's version keeps its name and the phone's is next to it as
  "… (conflict <phone> <date>)".
* Notes deleted on one side are deleted on the other: on the PC into the Recycle Bin, on the phone into Settings › Trash.
  The phone's Trash keeps everything until you restore it or delete it for good there ("Empty the trash automatically"
  can be set to 30 days); items a sync removed are grouped, with "Restore all". A restored note goes back to the PC on
  the next sync. If one sync would delete many notes at once, the phone asks first.
* When a sync replaces or deletes a note, the old version is kept on that side (with MarkNotes 2.5.1 or later on the
  PC). Settings › Sync with PC › **Recent syncs** lists each sync and what it changed; **Undo** puts back what that sync
  deleted or replaced, on the phone and on the PC (both on the same Wi‑Fi), and can itself be undone. A note changed
  again since gets the old version next to it as "… (before sync)". "Keep old versions" is Forever unless you pick
  30 days; "Delete history…" removes them (the PC's copies go at the next sync).
* Workspace colours, icons, folder colours and pins are merged when both sides changed them.
* Away from home the phone keeps working; changes go to the PC the next time both are on the same Wi‑Fi.

Not on the phone (yet): transcription, Save as PDF, link previews (links show as plain links), .mnpack import/export,
opening folders in place.

## Security, in short

* Each connection: ECDH (P‑256) key exchange, AES‑256‑GCM. The phone pins the PC's key at pairing.
* Pairing needs the Pair a phone window open on the PC, matching codes and a click on Allow (with a commitment, so a
  man in the middle can't force matching codes). The phone holds a 256‑bit secret; the PC stores only its SHA‑256.
* The PC answers only home-network addresses, on TCP 47830 / UDP 47831, and only while Sync with my phone is on.

## Build

* `.\build.ps1` → web UI + `MarkNotes-Android-<version>.apk` (JDK 17+, Android SDK 35; Gradle offline).
* `.\build.ps1 -Public` → the same without the Spine model player, in `..\release\`: the build to share with others
  (see the main README's Third-party code).
* Signing: `keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) and the key it names are not
  in the repository; make your own and keep it, since an update installs over the app only when signed with the same key.
* `core` is plain Java (also runs on the PC): `gradlew :core:selfTest` (note store), `devhost` runs the phone's Java side
  behind the real interface for browser tests. Protocol: [PROTOCOL.md](PROTOCOL.md).
