#!/usr/bin/env node
/**
 * Rebuilds dist/ on every change (`vite build --watch`) and serves it on
 * http://127.0.0.1:5174/, so a page elsewhere (e.g. osu.ppy.sh with a dev
 * build of osu! Expert+) can import the local build:
 *
 *   http://127.0.0.1:5174/osu-beatmap-renderer.js
 *
 * The build keeps `pixi.js` a bare import, like the npm file, so the page's
 * import map still decides which Pixi is used. Responses allow any origin,
 * answer Chrome's local network preflight and are never cached.
 *
 * Run:  npm run serve            (PORT=… to change the port)
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 5174;

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  // Private Network Access / Local Network Access preflight from a public page.
  "Access-Control-Allow-Private-Network": "true",
  "Cache-Control": "no-store",
};

const vite = spawn("npx", ["vite", "build", "--watch"], {
  cwd: ROOT,
  stdio: "inherit",
});
vite.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    vite.kill(signal);
    process.exit(0);
  });
}

createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  const { pathname } = new URL(req.url ?? "/", `http://${HOST}`);
  const file = path.join(DIST, path.normalize(decodeURIComponent(pathname)));
  const type = TYPES[path.extname(file)];
  if (req.method !== "GET" || !file.startsWith(DIST + path.sep) || !type) {
    res.writeHead(404, CORS_HEADERS);
    res.end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": type });
    res.end(body);
  } catch {
    res.writeHead(404, CORS_HEADERS);
    res.end();
  }
  console.log(`${res.statusCode} ${req.method} ${pathname}`);
}).listen(PORT, HOST, () => {
  console.log(
    `Serving dist/ on http://${HOST}:${PORT}/osu-beatmap-renderer.js`,
  );
});
