import { test } from "node:test";
import assert from "node:assert/strict";
import { fitBackground } from "../src/backgroundLayout.js";

test("cover crops the overflow, centred", () => {
  assert.deepEqual(fitBackground("cover", 100, 100, 160, 90), {
    scale: 1.6,
    x: 0,
    y: -35,
  });
});

test("contain shows the whole image, centred", () => {
  assert.deepEqual(fitBackground("contain", 100, 100, 160, 90), {
    scale: 0.9,
    x: 35,
    y: 0,
  });
});

test("an unknown fit is cover", () => {
  assert.deepEqual(
    fitBackground("stretch", 100, 100, 160, 90),
    fitBackground("cover", 100, 100, 160, 90),
  );
});
