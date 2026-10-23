# osu-beatmap-renderer

osu! beatmap renderer for the browser (PixiJS). Parses `.osu` files and draws hit objects with hitsounds.

## Install

```bash
npm install osu-beatmap-renderer pixi.js
```

`pixi.js` is a peer dependency (use v7 or newer).

## Options

`new BeatmapEngine(container, options)`:

| Option | Default | |
|---|---|---|
| `audioOffsetMs` | global offset (`getGlobalAudioOffsetMs()`) | Audio offset in ms. |
| `audioCrossOrigin` | `"anonymous"` | `crossOrigin` of the audio element; `null` leaves it unset, for hosts that send no CORS headers (e.g. `b.ppy.sh/preview`). |
| `previewClip` | `null` (off) | The audio is a clip starting at PreviewTime (e.g. osu!'s ~10 s preview MP3). Outside the clip the audio stays paused and the map plays on silently. `{ maxDurationMs }` caps the clip length and is used until the audio's duration is known; `true` means no cap. |
| `backgroundFit` | `"cover"` | `"cover"` or `"contain"`. |
| `backgroundTint` | `0xffffff` | Tint of the background image (`0x5a5a5a` dims it like the game). |
| `assetBaseUrl` | GitHub raw `assets/` | Base URL of the bundled skin and hitsounds. |
| `baseUrl` | `""` | Prefix of the legacy token endpoints (`updateBeatmap`). |

## Playback API

- `init()`, `destroy()`
- `loadBeatmap({ osuText | osuUrl, audioUrl, backgroundUrl })`
- `play({ enableAudio, enableHitsounds })`, `pause()`, `isPlaying` (read-only)
- `getCurrentTime()`, `setCurrentTime(ms)` / `seek(ms)`, `seekToPreview()`, `getDuration()`
- `setMusicVolume(v)`, `setHitsoundVolume(v)`, `setAudioOffsetMs(ms)`
- `setBackground(url)`, `setBackgroundVisible(on)`, `resize()`
- `setRendering(on)`, `isRendering()`: stop drawing frames while hidden (pause first)
- `getPreviewClipDurationMs()`, `isTimeInPreviewClip(ms)`, `getPreviewAudioTimeMsForBeatmapTime(ms)`

Other methods and fields are internal and may change in any release.

## Build from source

```bash
npm install
npm run build
npm test
```

Built bundle: `dist/osu-beatmap-renderer.js`.

Run the demo page from a clone: `npm run dev` (uses `demo/` + `vite.demo.config.js`; not published to npm).
