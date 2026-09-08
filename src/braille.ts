export type BrailleLayer = "empty" | "speed" | "mean" | "overlap";
export interface BrailleCell {
  char: string;
  layer: BrailleLayer;
}

const DOT_BITS = [
  [0x1, 0x2, 0x4, 0x40],
  [0x8, 0x10, 0x20, 0x80],
] as const;
const MAX_DIMENSION = 1000;
const MAX_VALUE = 1_000_000_000;
const safeDimension = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(MAX_DIMENSION, Math.floor(value))) : 0;
const safeValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(MAX_VALUE, value)) : 0;

/**
 * Pure 2x4-dot Braille rasterizer. Sparse samples are interpolated across the
 * physical dot grid, so a low-frequency stream still looks like a time series.
 */
export function rasterizeBraille(
  speed: readonly number[],
  mean: readonly number[],
  columns: number,
  rows: number,
): BrailleCell[][] {
  const safeColumns = safeDimension(columns);
  const safeRows = safeDimension(rows);
  const safeSpeed = speed.map(safeValue);
  const safeMean = mean.map(safeValue);
  const speedDots = createDots(safeColumns * 2, safeRows * 4);
  const meanDots = createDots(safeColumns * 2, safeRows * 4);
  const scale = Math.max(1, ...safeSpeed, ...safeMean);
  drawSeries(speedDots, safeSpeed, scale);
  drawSeries(meanDots, safeMean, scale);

  return Array.from({ length: safeRows }, (_, row) =>
    Array.from({ length: safeColumns }, (_, column) => {
      let speedMask = 0;
      let meanMask = 0;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 2; x++) {
          const bit = DOT_BITS[x]![y]!;
          if (speedDots[row * 4 + y]?.[column * 2 + x]) speedMask |= bit;
          if (meanDots[row * 4 + y]?.[column * 2 + x]) meanMask |= bit;
        }
      }
      const mask = speedMask | meanMask;
      return {
        char: mask === 0 ? " " : String.fromCodePoint(0x2800 + mask),
        layer: speedMask && meanMask ? "overlap" : speedMask ? "speed" : meanMask ? "mean" : "empty",
      };
    }),
  );
}

function createDots(width: number, height: number): boolean[][] {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => false));
}

function drawSeries(dots: boolean[][], values: readonly number[], scale: number): void {
  const height = dots.length;
  const width = dots[0]?.length ?? 0;
  if (width === 0 || height === 0 || values.length === 0) return;
  const points = Array.from({ length: width }, (_, x) => {
    const value = interpolate(values, width === 1 ? 0 : x / (width - 1));
    return [x, mapY(value, scale, height)] as const;
  });
  for (let index = 1; index < points.length; index++) drawLine(dots, points[index - 1]!, points[index]!);
  if (points.length === 1) mark(dots, points[0]![0], points[0]![1]);
}

function interpolate(values: readonly number[], position: number): number {
  if (values.length === 1) return safeValue(values[0]);
  const safePosition = Number.isFinite(position) ? Math.max(0, Math.min(1, position)) : 0;
  const scaled = safePosition * (values.length - 1);
  const left = Math.floor(scaled);
  const right = Math.min(values.length - 1, left + 1);
  const fraction = scaled - left;
  return safeValue(safeValue(values[left]) + (safeValue(values[right]) - safeValue(values[left])) * fraction);
}

function mapY(value: number, scale: number, height: number): number {
  const safeScale = Math.max(1, safeValue(scale));
  return Math.round((1 - Math.min(safeValue(value), safeScale) / safeScale) * (height - 1));
}

function drawLine(dots: boolean[][], from: readonly [number, number], to: readonly [number, number]): void {
  let [x, y] = from;
  const [targetX, targetY] = to;
  // Inputs are generated from bounded dimensions and finite values. This guard
  // is retained at the loop boundary so malformed callers can never spin it.
  if (![x, y, targetX, targetY].every(Number.isFinite)) return;
  const dx = Math.abs(targetX - x);
  const dy = -Math.abs(targetY - y);
  const stepX = x < targetX ? 1 : -1;
  const stepY = y < targetY ? 1 : -1;
  let error = dx + dy;
  while (true) {
    mark(dots, x, y);
    if (x === targetX && y === targetY) return;
    const doubled = error * 2;
    if (doubled >= dy) { error += dy; x += stepX; }
    if (doubled <= dx) { error += dx; y += stepY; }
  }
}

function mark(dots: boolean[][], x: number, y: number): void {
  if (y >= 0 && y < dots.length && x >= 0 && x < (dots[0]?.length ?? 0)) dots[y]![x] = true;
}
