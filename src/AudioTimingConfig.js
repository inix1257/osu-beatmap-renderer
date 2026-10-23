const DEFAULT_AUDIO_OFFSET_MS = 100;

let globalAudioOffsetMs = DEFAULT_AUDIO_OFFSET_MS;
const listeners = new Set();

export function getGlobalAudioOffsetMs() {
  return globalAudioOffsetMs;
}

export function setGlobalAudioOffsetMs(ms) {
  const next = Number(ms) || 0;
  if (next === globalAudioOffsetMs) {
    return;
  }
  globalAudioOffsetMs = next;
  for (const listener of listeners) {
    listener(globalAudioOffsetMs);
  }
}

export function subscribeGlobalAudioOffset(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
