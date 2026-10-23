/** How the background image is fitted to the canvas. */
export const BACKGROUND_FITS = Object.freeze(["cover", "contain"]);

/**
 * Scale and position for a `texWidth` x `texHeight` image drawn centred in a
 * `width` x `height` canvas. `cover` fills the canvas and crops the overflow;
 * `contain` shows the whole image and leaves bars.
 *
 * @param {"cover"|"contain"} fit
 * @param {number} texWidth
 * @param {number} texHeight
 * @param {number} width
 * @param {number} height
 * @returns {{ scale: number, x: number, y: number }}
 */
export function fitBackground(fit, texWidth, texHeight, width, height) {
  const scaleX = width / texWidth;
  const scaleY = height / texHeight;
  const scale =
    fit === "contain" ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
  return {
    scale,
    x: (width - texWidth * scale) / 2,
    y: (height - texHeight * scale) / 2,
  };
}
