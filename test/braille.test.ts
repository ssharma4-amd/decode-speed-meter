import assert from "node:assert/strict";
import test from "node:test";
import { rasterizeBraille } from "../src/braille";

const occupied = (grid: ReturnType<typeof rasterizeBraille>) =>
  grid.flat().filter((cell) => cell.layer !== "empty");

test("Braille rasterizer handles empty, flat, and single-point inputs", () => {
  assert.equal(occupied(rasterizeBraille([], [], 8, 3)).length, 0);
  const flat = rasterizeBraille([5, 5], [], 8, 3);
  assert.ok(occupied(flat).length >= 4, "flat series spans chart width");
  const single = rasterizeBraille([7], [], 8, 3);
  assert.ok(occupied(single).length >= 4, "single point is expanded across the time axis");
});

test("Braille rasterizer interpolates spikes, clips values, and records mean overlap", () => {
  const spike = rasterizeBraille([0, 1000, 0], [0, 1000, 0], 12, 4);
  assert.ok(occupied(spike).length > 8, "interpolation draws connected paths");
  assert.ok(spike.flat().some((cell) => cell.layer === "overlap"));
  assert.ok(spike.flat().every((cell) => cell.char.length === 1));
});

test("Braille rasterizer rejects nonfinite dimensions and values without entering a line loop", () => {
  assert.deepEqual(rasterizeBraille([NaN, Infinity, -Infinity], [Infinity], Infinity, 4), [[], [], [], []]);
  const grid = rasterizeBraille([NaN, Infinity, -1], [Number.NaN], 8, 3);
  assert.equal(grid.length, 3);
  assert.ok(grid.flat().every((cell) => cell.char.length === 1));
});
