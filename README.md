# YouTube Playlist

A drag-and-drop YouTube playlist player for Windows and Linux, built with Electron. Drag video URLs out of your browser to build a playlist on the fly and play it back in its own window at up to 1080p.

## Features

- Drag the URL from the browser address bar, or any YouTube link, straight into the window (pasting works too)
- Reorder the queue by dragging, click any entry to jump to it, and let it autoplay through the list; a hover button copies a video's link back out
- Create a named playlist and every video you add is saved to it automatically; the last 10 unsaved sessions are kept as well
- Play/pause/skip, volume with mute, and keyboard shortcuts (Space, N, P, arrow keys, F for fullscreen)
- Streams resolve in the background as soon as a video is added, so playback starts instantly
- Audio-only mode for music, plus downloads as m4a or mp4
- Set your own background image behind the player, shown when idle and in audio-only mode
- Updates install from inside the app: when a new release is out a button appears, one click downloads it and a restart installs it

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

For personal use. Respect YouTube's terms of service and your local laws.
