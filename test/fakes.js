/**
 * Just enough browser for BeatmapEngine's transport without init(): a
 * container element, an HTMLAudioElement fake and a controllable
 * performance clock. Import this before BeatmapEngine.
 */

export const clock = { now: 0 };

Object.defineProperty(globalThis, "performance", {
  value: { now: () => clock.now },
  configurable: true,
  writable: true,
});

globalThis.HTMLElement ??= class HTMLElement {};

/** Every FakeAudio created, newest last. */
export const audios = [];

export class FakeAudio {
  /** @param {string} [url] */
  constructor(url) {
    this.src = url ?? "";
    this.preload = "";
    this.volume = 1;
    this.paused = true;
    this.ended = false;
    this.readyState = 0;
    this.duration = NaN;
    this.crossOriginSet = false;
    this._crossOrigin = null;
    this._currentTime = 0;
    audios.push(this);
  }

  get crossOrigin() {
    return this._crossOrigin;
  }

  set crossOrigin(value) {
    this.crossOriginSet = true;
    this._crossOrigin = value;
  }

  get currentTime() {
    return this._currentTime;
  }

  /** Clamped to the duration once it is known, like the browser does. */
  set currentTime(sec) {
    const max = Number.isFinite(this.duration) ? this.duration : Infinity;
    this._currentTime = Math.min(max, Math.max(0, sec));
    this.ended = false;
  }

  /** @param {number} sec */
  loadMetadata(sec) {
    this.duration = sec;
    this.readyState = 1;
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }
}

globalThis.Audio = FakeAudio;

export function lastAudio() {
  return audios[audios.length - 1];
}
