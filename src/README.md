# MarkNotes 2 — source

| Folder | What it is |
|---|---|
| `host/` | Native Windows app (C# .NET 8 WinForms + Edge WebView2): window, files, workspaces, migration, import/export, file types, offline transcription (whisper.cpp via Whisper.net + NAudio) |
| `web/` | The interface (Preact + CodeMirror 6), bundled with esbuild into `web/dist` |
| `installer/` | Inno Setup script for `MarkNotes-Setup-<version>.exe` |
| `art/` | Icon sources (SVG) |

## Build

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1              # app → src\publish
powershell -ExecutionPolicy Bypass -File build.ps1 -Installer   # + installer\MarkNotes-Setup-<version>.exe
powershell -ExecutionPolicy Bypass -File build.ps1 -Deploy      # + portable copy in the folder above src (close the app first)
powershell -ExecutionPolicy Bypass -File build.ps1 -Installer -Public   # a build to share: no Spine player, setup in release\
```

Needs Node.js 18+ and the .NET 8 SDK. The version lives in `host/MarkNotes.csproj`, `installer/MarkNotes.iss` and `web/package.json`.

## Where data lives

- Notes: `Documents\MarkNotes\<Workspace>\<Folder…>\*.md|*.txt|*.canvas`, images in `<Workspace>\.assets`, workspace info
  (name, colours, picture `.workspace-icon.*`, banner `.workspace-banner.*`) in `.workspace.json`
- Folders opened in place (e.g. Obsidian vaults): nothing is written into them; their registry is
  `%APPDATA%\MarkNotes\linked-workspaces.json` and their info/picture/banner live in `%APPDATA%\MarkNotes\linked`
- Workspace Guide text, Browse Folders descriptions and on/off flags: in the workspace info (`.workspace.json`, or the
  linked meta for opened folders)
- Settings and open tabs: `%APPDATA%\MarkNotes`
- Speech models, WebView2 cache, logs, note index (`index\`), thumbnails (`thumbs\`), link previews (`linkcache\`): `%LOCALAPPDATA%\MarkNotes`
- What was picked in each Spine model embed or card (costume, pose, animation, zoom): the app state, `spine` (by note, then
  model name or card id)

## Phone sync (MarkNotes for Android)

- `android/` (next to `src/`) is the Android app: this same web UI in a WebView, with a Java port of `NoteStore` behind it
  (`android/core`). Wire protocol and sync rules: `android/PROTOCOL.md`.
- On the PC, Settings › Phone › **Sync with my phone** (setting `phoneSync`) starts `Sync/SyncServer.cs`: TCP 47830 and
  UDP discovery on 47831 (off by default). Only home-network addresses are answered. Test
  profiles (`--data-dir`) listen on 47930/47931 and on 127.0.0.1 only (add `--sync-lan` to reach them from a phone).
- Pairing: **Pair a phone…** opens pairing for as long as its window is open; the phone and the PC show the same 6-digit
  code and the PC asks Allow / Deny. Then the phone holds a 256-bit secret (the PC keeps its SHA-256 in
  `config\sync\devices.json`) and pins the PC's P-256 key (`config\sync\identity.json`, DPAPI-protected). Every
  connection is ECDH + AES-256-GCM.
- The phone runs the sync and decides; the PC lists files with hashes (cache in `%LOCALAPPDATA%\MarkNotes\sync\hashes`),
  sends them, and stores what it receives only if its copy is still the one the phone last saw. Deletions from the
  phone go to the Recycle Bin. A folder opened in place (a vault) is presented with a virtual `.workspace.json`
  (`NoteStore.Sync.cs`); its metadata stays in the config folder.
- Undo (2.5.1): before a phone's sync replaces or deletes a file, the PC keeps its version in
  `%LOCALAPPDATA%\MarkNotes\sync\history\<device>\<run>\` (`SyncFiles.Keep`); the phone's Recent syncs → Undo asks for it
  back with `restore`, and `forget` drops runs the phone deleted from its history. Settings › Phone shows how much is
  kept per phone, with "Delete old versions". Nothing is deleted by date unless the phone user picks 30 days.
- After a sync the host reloads the workspaces' metadata and sends `sync.changed`, so the window shows the new notes.

## Network

MarkNotes works offline. The only requests it makes are: the optional speech model download (Settings › Transcription),
link previews (Settings › Editor › Link previews, on by default) and web videos (Settings › Editor › Play web videos
inside MarkNotes, on by default).

- Link previews: the title and picture of a web link alone on its line or on a canvas card, fetched once from that site
  (YouTube via oEmbed, X posts via X's public embed data: author, text, pictures, video addresses) and cached; a preview
  is deleted when no note or canvas uses the link any more. Failed lookups are retried after 90 s (site unreachable) or
  a day (no preview); "Reload preview" (right-click) and "Reload link previews" (canvas top bar) fetch again.
- Web videos: pressing Play loads YouTube's privacy-mode player (youtube-nocookie.com) or the X video file
  (video.twimg.com) inside the app. Only the hosts those players need are let through (MainForm `EmbedHosts`), and
  only while the setting is on; the page sends no referrer except to the YouTube player.

## Formats shared with Obsidian

- `[[Note|alias]]` links and `![[image.png|caption]]` embeds (resolved by name, closest file wins), front matter
- Covers: front matter `banner:` / `cover:` (Simple Banner style, with `datetime:` shown as a date)
- Kanban boards: the Obsidian Kanban plugin format (`kanban-plugin: board`), written byte-for-byte like the plugin
- Canvas: JSON Canvas (`.canvas`), same layout Obsidian writes; the vault's enabled CSS snippets style the board.
  New file cards store paths from the vault root (the closest folder with `.obsidian`), like Obsidian. Snap and
  read-only states are kept in MarkNotes' state, not in the file. Arrows with a loose end (Miro-style) are saved in
  an extra `mnEdges` list that Obsidian ignores (and drops if it rewrites the file); `mnPath` (curve / straight /
  elbow), `mnPoints` (bend points), `mnWidth` (thickness) and `mnDash` (dashed / dotted) on any arrow are
  MarkNotes-only too. Shapes (R, O, the toolbar's shapes panel) are text cards with an `mnShape` key (rect, oval,
  rhombus…); Obsidian shows them as plain text cards. Ctrl+C / Ctrl+X / Ctrl+V use the system clipboard
  (format `MarkNotes.Canvas` plus text and the files of copied cards); files pasted or dropped from outside the
  workspace are copied to the attachments folder.

## Spine models

- `![[c820_00.skel]]` in a note (`![[c820_00.skel|700]]` makes it 700 px high) or a `.skel` file card on a canvas plays
  a Spine 4.1 model: the `.skel`, the `.atlas` of the same name and the textures the atlas names, in one folder. The
  player (`@esotericsoftware/spine-player` 4.1, `web/src/render/spine.js`) is loaded only when a model is shown; a
  model plays as soon as it is on screen, stops drawing off screen, and a removed embed or card gives its WebGL
  context back (past 6 players, the one off screen the longest is let go and starts again when shown). It is drawn at
  twice the screen's pixels (sizes taken from the screen, so a zoomed canvas stays sharp) on a transparent background.
- Drag moves the model, the wheel zooms at the pointer, double-click fits; the controls at the right zoom, fit and go
  fullscreen. On a canvas, dragging and the wheel move the board until the card is double-clicked (then the model;
  Esc or a click elsewhere gives them back).
- The other models of the folder make the Costume list and the pose tabs (Standing / Aim / Cover / Cut-in; a list in
  canvas cards), from Nikke file names (`c820_00`, `c820_aim_01`, `c820_cover_02`, `c820_skillcut_00`: the last two
  digits are the costume) and, when the folder has one, `fuentes.json` (`personaje`, `modelos[].modelo` / `nombre`,
  "Handy Maid - Aim" → costume "Handy Maid"). The animations come from the skeleton (`idle` first when there is one).
- Snapshot saves a PNG (transparent background), Record a WebM of the player. A `.skel` dropped or picked from outside
  the workspace is copied into its own folder with its atlas, textures and `fuentes.json`.
- License: the Spine Runtimes are under the Spine Runtimes License Agreement, shipped as
  `web/licenses/spine-runtimes-LICENSE.txt` (copied there by `build.mjs`). It allows integrating them when each user of
  the product has their own Spine Editor license (or under Section 2 of the Spine Editor License Agreement), and any
  redistribution must include that license and copyright notice.
- Builds to share leave the player out: `build.ps1 -Public` / `android\build.ps1 -Public` run `node build.mjs
  --no-spine`, which sets `__SPINE__` to false (no file matches `SPINE_RX`, so a `.skel` is a plain file: a "↪ name"
  link in notes, a file card on canvases), resolves the `@esotericsoftware` packages to an empty module and doesn't copy
  the Spine license. The GitHub releases are built that way; a normal build is unchanged.

## Save as PDF

- **Save as PDF…** is in a note's **⋯** menu and in its right-click menu in the sidebar (.md and .txt notes; kanban
  boards print as their lists). The PDF is on white paper and laid out like a printed document: cover and title,
  headings (also the PDF's bookmarks), lists, checklists, quotes, code with colours and wrapped lines, pictures with
  their caption box (at most one page high), [[links]] as text, web links you can click. Tables repeat their header row
  on each page; a table wider than the page is scaled down to fit (to half size at most) before words are broken.
  Plain .txt notes stay plain text; Obsidian comments (`%% … %%`) are left out.
- Settings › Import & export › PDF: page size (A4, Letter, Legal), orientation, margins (12 / 18 / 25 mm), text size
  (10 / 11 / 12 pt), page numbers ("1 / 3" at the bottom). The last folder used is kept in the state (`pdfDir`).
- `render/pdf.js` (loaded the first time it is used) lays the note out on a print-only element of the page
  (`@media print` hides the app) and the host prints the page through the DevTools protocol (`Page.printToPDF`, which
  works with DevTools off) into the file picked in its own dialog (`pdf.choose`, then `pdf.print`). Page margins take
  the WebView's background colour (the theme's), so the host sets a white one while printing.
- Offline: pictures come from disk and link cards only from previews already cached (`link.cached` never fetches); a
  link without a cached preview prints as a plain link.

## Developing

`MarkNotes.exe --data-dir=<folder> --web-dir=<web\dist> --debug-port=9333` runs with a separate profile,
loads the UI from disk (reload the page after `node build.mjs`) and exposes Chrome DevTools on the port.
