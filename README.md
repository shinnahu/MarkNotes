# MarkNotes

Offline notes for Windows and Android: Markdown notes, kanban boards and canvases in workspaces, a live-preview editor,
offline transcription on the PC, and a sync that goes straight from your PC to your phone over your own Wi‑Fi. No
account, no cloud, no other company in between.

| Folder | What it is |
|---|---|
| [`src/`](src) | MarkNotes for Windows: a .NET 8 WinForms + WebView2 host and the interface (Preact + CodeMirror 6). See [src/README.md](src/README.md). |
| [`android/`](android) | MarkNotes for Android: the same interface in a WebView, with a Java port of the note store and the sync client. See [android/README.md](android/README.md). |

## Build

**Windows** (Node.js 18+, .NET 8 SDK):

```powershell
cd src
powershell -ExecutionPolicy Bypass -File build.ps1              # app → src\publish
powershell -ExecutionPolicy Bypass -File build.ps1 -Installer   # + installer\MarkNotes-Setup-<version>.exe
```

`-Installer` downloads Inno Setup from NuGet the first time.

**Android** (Node.js 18+, JDK 17+, Android SDK 35):

1. Put `sdk.dir=<path to the Android SDK>` in `android/local.properties`.
2. Make your own signing key and an `android/keystore.properties` with `storeFile`, `storePassword`, `keyAlias` and
   `keyPassword`. Neither is in this repository.
3. The first build needs internet for Gradle's downloads: run `npm install` and `node build.mjs` in `src/web`, then
   `.\gradlew.bat :app:assembleRelease` in `android/`. After that, `android\build.ps1` builds the web UI and
   `MarkNotes-Android-<version>.apk` offline.

## Phone sync and privacy

* Off until you turn on **Settings › Phone › Sync with my phone** on the PC.
* Only devices on your local network are answered; nothing goes through the internet or a server.
* A phone is paired only while **Pair a phone…** is open on the PC, both show the same 6-digit code, and you click
  **Allow**.
* Each PC makes its own key (stored encrypted for that Windows user) and each paired phone gets its own 256-bit secret,
  so a copy of MarkNotes somewhere else has no way into yours.
* Every connection is encrypted (ECDH P-256 + AES-256-GCM). Details: [android/PROTOCOL.md](android/PROTOCOL.md).

Apart from the sync, MarkNotes only goes online for the optional speech-model download, link previews and web videos
(see [src/README.md](src/README.md#network)).

## Third-party code

The Spine model player uses the Spine Runtimes, which are under the Spine Runtimes License Agreement (see
[src/README.md](src/README.md#spine-models)). Other dependencies are installed by npm, NuGet and Gradle under their own
licenses.
