import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.js",
      name: "OsuBeatmapRenderer",
      formats: ["es"],
      fileName: () => "osu-beatmap-renderer.js",
    },
    rollupOptions: {
      external: ["pixi.js"],
      output: {
        globals: {
          "pixi.js": "PIXI",
        },
      },
    },
    target: "es2020",
    minify: false,
  },
});
