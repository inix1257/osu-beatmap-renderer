import { Application, Assets } from "pixi.js";
import * as PIXI from "pixi.js";
import { fetchAndParseOsu, parseOsuText } from "./parser.js";
import { HitsoundPlayer } from "./HitsoundPlayer.js";
import {
  bezierCurve,
  perfectCurve,
  getReverseArrowAngle,
} from "./SliderMath.js";
import {
  hitcircle as hitcircleDataUrl,
  hitcircleoverlay as hitcircleoverlayDataUrl,
  approachcircle as approachcircleDataUrl,
  reversearrow as reversearrowDataUrl,
} from "./skinAssets.js";
import {
  getFollowPosition,
  getTimingPointAt,
} from "./utils.js";

const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;
const BASE_ASPECT_RATIO = BASE_WIDTH / BASE_HEIGHT;
const LOOKBACK_MS = 10000;
const LOOKAHEAD_MS = 200;
const FADE_OUT_MS = 250;
const AUDIO_SYNC_SAMPLE_INTERVAL_MS = 200;
const SLIDER_BODY_ALPHA = 0.9;
const APPROACH_CIRCLE_Z_BASE = 1_000_000_000;
const SLIDER_BODY_DARKEN_FACTOR = 0.7;
const SLIDER_RT_OVERSAMPLE = 2;

export class BeatmapEngine {
  /**
   * @param {HTMLElement|string} container - DOM element or element ID to mount the renderer into.
   * @param {object} [options]
   * @param {string} [options.baseUrl=''] - Base URL prefix for legacy updateBeatmap/updateBeatmapBypass
   *   token-based endpoints (e.g. '' for same-origin, 'https://example.com').
   */
  constructor(container, options = {}) {
    if (typeof container === "string") {
      this.containerEl = document.getElementById(container);
      if (!this.containerEl) {
        throw new Error(`Container element not found: ${container}`);
      }
    } else if (container instanceof HTMLElement) {
      this.containerEl = container;
    } else {
      throw new Error(
        "BeatmapEngine requires an HTMLElement or element ID as first argument",
      );
    }

    this.baseUrl = options.baseUrl ?? "";

    this.app = null;
    this.textures = null;
    this.backgroundSprite = null;
    this.resizeHandler = () => this.resize();

    this.beatmap = null;
    this.hitObjectEntries = [];
    this.hitObjectTimes = [];
    this.activeHitObjects = new Set();
    this.timingPointCache = new Map();
    this.currentLayout = null;
    this.hitsoundPlayer = null;
    this.audioContext = null;
    this.musicVolume = 0.3;
    this.hitsoundVolume = 0.3;
    this.transportStartMs = 0;
    this.transportStartPerfTime = 0;
    this.transportStartAudioTime = 0;
    this.currentTime = 0;
    this.isPlaying = false;
    this.resumeOnGestureListenerAttached = false;
    this.lastTickTime = null;
    this.previewAudio = null;
    this.beatmapDurationMs = 0;
    this.previewTimeMs = 0;

    this.audioOffsetMs = 0;

    this.audioSyncOffsetMs = 0;
    this.lastAudioSyncSamplePerfMs = 0;
  }

  async init() {
    const { width, height } = this.getDisplayDimensions();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.app = new Application();
    await this.app.init({
      background: "#000000",
      width,
      height,
      antialias: true,
      resolution: dpr,
      autoDensity: true,
    });
    this.app.stage.sortableChildren = true;

    this.containerEl.innerHTML = "";
    this.containerEl.appendChild(this.app.canvas);

    this.backgroundSprite = new PIXI.Sprite();
    this.backgroundSprite.zIndex = -999999;
    this.app.stage.addChild(this.backgroundSprite);

    this.textures = await this.loadAssets();
    this.hitsoundPlayer = new HitsoundPlayer({
      hitsoundVolume: this.hitsoundVolume,
    });
    await this.hitsoundPlayer.init();
    this.audioContext = this.hitsoundPlayer.audioContext;
    window.addEventListener("resize", this.resizeHandler);
    this.app.ticker.add(() => this.updateFrame());
    this.resize();
  }

  destroy() {
    window.removeEventListener("resize", this.resizeHandler);
    this.pause();
    this.hitsoundPlayer?.destroy();
    this.hitsoundPlayer = null;

    if (this.previewAudio) {
      this.previewAudio.pause();
      this.previewAudio.src = "";
      this.previewAudio = null;
    }

    if (this.app) {
      this.app.ticker.stop();
      this.app.destroy(true, { children: true, texture: false });
      this.app = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Beatmap loading
  // ---------------------------------------------------------------------------

  /**
   * Load a beatmap from various sources.
   *
   * @param {object} params
   * @param {string} [params.osuText]       - Raw .osu file content (preferred).
   * @param {string} [params.osuUrl]        - URL to fetch the .osu file from.
   * @param {string} [params.audioUrl]      - URL for the audio track.
   * @param {string} [params.backgroundUrl] - URL for the background image.
   */
  async loadBeatmap({ osuText, osuUrl, audioUrl, backgroundUrl } = {}) {
    this.pause();
    this.setCurrentTime(0);

    if (osuText) {
      this.beatmap = parseOsuText(osuText);
    } else if (osuUrl) {
      this.beatmap = await fetchAndParseOsu(osuUrl);
    } else {
      throw new Error("Either osuText or osuUrl must be provided");
    }

    this.rebuildHitObjectCache();

    if (backgroundUrl) {
      await this.updateBackgroundFromUrl(backgroundUrl);
    }
    if (audioUrl) {
      this.updateAudioTrackFromUrl(audioUrl);
    }

    const previewTime = Number.parseInt(
      this.beatmap?.General?.PreviewTime || "0",
      10,
    );
    const safePreviewTime = Number.isFinite(previewTime)
      ? Math.max(0, previewTime)
      : 0;
    this.previewTimeMs = safePreviewTime;
    this.setCurrentTime(safePreviewTime);
  }

  /**
   * Legacy method for omqWeb: load beatmap using token-based endpoints.
   * Requires baseUrl to be set in constructor options if running cross-origin.
   */
  async updateBeatmap(
    beatmapId,
    imageToken = beatmapId,
    audioToken = beatmapId,
  ) {
    this.pause();
    this.setCurrentTime(0);
    this.beatmap = await fetchAndParseOsu(
      `${this.baseUrl}/beatmap/${beatmapId}`,
    );
    this.rebuildHitObjectCache();
    await this.updateBackgroundFromUrl(
      `${this.baseUrl}/image/${imageToken}`,
    );
    if (audioToken) {
      this.updateAudioTrackFromUrl(`${this.baseUrl}/audio/${audioToken}`);
    }
    const previewTime = Number.parseInt(
      this.beatmap?.General?.PreviewTime || "0",
      10,
    );
    const safePreviewTime = Number.isFinite(previewTime)
      ? Math.max(0, previewTime)
      : 0;
    this.previewTimeMs = safePreviewTime;
    this.setCurrentTime(safePreviewTime);
  }

  /**
   * Legacy method for omqWeb debug: load beatmap bypassing normal endpoint.
   */
  async updateBeatmapBypass(beatmapId) {
    this.pause();
    this.setCurrentTime(0);
    this.beatmap = await fetchAndParseOsu(
      `${this.baseUrl}/beatmapbp/${beatmapId}`,
    );
    this.rebuildHitObjectCache();
    const previewTime = Number.parseInt(
      this.beatmap?.General?.PreviewTime || "0",
      10,
    );
    const safePreviewTime = Number.isFinite(previewTime)
      ? Math.max(0, previewTime)
      : 0;
    this.previewTimeMs = safePreviewTime;
    this.setCurrentTime(safePreviewTime);
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------

  updateAudioTrackFromUrl(audioUrl) {
    if (this.previewAudio) {
      this.previewAudio.pause();
      this.previewAudio.src = "";
    }
    this.previewAudio = new Audio(audioUrl);
    this.previewAudio.preload = "auto";
    this.previewAudio.volume = this.musicVolume;
    this.previewAudio.crossOrigin = "anonymous";
  }

  /** @deprecated Use updateAudioTrackFromUrl */
  updateAudioTrack(audioToken) {
    this.updateAudioTrackFromUrl(`${this.baseUrl}/audio/${audioToken}`);
  }

  // ---------------------------------------------------------------------------
  // Background
  // ---------------------------------------------------------------------------

  async updateBackgroundFromUrl(imageUrl) {
    if (!this.app || !this.backgroundSprite) return;
    if (!imageUrl) {
      this.backgroundSprite.texture = PIXI.Texture.EMPTY;
      this.backgroundSprite.scale.set(1);
      this.backgroundSprite.x = 0;
      this.backgroundSprite.y = 0;
      return;
    }
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = imageUrl;
      });

      const texture = PIXI.Texture.from(img);
      this.applyLinearTextureFiltering(texture);
      const { width, height } = this.getDisplayDimensions();
      const scaleX = width / texture.width;
      const scaleY = height / texture.height;
      const scale = Math.max(scaleX, scaleY);
      this.backgroundSprite.texture = texture;
      this.backgroundSprite.scale.set(scale);
      this.backgroundSprite.x = (width - texture.width * scale) / 2;
      this.backgroundSprite.y = (height - texture.height * scale) / 2;
    } catch (_error) {
      this.backgroundSprite.texture = null;
    }
  }

  /** @deprecated Use updateBackgroundFromUrl */
  async updateBackground(imageToken) {
    await this.updateBackgroundFromUrl(
      `${this.baseUrl}/image/${imageToken}`,
    );
  }

  async setBackground(imageUrl) {
    await this.updateBackgroundFromUrl(imageUrl);
  }

  // ---------------------------------------------------------------------------
  // Playback controls
  // ---------------------------------------------------------------------------

  play(options = {}) {
    if (this.isPlaying) {
      return;
    }
    const enableMusic =
      options.enableAudio ?? options.audio ?? options.withAudio ?? true;
    const enableHitsounds = options.enableHitsounds ?? true;

    this.transportStartMs = this.currentTime;
    this.transportStartPerfTime = performance.now();
    this.transportStartAudioTime = this.audioContext
      ? this.audioContext.currentTime
      : 0;
    this.isPlaying = true;
    this.audioSyncOffsetMs = 0;
    this.lastAudioSyncSamplePerfMs = 0;
    this.lastTickTime = performance.now();
    const shouldResumeAudioContext = enableMusic || enableHitsounds;

    if (shouldResumeAudioContext && this.audioContext?.state === "suspended") {
      this.audioContext.resume().catch(() => {});

      if (!this.resumeOnGestureListenerAttached) {
        this.resumeOnGestureListenerAttached = true;
        const resumeOnGesture = () => {
          this.resumeOnGestureListenerAttached = false;
          this.audioContext?.resume().catch(() => {});
          if (enableMusic) {
            this.previewAudio?.play().catch(() => {});
          }
        };

        document.addEventListener("pointerdown", resumeOnGesture, {
          once: true,
        });
      }
    }

    if (this.previewAudio) {
      const shiftedMs = this.getPreviewAudioTimeMsForBeatmapTime(
        this.currentTime,
      );
      this.previewAudio.currentTime = Math.max(0, shiftedMs) / 1000;
      if (enableMusic) {
        this.previewAudio.play().catch(() => {});
      } else {
        this.previewAudio.pause();
      }
    }

    if (enableHitsounds) {
      this.hitsoundPlayer?.startScheduler({
        isPlaying: () => this.isPlaying,
        getTransportCurrentTimeMs: () => this.getTransportCurrentTimeMs(),
      });
    } else {
      this.hitsoundPlayer?.stopScheduler();
      this.hitsoundPlayer?.clearScheduledSources();
    }
  }

  pause() {
    if (!this.isPlaying) {
      return;
    }
    this.currentTime = this.getTransportCurrentTimeMs();
    this.isPlaying = false;
    this.hitsoundPlayer?.stopScheduler();
    this.hitsoundPlayer?.clearScheduledSources();
    if (this.previewAudio) {
      this.previewAudio.pause();
    }
  }

  getCurrentTime() {
    if (this.isPlaying) {
      return this.getTransportCurrentTimeMs();
    }
    return this.currentTime;
  }

  getDuration() {
    if (
      this.previewAudio &&
      Number.isFinite(this.previewAudio.duration) &&
      this.previewAudio.duration > 0
    ) {
      return Math.max(
        this.beatmapDurationMs,
        this.previewAudio.duration * 1000,
      );
    }
    return Math.max(0, this.beatmapDurationMs);
  }

  setCurrentTime(ms) {
    if (!Number.isFinite(ms)) {
      return;
    }
    this.currentTime = Math.max(0, ms);
    this.transportStartMs = this.currentTime;
    this.transportStartPerfTime = performance.now();
    this.transportStartAudioTime = this.audioContext
      ? this.audioContext.currentTime
      : 0;
    this.lastAudioSyncSamplePerfMs = 0;
    if (this.previewAudio) {
      const shiftedMs = this.getPreviewAudioTimeMsForBeatmapTime(
        this.currentTime,
      );
      this.previewAudio.currentTime = Math.max(0, shiftedMs) / 1000;

      if (this.isPlaying && !this.previewAudio.paused) {
        const audioDerivedVisualMs = this.getBeatmapTimeMsForPreviewAudioTime(
          this.previewAudio.currentTime * 1000,
        );
        if (Number.isFinite(audioDerivedVisualMs)) {
          this.currentTime = Math.max(0, audioDerivedVisualMs);
          this.transportStartMs = this.currentTime;
          this.transportStartPerfTime = performance.now();
          this.transportStartAudioTime = this.audioContext
            ? this.audioContext.currentTime
            : 0;
          this.audioSyncOffsetMs = 0;
          this.lastAudioSyncSamplePerfMs = 0;
        }
      }
    }
    this.resetHitsoundPlaybackFlags();
    this.hitsoundPlayer?.resetFromCurrentTime(this.currentTime);
    this.resetActiveObjects();
  }

  seek(ms) {
    this.setCurrentTime(ms);
  }

  seekToPreview() {
    this.seek(this.previewTimeMs || 0);
  }

  // ---------------------------------------------------------------------------
  // Volume
  // ---------------------------------------------------------------------------

  setVolume(volume) {
    const v = Math.max(0, Math.min(1, Number(volume) || 0));
    this.musicVolume = v;
    this.hitsoundVolume = v;
    if (this.previewAudio) {
      this.previewAudio.volume = v;
    }
    this.hitsoundPlayer?.setVolume(v);
  }

  setMusicVolume(volume) {
    const v = Math.max(0, Math.min(1, Number(volume) || 0));
    this.musicVolume = v;
    if (this.previewAudio) {
      this.previewAudio.volume = v;
    }
  }

  setHitsoundVolume(volume) {
    const v = Math.max(0, Math.min(1, Number(volume) || 0));
    this.hitsoundVolume = v;
    this.hitsoundPlayer?.setVolume(v);
  }

  setBackgroundVisible(visible) {
    if (!this.backgroundSprite) return;
    this.backgroundSprite.alpha = visible ? 1 : 0;
  }

  setAudioOffsetMs(ms) {
    const v = Number(ms) || 0;
    this.audioOffsetMs = v;

    this.audioSyncOffsetMs = 0;
    this.lastAudioSyncSamplePerfMs = 0;
    if (this.previewAudio) {
      const shiftedMs = this.getPreviewAudioTimeMsForBeatmapTime(
        this.currentTime,
      );
      this.previewAudio.currentTime = Math.max(0, shiftedMs) / 1000;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: hit object cache
  // ---------------------------------------------------------------------------

  rebuildHitObjectCache() {
    this.resetActiveObjects();
    this.timingPointCache.clear();
    if (!this.beatmap || !this.beatmap.HitObjects) {
      this.hitObjectEntries = [];
      this.hitObjectTimes = [];
      this.beatmapDurationMs = 0;
      return;
    }

    this.hitObjectEntries = Object.entries(this.beatmap.HitObjects)
      .map(([time, obj]) => [Number.parseInt(time, 10), obj])
      .filter(([time]) => Number.isFinite(time))
      .sort((a, b) => a[0] - b[0]);
    this.hitObjectTimes = this.hitObjectEntries.map(([time]) => time);
    for (const [time, hitObject] of this.hitObjectEntries) {
      this.prepareHitObject(hitObject, time);
    }
    this.beatmapDurationMs = this.computeBeatmapDurationMs();
    this.hitsoundPlayer?.buildHitsoundEvents(this.hitObjectEntries, {
      getCachedTimingPoint: (hitTime) => this.getCachedTimingPoint(hitTime),
      getSliderDurationCached: (hitObject, hitTime) =>
        this.getSliderDurationCached(hitObject, hitTime),
      getHitObjectEndTime: (hitObject, hitTime) =>
        this.getHitObjectEndTime(hitObject, hitTime),
    });
    this.hitsoundPlayer?.resetFromCurrentTime(this.currentTime);
  }

  resetActiveObjects() {
    for (const hitObject of this.activeHitObjects) {
      this.removeHitObject(hitObject);
    }
    this.activeHitObjects.clear();
  }

  resetHitsoundPlaybackFlags() {
    for (const [, hitObject] of this.hitObjectEntries) {
      hitObject._hitsoundHeadPlayed = false;
      hitObject._hitsoundSliderEndPlayed = false;
      hitObject._hitsoundSliderRepeatPlayed = {};
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: resize
  // ---------------------------------------------------------------------------

  resize() {
    if (!this.app) {
      return;
    }
    const { width, height } = this.getDisplayDimensions();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (this.app.renderer.resolution !== dpr) {
      this.app.renderer.resolution = dpr;
    }
    this.app.renderer.resize(width, height);
    if (this.backgroundSprite?.texture) {
      const scaleX = width / this.backgroundSprite.texture.width;
      const scaleY = height / this.backgroundSprite.texture.height;
      const scale = Math.max(scaleX, scaleY);
      this.backgroundSprite.scale.set(scale);
      this.backgroundSprite.x =
        (width - this.backgroundSprite.texture.width * scale) / 2;
      this.backgroundSprite.y =
        (height - this.backgroundSprite.texture.height * scale) / 2;
    }
    this.rebuildHitObjectVisualsForResize();
  }

  rebuildHitObjectVisualsForResize() {
    this.resetActiveObjects();
    if (!this.hitObjectEntries?.length) {
      return;
    }
    for (const [, hitObject] of this.hitObjectEntries) {
      this.destroyHitObjectVisuals(hitObject);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: rendering frame loop
  // ---------------------------------------------------------------------------

  updateFrame() {
    if (!this.app || !this.beatmap || !this.beatmap.HitObjects) {
      return;
    }

    this.currentTime = this.isPlaying
      ? this.getTransportCurrentTimeMs()
      : this.currentTime;

    const { preempt, fadeIn } = this.calculateARValues();
    this.currentLayout = this.getLayout();
    const rangeStart = lowerBound(
      this.hitObjectTimes,
      this.currentTime - LOOKBACK_MS,
    );
    const rangeEnd = upperBound(
      this.hitObjectTimes,
      this.currentTime + preempt + LOOKAHEAD_MS,
    );
    const nextActive = new Set();

    for (let i = rangeStart; i < rangeEnd; i++) {
      const [, hitObject] = this.hitObjectEntries[i];
      const hitTime = Number(hitObject.time);
      const timeDiff = hitTime - this.currentTime;
      const alpha = Math.min(1, Math.max(0, (preempt - timeDiff) / fadeIn));

      if (hitObject.type.includes("Spinner")) {
        const spinnerEndTime = this.getHitObjectEndTime(hitObject, hitTime);
        if (this.currentTime >= hitTime && this.currentTime <= spinnerEndTime) {
          this.addOrUpdateHitObject(hitObject, alpha, preempt, timeDiff);
          nextActive.add(hitObject);
        }
      } else if (
        timeDiff < preempt &&
        !hitObject.type.includes("Slider") &&
        timeDiff > -FADE_OUT_MS
      ) {
        this.addOrUpdateHitObject(hitObject, alpha, preempt, timeDiff);
        nextActive.add(hitObject);
      } else if (hitObject.type.includes("Slider")) {
        const sliderDuration = this.getSliderDurationCached(hitObject, hitTime);
        const sliderEndTime = hitTime + sliderDuration;
        if (
          timeDiff < preempt &&
          this.currentTime <= sliderEndTime + FADE_OUT_MS * 2
        ) {
          this.addOrUpdateHitObject(hitObject, alpha, preempt, timeDiff);
          nextActive.add(hitObject);
        }
      }
    }

    for (const hitObject of this.activeHitObjects) {
      if (!nextActive.has(hitObject)) {
        this.removeHitObject(hitObject);
      }
    }
    this.activeHitObjects = nextActive;
  }

  addOrUpdateHitObject(hitObject, alpha, preempt, timeDiff) {
    const { centerX, centerY, gridUnit, topLeftX, topLeftY } =
      this.currentLayout || this.getLayout();
    const hitTime = Number(hitObject.time);
    const zIndex = -hitTime;
    const approachZIndex = APPROACH_CIRCLE_Z_BASE - hitTime;

    if (hitObject.type.includes("Spinner")) {
      if (!hitObject.approachSprite) {
        const approachSprite = new PIXI.Sprite(this.textures.texture_approach);
        approachSprite.anchor.set(0.5);
        approachSprite.x = centerX;
        approachSprite.y = centerY;
        approachSprite.width = gridUnit * 512;
        approachSprite.height = gridUnit * 512;
        approachSprite.zIndex = approachZIndex;
        this.app.stage.addChild(approachSprite);
        hitObject.approachSprite = approachSprite;
      }
      const spinnerEndTime = this.getHitObjectEndTime(hitObject, hitTime);
      const spinnerDuration = Math.max(1, spinnerEndTime - hitTime);
      const progress = Math.max(
        0,
        Math.min(1, (this.currentTime - hitTime) / spinnerDuration),
      );
      const spinnerScale = 1 - progress;
      const spinnerBaseSize = gridUnit * 512;
      this.showHitObject(hitObject);
      hitObject.approachSprite.alpha = 1;
      hitObject.approachSprite.width = spinnerBaseSize * spinnerScale;
      hitObject.approachSprite.height = spinnerBaseSize * spinnerScale;
      return;
    }

    if (!hitObject.hitCircleSprite) {
      const posX = topLeftX + Number(hitObject.x) * gridUnit;
      const posY = topLeftY + Number(hitObject.y) * gridUnit;
      const circleSize = this.getCircleSize(gridUnit);
      const comboColor = this.getComboColor(hitObject.comboColor);

      hitObject.hitCircleSprite = new PIXI.Sprite(
        this.textures.texture_hitcircle,
      );
      hitObject.hitCircleSprite.anchor.set(0.5);
      hitObject.hitCircleSprite.x = posX;
      hitObject.hitCircleSprite.y = posY;
      hitObject.hitCircleSprite.width = circleSize;
      hitObject.hitCircleSprite.height = circleSize;
      hitObject.hitCircleSprite.tint = comboColor;
      hitObject.hitCircleSprite.zIndex = zIndex + 3;

      hitObject.hitCircleOverlaySprite = new PIXI.Sprite(
        this.textures.texture_hitcircleoverlay,
      );
      hitObject.hitCircleOverlaySprite.anchor.set(0.5);
      hitObject.hitCircleOverlaySprite.x = posX;
      hitObject.hitCircleOverlaySprite.y = posY;
      hitObject.hitCircleOverlaySprite.width = circleSize;
      hitObject.hitCircleOverlaySprite.height = circleSize;
      hitObject.hitCircleOverlaySprite.zIndex = zIndex + 4;

      hitObject.approachSprite = new PIXI.Sprite(
        this.textures.texture_approach,
      );
      hitObject.approachSprite.anchor.set(0.5);
      hitObject.approachSprite.x = posX;
      hitObject.approachSprite.y = posY;
      hitObject.approachSprite.tint = comboColor;
      hitObject.approachSprite.zIndex = approachZIndex;

      hitObject.comboText = new PIXI.Text({
        text: hitObject.combo || "",
        style: {
          fill: 0xffffff,
        },
      });
      hitObject.comboText.anchor.set(0.5);
      hitObject.comboText.x = posX;
      hitObject.comboText.y = posY;
      hitObject.comboText.zIndex = zIndex + 6;
      const textScale =
        Math.min(
          circleSize / (hitObject.comboText.width || 1),
          circleSize / (hitObject.comboText.height || 1),
        ) * 0.4;
      hitObject.comboText.scale.set(textScale);
      hitObject._comboBaseScale = textScale;

      this.app.stage.addChild(hitObject.approachSprite);
      this.app.stage.addChild(hitObject.hitCircleSprite);
      this.app.stage.addChild(hitObject.hitCircleOverlaySprite);
      this.app.stage.addChild(hitObject.comboText);

      if (hitObject.type.includes("Slider")) {
        this.addSlider(hitObject, posX, posY, circleSize, zIndex, comboColor);
      }
    }

    this.showHitObject(hitObject);

    const scale = 0.9 + (timeDiff / preempt) * 3;
    if (hitObject.approachSprite) {
      if (scale > 1) {
        hitObject.approachSprite.width =
          hitObject.hitCircleSprite.width * scale;
        hitObject.approachSprite.height =
          hitObject.hitCircleSprite.height * scale;
        hitObject.approachSprite.alpha = Math.max(0, Math.min(1, alpha));
      } else {
        hitObject.approachSprite.alpha = 0;
      }
    }

    if (hitObject.hitCircleSprite && !hitObject.type.includes("Slider")) {
      const circleSize = this.getCircleSize(gridUnit);
      if (timeDiff <= 0) {
        const fadeProgress = this.getHitBurstProgress(timeDiff);
        const fadeAlpha = this.getHitBurstAlpha(fadeProgress);
        hitObject.hitCircleSprite.alpha = fadeAlpha;
        hitObject.hitCircleOverlaySprite.alpha = fadeAlpha;
        hitObject.comboText.alpha = fadeAlpha;
        const grownSize = this.getHitBurstSize(circleSize, fadeProgress);
        const comboScale = this.getHitBurstScale(
          hitObject._comboBaseScale,
          fadeProgress,
        );
        hitObject.hitCircleSprite.width = grownSize;
        hitObject.hitCircleSprite.height = grownSize;
        hitObject.hitCircleOverlaySprite.width = grownSize;
        hitObject.hitCircleOverlaySprite.height = grownSize;
        hitObject.comboText.scale.set(comboScale);
      } else {
        hitObject.hitCircleSprite.width = circleSize;
        hitObject.hitCircleSprite.height = circleSize;
        hitObject.hitCircleOverlaySprite.width = circleSize;
        hitObject.hitCircleOverlaySprite.height = circleSize;
        hitObject.hitCircleSprite.alpha = Math.max(0, Math.min(1, alpha));
        hitObject.hitCircleOverlaySprite.alpha = Math.max(
          0,
          Math.min(1, alpha),
        );
        hitObject.comboText.alpha = Math.max(0, Math.min(1, alpha));
        hitObject.comboText.scale.set(hitObject._comboBaseScale || 1);
      }
    }
    if (hitObject.sliderSprite) {
      const hitTimeMs = Number(hitObject.time);
      const sliderDuration = this.getSliderDurationCached(hitObject, hitTimeMs);
      const sliderEndTime = hitTimeMs + sliderDuration;
      const sliderRepeat = Number(hitObject.sliderInfo?.sliderRepeat || 1);
      const isPreHit = this.currentTime < hitTimeMs;
      const inPostSliderFade =
        sliderDuration > 0 && this.currentTime > sliderEndTime;
      const sliderAlpha = isPreHit ? Math.max(0.02, Math.min(1, alpha)) : 1;
      const { gridUnit: sliderGridUnit } =
        this.currentLayout || this.getLayout();
      const sliderHeadBaseSize = this.getCircleSize(sliderGridUnit);

      if (inPostSliderFade) {
        const fadeProgress = Math.min(
          1,
          (this.currentTime - sliderEndTime) / FADE_OUT_MS,
        );
        const fadeAlpha = Math.max(0, 1 - fadeProgress);
        hitObject.sliderSprite.alpha = fadeAlpha;
        hitObject.hitCircleSprite_sliderend.alpha = fadeAlpha;
        hitObject.hitCircleOverlaySprite_sliderend.alpha = fadeAlpha;
        if (hitObject.reverseSprite) {
          hitObject.reverseSprite.visible =
            this.hasRemainingSliderRepeatsAtEdge(
              this.currentTime,
              hitTimeMs,
              sliderDuration,
              sliderRepeat,
              "end",
            );
          hitObject.reverseSprite.alpha = fadeAlpha;
        }
        if (hitObject.reverseSpriteHead) {
          hitObject.reverseSpriteHead.visible =
            this.currentTime >= hitTimeMs &&
            this.hasRemainingSliderRepeatsAtEdge(
              this.currentTime,
              hitTimeMs,
              sliderDuration,
              sliderRepeat,
              "start",
            );
          hitObject.reverseSpriteHead.alpha = fadeAlpha;
        }
        if (hitObject.followCircle) {
          hitObject.followCircle.alpha = fadeAlpha * 0.7;
        }
      } else {
        hitObject.sliderSprite.alpha = sliderAlpha;
        hitObject.hitCircleSprite_sliderend.alpha = sliderAlpha;
        hitObject.hitCircleOverlaySprite_sliderend.alpha = sliderAlpha;
        if (hitObject.reverseSprite) {
          hitObject.reverseSprite.visible =
            this.hasRemainingSliderRepeatsAtEdge(
              this.currentTime,
              hitTimeMs,
              sliderDuration,
              sliderRepeat,
              "end",
            );
          hitObject.reverseSprite.alpha = sliderAlpha;
        }
        if (hitObject.reverseSpriteHead) {
          hitObject.reverseSpriteHead.visible =
            this.currentTime >= hitTimeMs &&
            this.hasRemainingSliderRepeatsAtEdge(
              this.currentTime,
              hitTimeMs,
              sliderDuration,
              sliderRepeat,
              "start",
            );
          hitObject.reverseSpriteHead.alpha = sliderAlpha;
        }
      }

      if (timeDiff <= 0 && -timeDiff <= FADE_OUT_MS) {
        const headFadeProgress = this.getHitBurstProgress(timeDiff);
        const headFadeAlpha = this.getHitBurstAlpha(headFadeProgress);
        const grownSize = this.getHitBurstSize(
          sliderHeadBaseSize,
          headFadeProgress,
        );
        const comboScale = this.getHitBurstScale(
          hitObject._comboBaseScale,
          headFadeProgress,
        );
        hitObject.hitCircleSprite.alpha = headFadeAlpha;
        hitObject.hitCircleOverlaySprite.alpha = headFadeAlpha;
        hitObject.comboText.alpha = headFadeAlpha;
        hitObject.hitCircleSprite.width = grownSize;
        hitObject.hitCircleSprite.height = grownSize;
        hitObject.hitCircleOverlaySprite.width = grownSize;
        hitObject.hitCircleOverlaySprite.height = grownSize;
        hitObject.comboText.scale.set(comboScale);
      } else if (timeDiff <= 0) {
        hitObject.hitCircleSprite.width = sliderHeadBaseSize;
        hitObject.hitCircleSprite.height = sliderHeadBaseSize;
        hitObject.hitCircleOverlaySprite.width = sliderHeadBaseSize;
        hitObject.hitCircleOverlaySprite.height = sliderHeadBaseSize;
        hitObject.hitCircleSprite.alpha = 0;
        hitObject.hitCircleOverlaySprite.alpha = 0;
        hitObject.comboText.alpha = 0;
        hitObject.comboText.scale.set(hitObject._comboBaseScale || 1);
      } else {
        hitObject.hitCircleSprite.width = sliderHeadBaseSize;
        hitObject.hitCircleSprite.height = sliderHeadBaseSize;
        hitObject.hitCircleOverlaySprite.width = sliderHeadBaseSize;
        hitObject.hitCircleOverlaySprite.height = sliderHeadBaseSize;
        hitObject.hitCircleSprite.alpha = sliderAlpha;
        hitObject.hitCircleOverlaySprite.alpha = sliderAlpha;
        hitObject.comboText.alpha = sliderAlpha;
        hitObject.comboText.scale.set(hitObject._comboBaseScale || 1);
      }

      this.updateSliderFollowCircle(hitObject, hitTime, timeDiff);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: slider follow circle & repeat bursts
  // ---------------------------------------------------------------------------

  updateSliderFollowCircle(hitObject, hitTime, timeDiff) {
    if (!hitObject.followCircle || !hitObject.sliderInfo || timeDiff > 0) {
      if (hitObject.followCircle) {
        hitObject.followCircle.alpha = 0;
      }
      return;
    }

    const timingPoint = this.getCachedTimingPoint(hitTime);
    if (!timingPoint?.closestBPM) {
      hitObject.followCircle.alpha = 0;
      return;
    }

    const sliderDuration = this.getSliderDurationCached(hitObject, hitTime);

    if (!Number.isFinite(sliderDuration) || sliderDuration <= 0) {
      hitObject.followCircle.alpha = 0;
      return;
    }

    const sliderRepeat = Number(hitObject.sliderInfo.sliderRepeat || 1);
    const sliderLength = Number(hitObject.sliderInfo.sliderLength || 0);
    hitObject.sliderRepeat = sliderRepeat;
    hitObject.sliderLength = sliderLength;
    hitObject.sliderDuration = sliderDuration;

    if (this.currentTime > hitTime + sliderDuration) {
      hitObject.followCircle.alpha = 0;
      this.updateSliderRepeatBursts(
        hitObject,
        hitTime,
        sliderDuration,
        sliderRepeat,
      );
      return;
    }

    const { gridUnit } = this.currentLayout || this.getLayout();
    const followPosition = getFollowPosition(
      hitObject,
      hitTime,
      this.currentTime,
      gridUnit,
    );
    if (
      followPosition &&
      Number.isFinite(followPosition.x) &&
      Number.isFinite(followPosition.y)
    ) {
      hitObject.followCircle.x = followPosition.x;
      hitObject.followCircle.y = followPosition.y;
    }
    hitObject.followCircle.alpha = 0.7;

    this.updateSliderRepeatBursts(
      hitObject,
      hitTime,
      sliderDuration,
      sliderRepeat,
    );
  }

  hasRemainingSliderRepeatsAtEdge(
    currentTime,
    hitTime,
    sliderDuration,
    sliderRepeat,
    edgeType,
  ) {
    if (
      !Number.isFinite(currentTime) ||
      !Number.isFinite(hitTime) ||
      !Number.isFinite(sliderDuration) ||
      sliderDuration <= 0 ||
      !Number.isFinite(sliderRepeat) ||
      sliderRepeat <= 1
    ) {
      return false;
    }

    const spanDuration = sliderDuration / sliderRepeat;
    if (!Number.isFinite(spanDuration) || spanDuration <= 0) {
      return false;
    }

    for (let repeatIndex = 1; repeatIndex < sliderRepeat; repeatIndex += 1) {
      const repeatTime = hitTime + spanDuration * repeatIndex;
      if (repeatTime <= currentTime) {
        continue;
      }
      const repeatEdge = repeatIndex % 2 === 1 ? "end" : "start";
      if (repeatEdge === edgeType) {
        return true;
      }
    }

    return false;
  }

  updateSliderRepeatBursts(hitObject, hitTime, sliderDuration, sliderRepeat) {
    if (!Number.isFinite(sliderDuration) || sliderDuration <= 0) {
      this.cleanupSliderRepeatBursts(hitObject);
      return;
    }

    if (!hitObject._repeatBurstMap) {
      hitObject._repeatBurstMap = {};
    }
    if (!hitObject._repeatBurstTriggered) {
      hitObject._repeatBurstTriggered = {};
    }

    const spanDuration = sliderDuration / sliderRepeat;
    if (!Number.isFinite(spanDuration) || spanDuration <= 0) {
      this.cleanupSliderRepeatBursts(hitObject);
      return;
    }

    const { gridUnit } = this.currentLayout || this.getLayout();
    const circleBaseSize = this.getCircleSize(gridUnit);
    const baseArrowSize = this.getCircleSize(gridUnit) * 0.6;

    if (sliderRepeat > 1) {
      for (let repeatIndex = 1; repeatIndex < sliderRepeat; repeatIndex += 1) {
        const repeatTime = hitTime + spanDuration * repeatIndex;
        if (this.currentTime < repeatTime) {
          continue;
        }

        if (
          !hitObject._repeatBurstMap[repeatIndex] &&
          !hitObject._repeatBurstTriggered[repeatIndex]
        ) {
          const burstEffect = this.createSliderEdgeBurstEffect(
            hitObject,
            repeatIndex % 2 === 1 ? "end" : "start",
            true,
            circleBaseSize,
            baseArrowSize,
          );
          if (burstEffect) {
            hitObject._repeatBurstMap[repeatIndex] = {
              effect: burstEffect,
              startedAtMs: this.currentTime,
            };
            hitObject._repeatBurstTriggered[repeatIndex] = true;
          }
        }
      }
    }

    const sliderEndTime = hitTime + sliderDuration;
    if (
      this.currentTime >= sliderEndTime &&
      !hitObject._repeatBurstMap.end &&
      !hitObject._repeatBurstTriggered.end
    ) {
      const endEffect = this.createSliderEdgeBurstEffect(
        hitObject,
        sliderRepeat % 2 === 1 ? "end" : "start",
        false,
        circleBaseSize,
        baseArrowSize,
      );
      if (endEffect) {
        hitObject._repeatBurstMap.end = {
          effect: endEffect,
          startedAtMs: this.currentTime,
        };
        hitObject._repeatBurstTriggered.end = true;
      }
    }

    for (const [repeatKey, burstState] of Object.entries(
      hitObject._repeatBurstMap,
    )) {
      const burstEffect = burstState?.effect;
      if (!burstEffect) {
        delete hitObject._repeatBurstMap[repeatKey];
        continue;
      }
      const burstProgress =
        (this.currentTime -
          (Number(burstState.startedAtMs) || this.currentTime)) /
        FADE_OUT_MS;
      if (burstProgress < 0) continue;
      if (burstProgress > 1) {
        this.destroySliderBurstEffect(burstEffect);
        delete hitObject._repeatBurstMap[repeatKey];
        continue;
      }

      const alpha = this.getHitBurstAlpha(burstProgress);
      const circleSize = this.getHitBurstSize(
        Number(burstEffect.baseCircleSize) || circleBaseSize,
        burstProgress,
      );
      burstEffect.hitCircle.alpha = alpha;
      burstEffect.hitCircle.width = circleSize;
      burstEffect.hitCircle.height = circleSize;
      burstEffect.hitCircleOverlay.alpha = alpha;
      burstEffect.hitCircleOverlay.width = circleSize;
      burstEffect.hitCircleOverlay.height = circleSize;

      if (burstEffect.arrowSprite) {
        const arrowSize = this.getHitBurstSize(
          Number(burstEffect.baseArrowSize) || baseArrowSize,
          burstProgress,
        );
        burstEffect.arrowSprite.alpha = alpha;
        burstEffect.arrowSprite.width = arrowSize;
        burstEffect.arrowSprite.height = arrowSize;
      }
    }
  }

  createSliderEdgeBurstEffect(
    hitObject,
    edgeType,
    includeArrow,
    baseCircleSize,
    baseArrowSize,
  ) {
    const sliderInfo = hitObject.sliderInfo;
    const anchorPositions = sliderInfo?.anchorPositions || [];
    if (
      !sliderInfo ||
      !Array.isArray(anchorPositions) ||
      anchorPositions.length < 2
    ) {
      return null;
    }

    const effectContainer = new PIXI.Container();
    effectContainer.zIndex = Number.isFinite(hitObject.hitCircleSprite?.zIndex)
      ? hitObject.hitCircleSprite.zIndex + 10
      : 0;

    const hitCircle = new PIXI.Sprite(this.textures.texture_hitcircle);
    hitCircle.anchor.set(0.5);
    hitCircle.width = baseCircleSize;
    hitCircle.height = baseCircleSize;
    hitCircle.tint = hitObject.hitCircleSprite?.tint ?? 0xffffff;

    const hitCircleOverlay = new PIXI.Sprite(
      this.textures.texture_hitcircleoverlay,
    );
    hitCircleOverlay.anchor.set(0.5);
    hitCircleOverlay.width = baseCircleSize;
    hitCircleOverlay.height = baseCircleSize;

    effectContainer.addChild(hitCircle);
    effectContainer.addChild(hitCircleOverlay);

    let x = 0;
    let y = 0;
    let rotation = 0;
    if (edgeType === "end") {
      x = sliderInfo.sliderEndPos?.x ?? hitObject.hitCircleSprite?.x ?? 0;
      y = sliderInfo.sliderEndPos?.y ?? hitObject.hitCircleSprite?.y ?? 0;
      rotation = getReverseArrowAngle(sliderInfo);
    } else {
      x = hitObject.hitCircleSprite?.x ?? anchorPositions[0].x;
      y = hitObject.hitCircleSprite?.y ?? anchorPositions[0].y;
      const first = anchorPositions[0];
      const second = anchorPositions[1];
      rotation = Math.atan2(second.y - first.y, second.x - first.x);
    }

    hitCircle.x = x;
    hitCircle.y = y;
    hitCircleOverlay.x = x;
    hitCircleOverlay.y = y;

    let arrowSprite = null;
    if (includeArrow) {
      arrowSprite = new PIXI.Sprite(this.textures.texture_reverse);
      arrowSprite.anchor.set(0.5);
      arrowSprite.width = baseArrowSize;
      arrowSprite.height = baseArrowSize;
      arrowSprite.x = x;
      arrowSprite.y = y;
      arrowSprite.rotation = rotation;
      effectContainer.addChild(arrowSprite);
    }

    this.app.stage.addChild(effectContainer);
    return {
      container: effectContainer,
      hitCircle,
      hitCircleOverlay,
      arrowSprite,
      baseCircleSize,
      baseArrowSize: includeArrow ? baseArrowSize : 0,
    };
  }

  destroySliderBurstEffect(effect) {
    if (!effect?.container) {
      return;
    }
    this.app.stage.removeChild(effect.container);
    if (typeof effect.container.destroy === "function") {
      effect.container.destroy({ children: true });
    }
  }

  cleanupSliderRepeatBursts(hitObject) {
    if (!hitObject?._repeatBurstMap) {
      return;
    }
    for (const burstEntry of Object.values(hitObject._repeatBurstMap)) {
      const burstEffect = burstEntry?.effect;
      if (!burstEffect) {
        continue;
      }
      this.destroySliderBurstEffect(burstEffect);
    }
    hitObject._repeatBurstMap = {};
    hitObject._repeatBurstTriggered = {};
  }

  // ---------------------------------------------------------------------------
  // Internal: slider creation
  // ---------------------------------------------------------------------------

  addSlider(hitObject, posX, posY, circleSize, zIndex, comboColor) {
    const sliderInfo = hitObject.sliderInfo;
    const sliderBodyPath =
      sliderInfo.sliderType === "P"
        ? perfectCurve(sliderInfo, this.currentLayout || this.getLayout())
        : bezierCurve(sliderInfo, this.currentLayout || this.getLayout());
    const sliderBorderPath =
      sliderInfo.sliderType === "P"
        ? perfectCurve(sliderInfo, this.currentLayout || this.getLayout())
        : bezierCurve(sliderInfo, this.currentLayout || this.getLayout());

    const sliderBorderWidth = circleSize * 0.92;
    const sliderBodyWidth = sliderBorderWidth * 0.88;

    sliderBorderPath.stroke({
      width: sliderBorderWidth,
      color: 0xffffff,
      join: "round",
      cap: "round",
    });
    sliderBodyPath.stroke({
      width: sliderBodyWidth,
      color: darkenColor(comboColor, SLIDER_BODY_DARKEN_FACTOR),
      join: "round",
      cap: "round",
    });

    const bounds = sliderBodyPath.getLocalBounds();
    const padding = Math.ceil(circleSize * 0.75);
    const texW = Math.max(1, Math.ceil(bounds.width + padding * 2));
    const texH = Math.max(1, Math.ceil(bounds.height + padding * 2));
    const renderResolution =
      Math.max(1, this.app?.renderer?.resolution || 1) * SLIDER_RT_OVERSAMPLE;
    const multisample = PIXI.MSAA_QUALITY?.HIGH;
    const sliderBodyTexture = PIXI.RenderTexture.create({
      width: texW,
      height: texH,
      resolution: renderResolution,
      multisample,
    });
    const sliderBorderTexture = PIXI.RenderTexture.create({
      width: texW,
      height: texH,
      resolution: renderResolution,
      multisample,
    });

    sliderBodyPath.x = padding - bounds.x;
    sliderBodyPath.y = padding - bounds.y;
    sliderBorderPath.x = padding - bounds.x;
    sliderBorderPath.y = padding - bounds.y;

    const bodyRenderContainer = new PIXI.Container();
    bodyRenderContainer.addChild(sliderBodyPath);
    this.app.renderer.render({
      container: bodyRenderContainer,
      target: sliderBodyTexture,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    bodyRenderContainer.removeChild(sliderBodyPath);
    bodyRenderContainer.destroy({ children: false });

    const borderRenderContainer = new PIXI.Container();
    borderRenderContainer.addChild(sliderBorderPath);
    this.app.renderer.render({
      container: borderRenderContainer,
      target: sliderBorderTexture,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    borderRenderContainer.removeChild(sliderBorderPath);
    borderRenderContainer.destroy({ children: false });

    const sliderBorderSprite = new PIXI.Sprite(sliderBorderTexture);
    sliderBorderSprite.x = 0;
    sliderBorderSprite.y = 0;

    const sliderBodySprite = new PIXI.Sprite(sliderBodyTexture);
    sliderBodySprite.x = 0;
    sliderBodySprite.y = 0;
    sliderBodySprite.alpha = SLIDER_BODY_ALPHA;

    const sliderSprite = new PIXI.Container();
    sliderSprite.sortableChildren = false;
    sliderSprite.x = bounds.x - padding;
    sliderSprite.y = bounds.y - padding;
    sliderSprite.zIndex = zIndex + 1;
    sliderSprite.addChild(sliderBorderSprite);
    sliderSprite.addChild(sliderBodySprite);

    this.app.stage.addChild(sliderSprite);
    hitObject.sliderBorderSprite = null;
    hitObject.sliderSprite = sliderSprite;

    hitObject.hitCircleSprite_sliderend = new PIXI.Sprite(
      this.textures.texture_hitcircle,
    );
    hitObject.hitCircleSprite_sliderend.anchor.set(0.5);
    hitObject.hitCircleSprite_sliderend.x = sliderInfo.sliderEndPos.x;
    hitObject.hitCircleSprite_sliderend.y = sliderInfo.sliderEndPos.y;
    hitObject.hitCircleSprite_sliderend.width = circleSize;
    hitObject.hitCircleSprite_sliderend.height = circleSize;
    hitObject.hitCircleSprite_sliderend.tint = comboColor;
    hitObject.hitCircleSprite_sliderend.zIndex = zIndex + 2;

    hitObject.hitCircleOverlaySprite_sliderend = new PIXI.Sprite(
      this.textures.texture_hitcircleoverlay,
    );
    hitObject.hitCircleOverlaySprite_sliderend.anchor.set(0.5);
    hitObject.hitCircleOverlaySprite_sliderend.x = sliderInfo.sliderEndPos.x;
    hitObject.hitCircleOverlaySprite_sliderend.y = sliderInfo.sliderEndPos.y;
    hitObject.hitCircleOverlaySprite_sliderend.width = circleSize;
    hitObject.hitCircleOverlaySprite_sliderend.height = circleSize;
    hitObject.hitCircleOverlaySprite_sliderend.zIndex = zIndex + 2;
    this.app.stage.addChild(hitObject.hitCircleSprite_sliderend);
    this.app.stage.addChild(hitObject.hitCircleOverlaySprite_sliderend);

    if (Number(sliderInfo.sliderRepeat) > 1) {
      const reverseSprite = new PIXI.Sprite(this.textures.texture_reverse);
      reverseSprite.anchor.set(0.5);
      reverseSprite.x = sliderInfo.sliderEndPos.x;
      reverseSprite.y = sliderInfo.sliderEndPos.y;
      reverseSprite.width = circleSize * 0.6;
      reverseSprite.height = circleSize * 0.6;
      reverseSprite.rotation = getReverseArrowAngle(sliderInfo);
      reverseSprite.zIndex = zIndex + 2;
      this.app.stage.addChild(reverseSprite);
      hitObject.reverseSprite = reverseSprite;
    }

    if (Number(sliderInfo.sliderRepeat) > 2) {
      const reverseSpriteHead = new PIXI.Sprite(this.textures.texture_reverse);
      reverseSpriteHead.anchor.set(0.5);
      reverseSpriteHead.x = posX;
      reverseSpriteHead.y = posY;
      reverseSpriteHead.width = circleSize * 0.6;
      reverseSpriteHead.height = circleSize * 0.6;
      const anchorPositions = sliderInfo.anchorPositions || [];
      if (anchorPositions.length >= 2) {
        const first = anchorPositions[0];
        const second = anchorPositions[1];
        reverseSpriteHead.rotation = Math.atan2(
          second.y - first.y,
          second.x - first.x,
        );
      } else {
        reverseSpriteHead.rotation = 0;
      }
      reverseSpriteHead.zIndex = zIndex + 2;
      reverseSpriteHead.visible = false;
      this.app.stage.addChild(reverseSpriteHead);
      hitObject.reverseSpriteHead = reverseSpriteHead;
    }

    const followCircle = new PIXI.Graphics();
    followCircle.beginFill(0xeeeeee);
    followCircle.drawCircle(0, 0, circleSize / 2.4);
    followCircle.endFill();
    followCircle.x = posX;
    followCircle.y = posY;
    followCircle.alpha = 0;
    followCircle.zIndex = zIndex + 2;
    this.app.stage.addChild(followCircle);
    hitObject.followCircle = followCircle;
  }

  // ---------------------------------------------------------------------------
  // Internal: display object helpers
  // ---------------------------------------------------------------------------

  destroyDisplayObject(displayObject) {
    if (!displayObject) {
      return;
    }
    if (displayObject.parent) {
      displayObject.parent.removeChild(displayObject);
    }
    if (typeof displayObject.destroy === "function") {
      displayObject.destroy({ children: true });
    }
  }

  destroyHitObjectVisuals(hitObject) {
    if (!hitObject) {
      return;
    }
    this.cleanupSliderRepeatBursts(hitObject);

    this.destroyDisplayObject(hitObject.approachSprite);
    this.destroyDisplayObject(hitObject.hitCircleSprite);
    this.destroyDisplayObject(hitObject.hitCircleOverlaySprite);
    this.destroyDisplayObject(hitObject.comboText);
    this.destroyDisplayObject(hitObject.sliderSprite);
    this.destroyDisplayObject(hitObject.sliderBorderSprite);
    this.destroyDisplayObject(hitObject.hitCircleSprite_sliderend);
    this.destroyDisplayObject(hitObject.hitCircleOverlaySprite_sliderend);
    this.destroyDisplayObject(hitObject.reverseSprite);
    this.destroyDisplayObject(hitObject.reverseSpriteHead);
    this.destroyDisplayObject(hitObject.followCircle);

    hitObject.approachSprite = null;
    hitObject.hitCircleSprite = null;
    hitObject.hitCircleOverlaySprite = null;
    hitObject.comboText = null;
    hitObject.sliderSprite = null;
    hitObject.sliderBorderSprite = null;
    hitObject.hitCircleSprite_sliderend = null;
    hitObject.hitCircleOverlaySprite_sliderend = null;
    hitObject.reverseSprite = null;
    hitObject.reverseSpriteHead = null;
    hitObject.followCircle = null;
  }

  removeHitObject(hitObject) {
    if (!this.app) {
      return;
    }
    this.cleanupSliderRepeatBursts(hitObject);
    this.hideHitObject(hitObject);
  }

  showHitObject(hitObject) {
    if (hitObject.hitCircleSprite) hitObject.hitCircleSprite.visible = true;
    if (hitObject.approachSprite) hitObject.approachSprite.visible = true;
    if (hitObject.hitCircleOverlaySprite)
      hitObject.hitCircleOverlaySprite.visible = true;
    if (hitObject.reverseSprite) hitObject.reverseSprite.visible = true;
    if (hitObject.reverseSpriteHead)
      hitObject.reverseSpriteHead.visible = false;
    if (hitObject.comboText) hitObject.comboText.visible = true;
    if (hitObject.sliderSprite) hitObject.sliderSprite.visible = true;
    if (hitObject.sliderBorderSprite)
      hitObject.sliderBorderSprite.visible = true;
    if (hitObject.hitCircleOverlaySprite_sliderend)
      hitObject.hitCircleOverlaySprite_sliderend.visible = true;
    if (hitObject.hitCircleSprite_sliderend)
      hitObject.hitCircleSprite_sliderend.visible = true;
    if (hitObject.followCircle) hitObject.followCircle.visible = true;
  }

  hideHitObject(hitObject) {
    if (hitObject.hitCircleSprite) hitObject.hitCircleSprite.visible = false;
    if (hitObject.approachSprite) hitObject.approachSprite.visible = false;
    if (hitObject.hitCircleOverlaySprite)
      hitObject.hitCircleOverlaySprite.visible = false;
    if (hitObject.reverseSprite) hitObject.reverseSprite.visible = false;
    if (hitObject.reverseSpriteHead)
      hitObject.reverseSpriteHead.visible = false;
    if (hitObject.comboText) hitObject.comboText.visible = false;
    if (hitObject.sliderSprite) hitObject.sliderSprite.visible = false;
    if (hitObject.sliderBorderSprite)
      hitObject.sliderBorderSprite.visible = false;
    if (hitObject.hitCircleOverlaySprite_sliderend)
      hitObject.hitCircleOverlaySprite_sliderend.visible = false;
    if (hitObject.hitCircleSprite_sliderend)
      hitObject.hitCircleSprite_sliderend.visible = false;
    if (hitObject.followCircle) hitObject.followCircle.visible = false;
  }

  // ---------------------------------------------------------------------------
  // Internal: asset loading
  // ---------------------------------------------------------------------------

  async loadAssets() {
    const texture_approach = await Assets.load(approachcircleDataUrl);
    const texture_hitcircle = await Assets.load(hitcircleDataUrl);
    const texture_hitcircleoverlay = await Assets.load(hitcircleoverlayDataUrl);
    const texture_reverse = await Assets.load(reversearrowDataUrl);
    this.applyLinearTextureFiltering(texture_approach);
    this.applyLinearTextureFiltering(texture_hitcircle);
    this.applyLinearTextureFiltering(texture_hitcircleoverlay);
    this.applyLinearTextureFiltering(texture_reverse);
    return {
      texture_approach,
      texture_hitcircle,
      texture_hitcircleoverlay,
      texture_reverse,
    };
  }

  applyLinearTextureFiltering(texture) {
    if (!texture) {
      return;
    }
    const sourceStyle = texture.source?.style;
    if (sourceStyle) {
      sourceStyle.scaleMode = "linear";
      return;
    }
    if (texture.baseTexture && PIXI.SCALE_MODES?.LINEAR != null) {
      texture.baseTexture.scaleMode = PIXI.SCALE_MODES.LINEAR;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: calculations
  // ---------------------------------------------------------------------------

  calculateARValues() {
    const AR = Number(this.beatmap?.Difficulty?.ApproachRate || 5);
    let preempt;
    let fadeIn;
    if (AR < 5) {
      preempt = 1200 + (600 * (5 - AR)) / 5;
      fadeIn = 800 + (400 * (5 - AR)) / 5;
    } else if (AR === 5) {
      preempt = 1200;
      fadeIn = 800;
    } else {
      preempt = 1200 - (750 * (AR - 5)) / 5;
      fadeIn = 800 - (500 * (AR - 5)) / 5;
    }
    return { preempt, fadeIn };
  }

  getDisplayDimensions() {
    const containerWidth = this.containerEl?.clientWidth || 1280;
    const containerHeight = this.containerEl?.clientHeight || 720;
    const containerAspect = containerWidth / containerHeight;

    if (containerAspect > BASE_ASPECT_RATIO) {
      const height = containerHeight;
      return { width: height * BASE_ASPECT_RATIO, height };
    }
    const width = containerWidth;
    return { width, height: width / BASE_ASPECT_RATIO };
  }

  getLayout() {
    const { width, height } = this.getDisplayDimensions();
    const centerX = width / 2;
    const centerY = height / 2;
    const gridUnit = (height * 0.8) / 384;
    return {
      centerX,
      centerY,
      gridUnit,
      topLeftX: centerX - 256 * gridUnit,
      topLeftY: centerY - 192 * gridUnit,
    };
  }

  getCircleSize(gridUnit) {
    const cs = Number(this.beatmap?.Difficulty?.CircleSize || 4);
    return (54.4 - 4.48 * cs) * gridUnit * 2;
  }

  getComboColor(comboColorIndex) {
    const comboColors = [0xff9900, 0xff0000, 0x3399ff, 0x33ff00];
    return comboColors[(comboColorIndex || 0) % comboColors.length];
  }

  getSliderDuration(hitObject, hitTime) {
    if (!hitObject?.sliderInfo) {
      return 0;
    }
    const timingPoint = this.getCachedTimingPoint(hitTime);
    if (!timingPoint?.closestBPM) {
      return 0;
    }
    const beatLength = timingPoint.closestBPM.beatLengthValue;
    const baseSV = Number(this.beatmap?.Difficulty?.SliderMultiplier || 1);
    const hasInheritedSVAfterBpm =
      timingPoint.closestSV &&
      Number.isFinite(timingPoint.closestSV.time) &&
      Number.isFinite(timingPoint.closestBPM.time) &&
      timingPoint.closestSV.time >= timingPoint.closestBPM.time;
    const speed = hasInheritedSVAfterBpm ? timingPoint.closestSV.sv : -100;
    const sliderRepeat = Number(hitObject.sliderInfo.sliderRepeat || 1);
    const sliderLength = Number(hitObject.sliderInfo.sliderLength || 0);
    const svFormulaDuration =
      (sliderLength / (100 * baseSV * (-100 / speed))) *
      beatLength *
      sliderRepeat;
    const fallbackDuration = (beatLength * sliderRepeat * sliderLength) / 100;
    const duration =
      Number.isFinite(svFormulaDuration) && svFormulaDuration > 0
        ? svFormulaDuration
        : fallbackDuration;
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  getSliderDurationCached(hitObject, hitTime) {
    if (
      Number.isFinite(hitObject._sliderDuration) &&
      hitObject._sliderDuration > 0
    ) {
      return hitObject._sliderDuration;
    }
    const duration = this.getSliderDuration(hitObject, hitTime);
    hitObject._sliderDuration = duration > 0 ? duration : 2000;
    return hitObject._sliderDuration;
  }

  getCachedTimingPoint(hitTime) {
    if (this.timingPointCache.has(hitTime)) {
      return this.timingPointCache.get(hitTime);
    }
    const timingPoint = getTimingPointAt(hitTime, this.beatmap);
    this.timingPointCache.set(hitTime, timingPoint);
    return timingPoint;
  }

  prepareHitObject(hitObject, hitTime) {
    hitObject.time = hitTime;
    hitObject._hitsoundHeadPlayed = false;
    hitObject._hitsoundSliderEndPlayed = false;
    hitObject._hitsoundSliderRepeatPlayed = {};
    hitObject._sliderDuration =
      this.getSliderDuration(hitObject, hitTime) || 2000;
    hitObject._repeatBurstMap = {};
    hitObject._repeatBurstTriggered = {};
  }

  getHitBurstProgress(timeDiff) {
    return Math.max(0, Math.min(1, -timeDiff / FADE_OUT_MS));
  }

  getHitBurstAlpha(progress) {
    return Math.max(0, 1 - (Number(progress) || 0));
  }

  getHitBurstSize(baseSize, progress) {
    const safeBaseSize = Number(baseSize) || 0;
    const safeProgress = Number(progress) || 0;
    return safeBaseSize + safeProgress * safeBaseSize * 0.3;
  }

  getHitBurstScale(baseScale, progress) {
    const safeBaseScale = Number(baseScale) || 1;
    const safeProgress = Number(progress) || 0;
    return safeBaseScale + safeProgress * safeBaseScale * 0.3;
  }

  getDelimitedParts(value, delimiter) {
    if (typeof value === "string") {
      return value.split(delimiter);
    }
    if (Array.isArray(value)) {
      return value.map((item) => String(item ?? ""));
    }
    if (value == null) {
      return [];
    }
    return String(value).split(delimiter);
  }

  computeBeatmapDurationMs() {
    if (!this.hitObjectEntries.length) {
      return 0;
    }
    let maxEndTime = 0;
    for (const [hitTime, hitObject] of this.hitObjectEntries) {
      const endTime = this.getHitObjectEndTime(hitObject, hitTime);
      if (Number.isFinite(endTime) && endTime > maxEndTime) {
        maxEndTime = endTime;
      }
    }
    return Math.max(0, maxEndTime);
  }

  getHitObjectEndTime(hitObject, hitTime) {
    if (!hitObject) {
      return hitTime;
    }
    if (hitObject.type?.includes("Slider")) {
      const sliderDuration = this.getSliderDurationCached(hitObject, hitTime);
      return hitTime + Math.max(0, sliderDuration);
    }
    if (hitObject.type?.includes("Spinner")) {
      const extrasParts = this.getDelimitedParts(hitObject.extras, ":");
      const spinnerEndTime = Number.parseInt(extrasParts[0], 10);
      if (Number.isFinite(spinnerEndTime) && spinnerEndTime > hitTime) {
        return spinnerEndTime;
      }
    }
    return hitTime;
  }

  getTransportCurrentTimeMs() {
    if (!this.isPlaying) {
      return this.currentTime;
    }

    const nowPerfMs = performance.now();
    const elapsedMs = nowPerfMs - this.transportStartPerfTime;
    const perfVisualMs = this.transportStartMs + Math.max(0, elapsedMs);
    if (
      this.previewAudio &&
      !this.previewAudio.paused &&
      Number.isFinite(this.previewAudio.currentTime)
    ) {
      if (
        !this.lastAudioSyncSamplePerfMs ||
        nowPerfMs - this.lastAudioSyncSamplePerfMs >=
          AUDIO_SYNC_SAMPLE_INTERVAL_MS
      ) {
        this.lastAudioSyncSamplePerfMs = nowPerfMs;
        const audioDerivedVisualMs = this.getBeatmapTimeMsForPreviewAudioTime(
          this.previewAudio.currentTime * 1000,
        );
        if (Number.isFinite(audioDerivedVisualMs)) {
          const targetOffsetMs = audioDerivedVisualMs - perfVisualMs;
          if (Math.abs(targetOffsetMs) > 120) {
            this.audioSyncOffsetMs = targetOffsetMs;
          } else {
            this.audioSyncOffsetMs =
              this.audioSyncOffsetMs +
              (targetOffsetMs - this.audioSyncOffsetMs) * 0.35;
          }
        }
      }
    }
    return perfVisualMs + this.audioSyncOffsetMs;
  }

  getPreviewAudioTimeMsForBeatmapTime(beatmapTimeMs) {
    return beatmapTimeMs - this.previewTimeMs + this.audioOffsetMs;
  }

  getBeatmapTimeMsForPreviewAudioTime(previewAudioTimeMs) {
    return previewAudioTimeMs + this.previewTimeMs - this.audioOffsetMs;
  }

  /** @deprecated No-op, kept for backward compatibility. */
  async initHitsounds() {}
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function lowerBound(arr, target) {
  let left = 0;
  let right = arr.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (arr[mid] < target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}

function upperBound(arr, target) {
  let left = 0;
  let right = arr.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (arr[mid] <= target) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
}

function darkenColor(color, factor) {
  const normalized = Math.max(0, Math.min(1, Number(factor) || 0));
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const dr = Math.round(r * normalized);
  const dg = Math.round(g * normalized);
  const db = Math.round(b * normalized);
  return (dr << 16) | (dg << 8) | db;
}
