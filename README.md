# YouTube Playlist

A personal drag-and-drop YouTube playlist player for Windows, built with Electron. Drag video URLs out of your browser into the app to build a playlist on the fly — it plays them in its own window at up to 1080p.

## Install

**Windows**: grab **YouTube Playlist Setup.exe** from the [latest release](https://github.com/MarcusMueller1/youtube-playlist/releases/latest) and run it — that's it. No prerequisites. Windows SmartScreen will warn once because the installer is unsigned: click *More info → Run anyway*.

**Linux**: grab the **.AppImage** from the same release, make it executable (`chmod +x YouTube-Playlist-*.AppImage`) and run it. No installation needed. If you get `dlopen(): error loading libfuse.so.2`, install FUSE first: `sudo apt install libfuse2` (Ubuntu 24.04+: `libfuse2t64`).

Everything below this section is only relevant if you want to work on the source code.

## Features

- **Drag & drop**: drag the URL from the browser address bar (or any YouTube link) into the window; paste with Ctrl+V also works
- **Queue**: reorder by dragging, click to jump, autoplays through the list
- **Saved playlists**: name and save the current queue, reload it anytime
- **Recent sessions**: the last 10 unsaved queues are captured automatically (on close / clear / load) and can be restored
- **Player**: play/pause/skip controls, volume with mute (persisted), keyboard shortcuts (Space, N, P)
- Playlist and settings persist between launches

## How it works

Each video is resolved to direct stream URLs. YouTube only serves 360p as a single combined stream, so the app fetches separate video and audio streams (up to 1080p) and plays them through two synced media elements.

## Development (from source)

```
npm install
npm run setup   # Windows — fetches the bundled stream-resolver binary (not in git)
npm run setup:linux   # Linux equivalent
npm start
```

## Building the installers

`npm run dist` builds the Windows installer, `npm run dist:linux` the Linux AppImage (each on its own platform). Publishing a GitHub release triggers a workflow that builds and attaches both automatically.

## Note

For personal use. Respect YouTube's terms of service and your local laws.
