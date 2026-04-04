# osu-beatmap-renderer

Standalone osu! beatmap renderer powered by [PixiJS](https://pixijs.com/). Parses `.osu` files and renders hit objects (circles, sliders, spinners) with hitsound playback.

## Install

```bash
npm install osu-beatmap-renderer pixi.js
```

`pixi.js` is a peer dependency — bring your own version (>=7).

## Quick start

```js
import { BeatmapEngine } from "osu-beatmap-renderer";

// Mount into a DOM element
const container = document.getElementById("renderer");
const engine = new BeatmapEngine(container);
await engine.init();

// Load a beatmap — from URL
await engine.loadBeatmap({
  osuUrl: "https://example.com/beatmap.osu",
  audioUrl: "https://example.com/audio.mp3",
  backgroundUrl: "https://example.com/bg.jpg",
});

// Or from raw .osu text
const osuText = await fetch("/my-beatmap.osu").then((r) => r.text());
await engine.loadBeatmap({ osuText });

// Play
engine.play();
```

## API

### `new BeatmapEngine(container, options?)`

| Param | Type | Description |
|-------|------|-------------|
| `container` | `HTMLElement \| string` | DOM element or element ID to mount the canvas into |
| `options.baseUrl` | `string` | Base URL for legacy token-based endpoints (default `''`) |

### Instance methods

| Method | Description |
|--------|-------------|
| `init()` | Initialize the PixiJS application and load skin assets |
| `destroy()` | Tear down the renderer and release resources |
| `loadBeatmap({ osuText?, osuUrl?, audioUrl?, backgroundUrl? })` | Load a beatmap from raw text or URL |
| `updateBeatmap(beatmapId, imageToken?, audioToken?)` | Legacy: load via token-based endpoints |
| `play(options?)` | Start playback (`{ enableAudio, enableHitsounds }`) |
| `pause()` | Pause playback |
| `seek(ms)` | Seek to a position in milliseconds |
| `seekToPreview()` | Seek to the beatmap's preview time |
| `getCurrentTime()` | Get current playback time in ms |
| `getDuration()` | Get total duration in ms |
| `setMusicVolume(0..1)` | Set music volume |
| `setHitsoundVolume(0..1)` | Set hitsound volume |
| `setBackgroundVisible(bool)` | Show/hide background image |
| `setAudioOffsetMs(ms)` | Adjust audio offset |

### Parser

```js
import { parseOsuText, fetchAndParseOsu } from "osu-beatmap-renderer";

// Parse raw text
const beatmap = parseOsuText(rawOsuFileString);

// Fetch and parse from URL
const beatmap2 = await fetchAndParseOsu("https://example.com/beatmap.osu");
```

### Audio offset

```js
import {
  getGlobalAudioOffsetMs,
  setGlobalAudioOffsetMs,
  subscribeGlobalAudioOffset,
} from "osu-beatmap-renderer";

setGlobalAudioOffsetMs(100);
const unsubscribe = subscribeGlobalAudioOffset((ms) => console.log(ms));
```

## Browser extension usage

```bash
npm install osu-beatmap-renderer pixi.js
```

Your extension bundler (webpack, Vite, etc.) will include everything in the extension package automatically. The library is fully self-contained — skin textures and hitsound samples are bundled inline.

## Build from source

```bash
npm install
npm run build
```

Output is in `dist/`.
