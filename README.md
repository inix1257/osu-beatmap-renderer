# osu-beatmap-renderer

osu! beatmap renderer for the browser (PixiJS). Parses `.osu` files and draws hit objects with hitsounds.

## Install

```bash
npm install osu-beatmap-renderer pixi.js
```

`pixi.js` is a peer dependency (use v7 or newer).

## Quick start

```js
import { BeatmapEngine } from "osu-beatmap-renderer";

const engine = new BeatmapEngine(document.getElementById("renderer"));
await engine.init();
await engine.loadBeatmap({
  osuUrl: "https://example.com/beatmap.osu",
  audioUrl: "https://example.com/audio.mp3",
  backgroundUrl: "https://example.com/bg.jpg",
});
engine.play();
```

You can pass `osuText` instead of `osuUrl` if you already have the file as a string.

## Build from source

```bash
npm install
npm run build
```

Built bundle: `dist/osu-beatmap-renderer.js`.
