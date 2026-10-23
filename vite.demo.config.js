import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Local demo (in repo on GitHub). Omitted from npm via package.json `files`. */
export default defineConfig({
  root: path.join(__dirname, "demo"),
  server: {
    fs: {
      allow: [__dirname],
    },
    // osu.ppy.sh (and related CDNs) do not send CORS headers; proxy so the browser talks to localhost only.
    proxy: {
      "/__osu_proxy__": {
        target: "https://osu.ppy.sh",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__osu_proxy__/, ""),
      },
      "/__assets_proxy__": {
        target: "https://assets.ppy.sh",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__assets_proxy__/, ""),
      },
      "/__a_ppy_proxy__": {
        target: "https://a.ppy.sh",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__a_ppy_proxy__/, ""),
      },
      "/__b_ppy_proxy__": {
        target: "https://b.ppy.sh",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__b_ppy_proxy__/, ""),
      },
    },
  },
});
