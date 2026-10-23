import { BeatmapEngine } from "../src/index.js";

const beatmapIdInput = document.getElementById("beatmapId");
const offsetInput = document.getElementById("offsetMs");
const loadBtn = document.getElementById("loadBtn");
const playBtn = document.getElementById("playBtn");
const pauseBtn = document.getElementById("pauseBtn");
const statusEl = document.getElementById("status");

let engine = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

/** Map official ppy.sh URLs to Vite dev-server proxy paths (see vite.demo.config.js). */
function toDevProxyUrl(url) {
  if (!import.meta.env.DEV) return url;
  try {
    const u = new URL(url);
    const hostMap = [
      ["osu.ppy.sh", "/__osu_proxy__"],
      ["assets.ppy.sh", "/__assets_proxy__"],
      ["a.ppy.sh", "/__a_ppy_proxy__"],
      ["b.ppy.sh", "/__b_ppy_proxy__"],
    ];
    for (const [host, prefix] of hostMap) {
      if (u.hostname === host) {
        return `${window.location.origin}${prefix}${u.pathname}${u.search}${u.hash}`;
      }
    }
  } catch {
    /* invalid */
  }
  return url;
}

/**
 * @param {string} osuText
 * @returns {number | null}
 */
function parseBeatmapSetId(osuText) {
  const m = osuText.match(/^\s*BeatmapSetID:\s*(\d+)\s*$/im);
  if (!m) return null;
  const id = Number.parseInt(m[1], 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizedBeatmapId(raw) {
  const digits = raw.replace(/\D/g, "");
  return digits.length ? digits : "";
}

function syncLoadEnabled() {
  loadBtn.disabled = !normalizedBeatmapId(beatmapIdInput.value);
}

beatmapIdInput.addEventListener("input", syncLoadEnabled);
syncLoadEnabled();

loadBtn.addEventListener("click", async () => {
  const beatmapId = normalizedBeatmapId(beatmapIdInput.value);
  if (!beatmapId) return;

  loadBtn.disabled = true;
  setStatus("Fetching .osu…");

  try {
    if (!engine) {
      const audioOffsetMs = Number(offsetInput.value) || 0;
      engine = new BeatmapEngine("renderer", { audioOffsetMs });
      await engine.init();
    }

    const osuUrl = toDevProxyUrl(`https://osu.ppy.sh/osu/${beatmapId}`);
    const osuRes = await fetch(osuUrl);
    if (!osuRes.ok) {
      throw new Error(`.osu HTTP ${osuRes.status}`);
    }
    const osuText = await osuRes.text();

    const beatmapSetId = parseBeatmapSetId(osuText);
    if (beatmapSetId == null) {
      throw new Error("Could not parse BeatmapSetID from .osu (Metadata section).");
    }

    const opts = {
      osuText,
      audioUrl: toDevProxyUrl(
        `https://b.ppy.sh/preview/${beatmapSetId}.mp3`,
      ),
      backgroundUrl: toDevProxyUrl(
        `https://assets.ppy.sh/beatmaps/${beatmapSetId}/covers/fullsize.jpg`,
      ),
    };

    setStatus(`Loading beatmap… (set ${beatmapSetId})`);
    await engine.loadBeatmap(opts);
    playBtn.disabled = false;
    pauseBtn.disabled = false;
    setStatus(`Loaded. Beatmap ID ${beatmapId}, set ${beatmapSetId}.`);
  } catch (e) {
    setStatus(String(e?.message || e));
    playBtn.disabled = true;
    pauseBtn.disabled = true;
  } finally {
    syncLoadEnabled();
  }
});

offsetInput.addEventListener("change", () => {
  engine?.setAudioOffsetMs(Number(offsetInput.value) || 0);
});

playBtn.addEventListener("click", () => {
  engine?.play();
});

pauseBtn.addEventListener("click", () => {
  engine?.pause();
});
