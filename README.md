# osu-beatmap-renderer

osu! beatmap renderer for the browser (PixiJS). Parses `.osu` files and draws hit objects with hitsounds.

## Install

```bash
npm install osu-beatmap-renderer pixi.js
```

`pixi.js` is a peer dependency (use v7 or newer).

## Build from source

```bash
npm install
npm run build
```

Built bundle: `dist/osu-beatmap-renderer.js`.

Run the demo page from a clone: `npm run dev` (uses `demo/` + `vite.demo.config.js`; not published to npm).
