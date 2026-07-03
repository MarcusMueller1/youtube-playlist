# YouTube Playlist

A personal drag-and-drop YouTube playlist player for Windows, built with Electron and yt-dlp. Drag video URLs out of your browser into the app to build a playlist on the fly — it plays them ad-free in its own window at up to 1080p.

## Features

- **Drag & drop**: drag the URL from the browser address bar (or any YouTube link) into the window; paste with Ctrl+V also works
- **Queue**: reorder by dragging, click to jump, autoplays through the list
- **Saved playlists**: name and save the current queue, reload it anytime
- **Recent sessions**: the last 10 unsaved queues are captured automatically (on close / clear / load) and can be restored
- **Player**: play/pause/skip controls, volume with mute (persisted), keyboard shortcuts (Space, N, P)
- Playlist and settings persist between launches

## How it works

yt-dlp resolves each video to direct stream URLs. YouTube only serves 360p as a single combined stream, so the app fetches separate video and audio streams (up to 1080p) and plays them through two synced media elements. The app's own Electron binary doubles as the Node.js runtime yt-dlp needs for JS challenges, so there are no external dependencies at runtime.

## Development

```
npm install
# fetch the bundled yt-dlp binary (not in git):
curl -L -o bin/yt-dlp.exe https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
npm start
```

## Building the installer

```
npm run dist
```

Produces `dist/YouTube Playlist Setup.exe` — a one-click installer with yt-dlp bundled; target machines need nothing preinstalled.

## Note

For personal use. Streams are resolved via [yt-dlp](https://github.com/yt-dlp/yt-dlp); respect YouTube's terms of service and your local laws.
