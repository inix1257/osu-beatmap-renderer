# Changelog

This project follows [Semantic Versioning](https://semver.org/). While in
0.x, a minor release may contain breaking changes.

## 0.2.0

Without the new options the engine behaves as in 0.1.2, apart from the
`pause()` fix.

### Added
- `audioCrossOrigin` option. `null` leaves `crossOrigin` unset, so audio
  from hosts without CORS headers (`b.ppy.sh/preview`) can play.
- `previewClip` option for audio that is a clip starting at PreviewTime:
  seeking, `play()`, the transport clock and the audio follow the clip, so
  the map plays on silently outside it instead of snapping back to
  PreviewTime or jumping after pause/resume.
- `getPreviewClipDurationMs()` and `isTimeInPreviewClip(ms)`.
- `backgroundFit` (`"cover"` | `"contain"`) and `backgroundTint` options.
- `setRendering(on)` and `isRendering()` to stop drawing frames while
  hidden.
- Tests (`npm test`).
- `repository`, `homepage` and `bugs` in package.json.

### Fixed
- `pause()` pauses the audio before taking the time snapshot, so a drift
  sample from an audio clock that is off (ended, clamped) can no longer make
  the time jump on pause.

## 0.1.2

- Background sprite sits below every hit object.

## 0.1.1

- `audioOffsetMs` constructor option; the default offset is the global
  value from `AudioTimingConfig` (100 ms).

## 0.1.0

- First release.
