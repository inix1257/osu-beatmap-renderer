import { test } from "node:test";
import assert from "node:assert/strict";
import { clock, lastAudio } from "./fakes.js";
import { BeatmapEngine } from "../src/BeatmapEngine.js";

const PREVIEW_TIME_MS = 5000;

/**
 * An engine without init() and a loaded audio track. With `clipSec` 10 the
 * audio covers beatmap time [5000, 15000).
 * @param {object} [options]  constructor options
 * @param {{ clipSec?: number|null }} [setup]
 */
function makeEngine(options = {}, { clipSec = 10 } = {}) {
  clock.now = 1000;
  const engine = new BeatmapEngine(new HTMLElement(), {
    audioOffsetMs: 0,
    ...options,
  });
  engine.previewTimeMs = PREVIEW_TIME_MS;
  engine.updateAudioTrackFromUrl("clip.mp3");
  const audio = lastAudio();
  if (clipSec != null) audio.loadMetadata(clipSec);
  return { engine, audio };
}

const CLIP = { previewClip: { maxDurationMs: 10000 } };

// --- defaults stay 0.1.2 -----------------------------------------------------

test("audio is requested in CORS mode by default", () => {
  const { audio } = makeEngine();
  assert.equal(audio.crossOrigin, "anonymous");
  assert.equal(audio.src, "clip.mp3");
});

test("audioCrossOrigin: null leaves crossOrigin unset", () => {
  const { audio } = makeEngine({ audioCrossOrigin: null });
  assert.equal(audio.crossOriginSet, false);
  assert.equal(audio.src, "clip.mp3");
});

test("default: seeking before the audio while playing reads the clamped audio back (0.1.2)", () => {
  const { engine, audio } = makeEngine();
  engine.setCurrentTime(6000);
  engine.play({ enableHitsounds: false });
  assert.equal(audio.paused, false);
  engine.setCurrentTime(2000);
  assert.equal(engine.getCurrentTime(), PREVIEW_TIME_MS);
});

test("default: play() starts the audio even before PreviewTime (0.1.2)", () => {
  const { engine, audio } = makeEngine();
  engine.setCurrentTime(1000);
  engine.play({ enableHitsounds: false });
  assert.equal(audio.paused, false);
});

test("option defaults", () => {
  const { engine } = makeEngine({ backgroundFit: "stretch" });
  assert.equal(engine.previewClip, null);
  assert.equal(engine.backgroundFit, "cover");
  assert.equal(engine.backgroundTint, 0xffffff);
});

// --- pause -------------------------------------------------------------------

test("pause does not take a fresh sample from the audio clock", () => {
  const { engine, audio } = makeEngine();
  engine.setCurrentTime(6000);
  engine.play({ enableHitsounds: false });
  clock.now += 300;
  // An audio clock far off (would map to 14000) must not reach the snapshot.
  audio._currentTime = 9;
  engine.pause();
  assert.equal(audio.paused, true);
  assert.equal(engine.getCurrentTime(), 6300);
});

test("pause keeps the sync offset on screen, then clears it", () => {
  const { engine } = makeEngine();
  engine.setCurrentTime(6000);
  engine.play({ enableHitsounds: false });
  clock.now += 300;
  engine.audioSyncOffsetMs = 30;
  engine.lastAudioSyncSamplePerfMs = clock.now;
  const shown = engine.getCurrentTime();
  engine.pause();
  assert.equal(engine.getCurrentTime(), shown);
  assert.equal(engine.getCurrentTime(), 6330);
  assert.equal(engine.audioSyncOffsetMs, 0);
});

// --- preview clip ------------------------------------------------------------

test("clip length: the cap until the duration is known, then the shorter", () => {
  const { engine, audio } = makeEngine(CLIP, { clipSec: null });
  assert.equal(engine.getPreviewClipDurationMs(), 10000);
  audio.loadMetadata(30);
  assert.equal(engine.getPreviewClipDurationMs(), 10000);
  audio.loadMetadata(8);
  assert.equal(engine.getPreviewClipDurationMs(), 8000);
});

test("clip length without previewClip is the audio's duration", () => {
  const { engine, audio } = makeEngine({}, { clipSec: null });
  assert.equal(engine.getPreviewClipDurationMs(), Infinity);
  audio.loadMetadata(30);
  assert.equal(engine.getPreviewClipDurationMs(), 30000);
  engine.previewAudio = null;
  assert.equal(engine.getPreviewClipDurationMs(), 0);
});

test("isTimeInPreviewClip follows PreviewTime and the audio offset", () => {
  const { engine } = makeEngine(CLIP);
  assert.equal(engine.isTimeInPreviewClip(4999), false);
  assert.equal(engine.isTimeInPreviewClip(5000), true);
  assert.equal(engine.isTimeInPreviewClip(14999), true);
  assert.equal(engine.isTimeInPreviewClip(15000), false);
  engine.setAudioOffsetMs(100);
  assert.equal(engine.isTimeInPreviewClip(4900), true);
  assert.equal(engine.isTimeInPreviewClip(14900), false);
});

test("clip: seeking before PreviewTime while playing stays there", () => {
  const { engine, audio } = makeEngine(CLIP);
  engine.setCurrentTime(6000);
  engine.play({ enableHitsounds: false });
  engine.setCurrentTime(2000);
  assert.equal(engine.getCurrentTime(), 2000);
  assert.equal(audio.paused, true);
  clock.now += 250;
  assert.equal(engine.getCurrentTime(), 2250);
});

test("clip: play outside the clip keeps the audio paused and runs on the clock", () => {
  const { engine, audio } = makeEngine(CLIP);
  engine.setCurrentTime(1000);
  engine.play({ enableHitsounds: false });
  assert.equal(audio.paused, true);
  clock.now += 500;
  engine.syncPreviewClipAudio();
  assert.equal(audio.paused, true);
  assert.equal(engine.getCurrentTime(), 1500);
});

test("clip: the audio starts on entering the clip, at the right place", () => {
  const { engine, audio } = makeEngine(CLIP);
  engine.setCurrentTime(4000);
  engine.play({ enableHitsounds: false });
  clock.now += 1500;
  engine.syncPreviewClipAudio();
  assert.equal(audio.paused, false);
  assert.ok(
    Math.abs(audio.currentTime - 0.5) < 1e-9,
    String(audio.currentTime),
  );
});

test("clip: no music when play() asked for none", () => {
  const { engine, audio } = makeEngine(CLIP);
  engine.setCurrentTime(4000);
  engine.play({ enableAudio: false, enableHitsounds: false });
  clock.now += 1500;
  engine.syncPreviewClipAudio();
  assert.equal(audio.paused, true);
});

test("clip: seeking into the clip while playing starts the audio", () => {
  const { engine, audio } = makeEngine(CLIP);
  engine.setCurrentTime(1000);
  engine.play({ enableHitsounds: false });
  engine.setCurrentTime(7000);
  assert.equal(audio.paused, false);
  assert.equal(audio.currentTime, 2);
  assert.equal(engine.getCurrentTime(), 7000);
});

test("clip: leaving the clip folds the sync offset into the clock", () => {
  const { engine, audio } = makeEngine(CLIP);
  engine.setCurrentTime(14000);
  engine.play({ enableHitsounds: false });
  assert.equal(audio.paused, false);
  engine.audioSyncOffsetMs = 40;
  engine.lastAudioSyncSamplePerfMs = clock.now;
  clock.now += 2000;
  assert.equal(engine.getCurrentTime(), 16040);
  assert.equal(engine.audioSyncOffsetMs, 0);
  clock.now += 10;
  assert.equal(engine.getCurrentTime(), 16050);
  engine.syncPreviewClipAudio();
  assert.equal(audio.paused, true);
});

test("clip: pause and play again outside the clip do not jump", () => {
  const { engine, audio } = makeEngine(CLIP);
  engine.setCurrentTime(20000);
  engine.play({ enableHitsounds: false });
  clock.now += 400;
  engine.pause();
  assert.equal(engine.getCurrentTime(), 20400);
  engine.play({ enableHitsounds: false });
  assert.equal(audio.paused, true);
  clock.now += 100;
  assert.equal(engine.getCurrentTime(), 20500);
});

test("previewClip: true has no length cap", () => {
  const { engine } = makeEngine({ previewClip: true }, { clipSec: null });
  assert.deepEqual(engine.previewClip, { maxDurationMs: Infinity });
  assert.equal(engine.isTimeInPreviewClip(100000), true);
});

// --- background and rendering ------------------------------------------------

function fakeSprite(width, height) {
  return {
    texture: { width, height },
    scale: {
      set(v) {
        this.value = v;
      },
    },
    x: 0,
    y: 0,
    tint: 0xffffff,
  };
}

test("background cover (default) fills the 1280x720 canvas", () => {
  const { engine } = makeEngine();
  engine.backgroundSprite = fakeSprite(200, 100);
  engine.layoutBackground();
  const sp = engine.backgroundSprite;
  assert.equal(sp.scale.value, 7.2);
  assert.equal(sp.x, -80);
  assert.equal(sp.y, 0);
  assert.equal(sp.tint, 0xffffff);
});

test("background contain + tint", () => {
  const { engine } = makeEngine({
    backgroundFit: "contain",
    backgroundTint: 0x5a5a5a,
  });
  engine.backgroundSprite = fakeSprite(200, 100);
  engine.layoutBackground();
  const sp = engine.backgroundSprite;
  assert.equal(sp.scale.value, 6.4);
  assert.equal(sp.x, 0);
  assert.equal(sp.y, 40);
  assert.equal(sp.tint, 0x5a5a5a);
});

test("setRendering starts and stops the ticker", () => {
  const { engine } = makeEngine();
  assert.equal(engine.isRendering(), false);
  engine.setRendering(true);
  const ticker = {
    started: true,
    start() {
      this.started = true;
    },
    stop() {
      this.started = false;
    },
  };
  engine.app = { ticker };
  assert.equal(engine.isRendering(), true);
  engine.setRendering(false);
  assert.equal(ticker.started, false);
  assert.equal(engine.isRendering(), false);
  engine.setRendering(true);
  assert.equal(engine.isRendering(), true);
});
