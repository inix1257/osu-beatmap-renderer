import {
  normal_hitnormal,
  normal_hitwhistle,
  normal_hitfinish,
  normal_hitclap,
  soft_hitnormal,
  soft_hitwhistle,
  soft_hitfinish,
  soft_hitclap,
  drum_hitnormal,
  drum_hitwhistle,
  drum_hitfinish,
  drum_hitclap,
} from "./soundAssets.js";

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

/**
 * Decode a base64 data-URL string into an ArrayBuffer.
 */
function dataUrlToArrayBuffer(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export class HitsoundPlayer {
  constructor({
    hitsoundVolume = 0.3,
    schedulerIntervalMs = 20,
    schedulerLookaheadMs = 120,
  } = {}) {
    this.hitsoundVolume = hitsoundVolume;

    this.schedulerIntervalMs = schedulerIntervalMs;
    this.schedulerLookaheadMs = schedulerLookaheadMs;

    this.audioContext = null;
    this.hitsoundBuffers = new Map();

    this.schedulerTimer = null;
    this.hitsoundEvents = [];
    this.hitsoundEventTimes = [];
    this.hitsoundEventCursor = 0;

    this.activeScheduledSources = new Set();

    this.isPlayingRef = () => false;
    this.getTransportCurrentTimeMsRef = () => 0;
  }

  async init() {
    try {
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();

      // Bundled assets are base64 data URLs — decode directly without network fetch.
      const assets = [
        ["normal-hitnormal", normal_hitnormal],
        ["normal-hitwhistle", normal_hitwhistle],
        ["normal-hitfinish", normal_hitfinish],
        ["normal-hitclap", normal_hitclap],
        ["soft-hitnormal", soft_hitnormal],
        ["soft-hitwhistle", soft_hitwhistle],
        ["soft-hitfinish", soft_hitfinish],
        ["soft-hitclap", soft_hitclap],
        ["drum-hitnormal", drum_hitnormal],
        ["drum-hitwhistle", drum_hitwhistle],
        ["drum-hitfinish", drum_hitfinish],
        ["drum-hitclap", drum_hitclap],
      ];

      await Promise.all(
        assets.map(async ([name, dataUrl]) => {
          const arrayBuffer = dataUrlToArrayBuffer(dataUrl);
          const audioBuffer =
            await this.audioContext.decodeAudioData(arrayBuffer);
          this.hitsoundBuffers.set(name, audioBuffer);
        }),
      );
    } catch (_error) {
      this.hitsoundBuffers.clear();
    }
  }

  destroy() {
    this.stopScheduler();
    this.clearScheduledSources();

    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    this.hitsoundBuffers.clear();
    this.hitsoundEvents = [];
    this.hitsoundEventTimes = [];
    this.hitsoundEventCursor = 0;
  }

  setVolume(volume) {
    const v = Math.max(0, Math.min(1, Number(volume) || 0));
    this.hitsoundVolume = v;
  }

  buildHitsoundEvents(
    hitObjectEntries,
    { getCachedTimingPoint, getSliderDurationCached, getHitObjectEndTime },
  ) {
    this.hitsoundEvents = [];

    for (const [hitTime, hitObject] of hitObjectEntries) {
      const timingPoint = getCachedTimingPoint(hitTime);
      if (!timingPoint) continue;

      if (hitObject.type.includes("Slider")) {
        const sliderDuration = getSliderDurationCached(hitObject, hitTime);
        const sliderInfo = hitObject.sliderInfo;
        const repeat = Number(sliderInfo?.sliderRepeat || 1);

        this.hitsoundEvents.push(
          this.resolveSliderEdgeEvent(
            hitObject,
            timingPoint,
            hitTime,
            0,
            hitTime,
          ),
        );
        for (let i = 1; i < repeat; i++) {
          const repeatTime = hitTime + (sliderDuration * i) / repeat;
          this.hitsoundEvents.push(
            this.resolveSliderEdgeEvent(
              hitObject,
              timingPoint,
              hitTime,
              i,
              repeatTime,
            ),
          );
        }
        const endTime = hitTime + sliderDuration;
        this.hitsoundEvents.push(
          this.resolveSliderEdgeEvent(
            hitObject,
            timingPoint,
            hitTime,
            repeat,
            endTime,
          ),
        );
      } else if (hitObject.type.includes("Spinner")) {
        this.hitsoundEvents.push(
          this.resolveSpinnerEndEvent(
            hitObject,
            timingPoint,
            hitTime,
            getHitObjectEndTime,
          ),
        );
      } else {
        this.hitsoundEvents.push(
          this.resolveCircleEvent(hitObject, timingPoint, hitTime),
        );
      }
    }

    this.hitsoundEvents = this.hitsoundEvents
      .filter((e) => e && Number.isFinite(e.time))
      .sort((a, b) => a.time - b.time);

    this.hitsoundEventTimes = this.hitsoundEvents.map((e) => e.time);
    this.hitsoundEventCursor = 0;
  }

  startScheduler({ isPlaying, getTransportCurrentTimeMs }) {
    if (this.schedulerTimer) return;

    this.isPlayingRef = isPlaying;
    this.getTransportCurrentTimeMsRef = getTransportCurrentTimeMs;

    this.tickScheduler();
    this.schedulerTimer = window.setInterval(
      () => this.tickScheduler(),
      this.schedulerIntervalMs,
    );
  }

  stopScheduler() {
    if (!this.schedulerTimer) return;
    window.clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
  }

  tickScheduler() {
    if (
      !this.isPlayingRef() ||
      !this.audioContext ||
      this.hitsoundEvents.length === 0
    )
      return;
    if (this.audioContext.state === "suspended") return;

    const transportNow = this.getTransportCurrentTimeMsRef();
    const scheduleUntil = transportNow + this.schedulerLookaheadMs;

    while (this.hitsoundEventCursor < this.hitsoundEvents.length) {
      const event = this.hitsoundEvents[this.hitsoundEventCursor];
      if (event.time > scheduleUntil) break;

      if (event.time >= transportNow - 25) {
        const when =
          this.audioContext.currentTime +
          Math.max(0, (event.time - transportNow) / 1000);
        this.playHitsoundAt(
          event.normalSet,
          event.additionSet,
          event.hitsound,
          when,
        );
      }

      this.hitsoundEventCursor += 1;
    }
  }

  resetFromCurrentTime(currentTime) {
    this.clearScheduledSources();
    this.hitsoundEventCursor = lowerBound(this.hitsoundEventTimes, currentTime);
  }

  clearScheduledSources() {
    for (const source of this.activeScheduledSources) {
      try {
        source.stop();
      } catch (_e) {
        // No-op if source already ended.
      }
    }
    this.activeScheduledSources.clear();
  }

  playHitsoundAt(normalset, additionSet, hitsound, when) {
    const normal = Number.parseInt(normalset, 10);
    let addition = Number.parseInt(additionSet, 10);
    const soundMask = Number.parseInt(hitsound, 10);
    if (Number.isNaN(normal) || Number.isNaN(soundMask)) return;

    if (normal === 1) this.playHitsoundBufferAt("normal-hitnormal", when);
    if (normal === 2) this.playHitsoundBufferAt("soft-hitnormal", when);
    if (normal === 3) this.playHitsoundBufferAt("drum-hitnormal", when);

    if (addition === 0) addition = normal;
    if (addition === 1) {
      if (soundMask & 2) this.playHitsoundBufferAt("normal-hitwhistle", when);
      if (soundMask & 4) this.playHitsoundBufferAt("normal-hitfinish", when);
      if (soundMask & 8) this.playHitsoundBufferAt("normal-hitclap", when);
    }
    if (addition === 2) {
      if (soundMask & 2) this.playHitsoundBufferAt("soft-hitwhistle", when);
      if (soundMask & 4) this.playHitsoundBufferAt("soft-hitfinish", when);
      if (soundMask & 8) this.playHitsoundBufferAt("soft-hitclap", when);
    }
    if (addition === 3) {
      if (soundMask & 2) this.playHitsoundBufferAt("drum-hitwhistle", when);
      if (soundMask & 4) this.playHitsoundBufferAt("drum-hitfinish", when);
      if (soundMask & 8) this.playHitsoundBufferAt("drum-hitclap", when);
    }
  }

  playHitsoundBufferAt(key, when) {
    if (!this.audioContext || !this.hitsoundBuffers.has(key)) return;

    const source = this.audioContext.createBufferSource();
    const gain = this.audioContext.createGain();
    gain.gain.value = this.hitsoundVolume;

    source.buffer = this.hitsoundBuffers.get(key);
    source.connect(gain);
    gain.connect(this.audioContext.destination);

    source.onended = () => {
      this.activeScheduledSources.delete(source);
    };

    this.activeScheduledSources.add(source);
    source.start(when);
  }

  resolveCircleEvent(hitObject, timingPoint, hitTime) {
    const extrasParts = this.getDelimitedParts(hitObject?.extras, ":");
    const rawNormalSet = extrasParts[0];
    const rawAdditionSet = extrasParts[1];

    const normalSet =
      rawNormalSet && rawNormalSet !== "0"
        ? rawNormalSet
        : String(timingPoint.sampleSet || 1);
    const additionSet =
      rawAdditionSet && rawAdditionSet !== "0" ? rawAdditionSet : normalSet;
    return {
      time: hitTime,
      normalSet,
      additionSet,
      hitsound: String(hitObject.hitSound || "0"),
    };
  }

  resolveSliderEdgeEvent(
    hitObject,
    timingPoint,
    _hitTime,
    edgeIndex,
    eventTime,
  ) {
    const sliderInfo = hitObject.sliderInfo;
    if (sliderInfo?.edgeSounds && sliderInfo?.edgeSets) {
      const edgeSounds = this.getDelimitedParts(sliderInfo.edgeSounds, "|");
      const edgeSets = this.getDelimitedParts(sliderInfo.edgeSets, "|");
      const hitsound = edgeSounds[edgeIndex] || "0";
      const edgeSetParts = this.getDelimitedParts(
        edgeSets[edgeIndex] || "0:0",
        ":",
      );
      const normalSet =
        edgeSetParts[0] === "0"
          ? String(timingPoint.sampleSet || 1)
          : edgeSetParts[0] || String(timingPoint.sampleSet || 1);
      const additionSet =
        edgeSetParts[1] === "0" ? normalSet : edgeSetParts[1] || normalSet;
      return { time: eventTime, normalSet, additionSet, hitsound };
    }

    const set = String(timingPoint.sampleSet || 1);
    return { time: eventTime, normalSet: set, additionSet: set, hitsound: "0" };
  }

  resolveSpinnerEndEvent(hitObject, timingPoint, hitTime, getHitObjectEndTime) {
    const spinnerEndTime = getHitObjectEndTime(hitObject, hitTime);
    const extras = hitObject?.extras;
    const hitSampleRaw = Array.isArray(extras) ? extras[1] : null;
    const hitSampleParts = this.getDelimitedParts(hitSampleRaw, ":");

    const rawNormalSet = hitSampleParts[0];
    const rawAdditionSet = hitSampleParts[1];

    const normalSet =
      rawNormalSet && rawNormalSet !== "0"
        ? rawNormalSet
        : String(timingPoint.sampleSet || 1);
    const additionSet =
      rawAdditionSet && rawAdditionSet !== "0" ? rawAdditionSet : normalSet;

    return {
      time: spinnerEndTime,
      normalSet,
      additionSet,
      hitsound: String(hitObject.hitSound || "0"),
    };
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
}
