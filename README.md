# YouTube Playlist

A drag-and-drop YouTube playlist player for Windows and Linux, built with Electron. Drag video URLs out of your browser to build a playlist on the fly and play it back in its own window at up to 1080p.

## Features

- **Drag & drop** — drag the URL from the browser address bar or any YouTube link into the window; pasting works too
- **Queue** — reorder by dragging, click to jump, autoplays through the list; copy any video's link back out with 🔗
- **Saved playlists** — create a named playlist and every video you add is saved to it automatically; reopen it anytime; the library bar folds away with «
- **Recent sessions** — the last 10 unsaved queues are kept automatically and can be restored
- **Player** — play/pause/skip, volume with mute, keyboard shortcuts (Space, N, P)
- **Instant playback** — streams resolve in the background as soon as a video is added
- **Custom background** — set your own image behind the player (shown when idle and in audio-only mode)
- **In-app updates** — when a new release is out, an update button appears; one click downloads it and a restart installs it
- Playlists and settings persist between launches

## Install

Download from the [latest release](https://github.com/MarcusMueller1/youtube-playlist/releases/latest):

| Platform | File | |
|---|---|---|
| Windows | `YouTube-Playlist-Setup.exe` | run the installer |
| Linux | `YouTube-Playlist-x.y.z.AppImage` | `chmod +x`, then run |

## Development

```
npm install
npm run setup        # Windows: fetch the stream-resolver binary
npm run setup:linux  # Linux equivalent
npm start
```

## Building

`npm run dist` (Windows) / `npm run dist:linux` (AppImage). Publishing a GitHub release builds and attaches both installers via CI.

## How it works

Each video is resolved to direct stream URLs ahead of playback. YouTube serves higher resolutions as separate video and audio streams, so the player keeps two media elements in sync to reach 1080p.

---

For personal use — respect YouTube's terms of service and your local laws.
