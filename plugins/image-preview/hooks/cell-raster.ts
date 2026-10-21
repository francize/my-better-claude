// Draws a picture in terminal cells: each cell a block element in two colors.
import type { Pixels } from './bmp-decoder'

const UPPER_HALF = 0x2580 // ▀
const LEFT_HALF = 0x258c // ▌
const SPACE = 0x20
const DEFAULT_COLOR = 0x01000000

/**
 * The largest box of cells within the bounds that keeps the picture's shape. A cell is about
 * twice as tall as it is wide, and holds two rows of pixels.
 */
export function fitCells (width: number, height: number, maxColumns: number, maxRows: number) {
  const columnsCap = Math.max(1, Math.min(maxColumns, width))
  let columns = columnsCap
  let rows = Math.max(1, Math.round((columns * height) / width / 2))
  if (rows > maxRows) {
    rows = Math.max(1, maxRows)
    columns = Math.max(1, Math.min(columnsCap, Math.round((rows * 2 * width) / height)))
  }
  return { columns, rows }
}

// Light adds up in linear terms, not in the gamma-encoded bytes: averaging the bytes darkens a
// light line on a dark ground until it is gone.
const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const value = i / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
})
const ENCODED = Uint8Array.from({ length: 4096 }, (_, i) => {
  const value = i / 4095
  return Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055))
})
const encode = (linear: number) => ENCODED[Math.min(4095, Math.max(0, Math.round(linear * 4095)))]!

// Each cell is sampled as a grid of SIDE by SIDE points, each the average of the pixels it covers.
const SIDE = 8
const HALF = SIDE / 2
const POINTS = SIDE * SIDE

// Sums a cell's points are added into: each of its rows, each of its columns, each of its quarters.
const ROW_SUM = 0
const COLUMN_SUM = SIDE
const QUARTER_SUM = SIDE * 2
const SUMS = SIDE * 2 + 4
const quarterOf = (x: number, y: number) => (y < HALF ? 0 : 2) + (x < HALF ? 0 : 1)

/**
 * A block element: which of a cell's points its foreground covers, how many, and the sums whose
 * union they are, so a split is scored from those sums instead of from every point.
 */
type Shape = { glyph: number; inside: Uint8Array; count: number; sums: number[] }

const shape = (glyph: number, sums: number[]): Shape => {
  const inside = Uint8Array.from({ length: POINTS }, (_, i) => {
    const x = i % SIDE
    const y = Math.floor(i / SIDE)
    return sums.some(at => at === ROW_SUM + y || at === COLUMN_SUM + x || at === QUARTER_SUM + quarterOf(x, y)) ? 1 : 0
  })
  return { glyph, inside, count: inside.reduce((sum, bit) => sum + bit, 0), sums }
}

const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ROW_SUM + from + i)
const columns = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => COLUMN_SUM + from + i)
const quarters = (...which: number[]) => which.map(q => QUARTER_SUM + q)

// The ways a cell can be split in two colors: the halves, the eighths from the bottom and from the
// left (each also the rest from the top or right, the colors swapped), the quarters and the
// diagonals. The halves first, so a cell they draw as well as another is drawn with them.
const SHAPES: Shape[] = [
  shape(UPPER_HALF, rows(0, HALF)),
  shape(LEFT_HALF, columns(0, HALF)),
  ...[1, 2, 3, 5, 6, 7].map(k => shape(0x2580 + k, rows(SIDE - k, SIDE))), // ▁▂▃▅▆▇
  ...[1, 2, 3, 5, 6, 7].map(k => shape(0x2590 - k, columns(0, k))), // ▏▎▍▋▊▉
  shape(0x2598, quarters(0)), // ▘
  shape(0x259d, quarters(1)), // ▝
  shape(0x2596, quarters(2)), // ▖
  shape(0x2597, quarters(3)), // ▗
  shape(0x259a, quarters(0, 3)), // ▚
  shape(0x259e, quarters(1, 2)) // ▞
]

const SCRATCH_SUMS = new Float64Array(SUMS * 3)

function addTo (sums: Float64Array, at: number, r: number, g: number, b: number) {
  sums[at * 3]! += r
  sums[at * 3 + 1]! += g
  sums[at * 3 + 2]! += b
}

/** One cell's points: gamma-encoded, to choose a shape by; linear, to mix its colors in; and which show. */
type Points = { encoded: Float64Array; linear: Float64Array; shows: Uint8Array; shown: number }

/** Averages, in linear light, the pixels under each of the points of the cell at `column`, `row`. */
function pointsOf ({ width, height, data }: Pixels, columns: number, rows: number, column: number, row: number, points: Points) {
  const across = columns * SIDE
  const down = rows * SIDE
  points.shown = 0
  for (let py = 0; py < SIDE; py++) {
    const y0 = Math.floor(((row * SIDE + py) * height) / down)
    const y1 = Math.max(y0 + 1, Math.floor(((row * SIDE + py + 1) * height) / down))
    for (let px = 0; px < SIDE; px++) {
      const x0 = Math.floor(((column * SIDE + px) * width) / across)
      const x1 = Math.max(x0 + 1, Math.floor(((column * SIDE + px + 1) * width) / across))
      let r = 0
      let g = 0
      let b = 0
      let alpha = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const at = (y * width + x) * 4
          const a = data[at + 3]!
          r += LINEAR[data[at]!]! * a
          g += LINEAR[data[at + 1]!]! * a
          b += LINEAR[data[at + 2]!]! * a
          alpha += a
        }
      }
      const i = py * SIDE + px
      const shows = alpha / ((y1 - y0) * (x1 - x0)) >= 128
      points.shows[i] = shows ? 1 : 0
      if (!shows) continue
      points.shown++
      points.linear[i * 3] = r / alpha
      points.linear[i * 3 + 1] = g / alpha
      points.linear[i * 3 + 2] = b / alpha
      for (let c = 0; c < 3; c++) points.encoded[i * 3 + c] = encode(points.linear[i * 3 + c]!)
    }
  }
}

/**
 * The shape that splits the points in the two groups closest to their own averages (least squared
 * error, measured on the encoded values, which is closer to what the eye sees); none where one
 * color is as close. Part see-through, the shape that best parts the points that show from the rest.
 */
function shapeOf ({ encoded, shows, shown }: Points) {
  let best: Shape | undefined
  if (shown < POINTS) {
    let bestMatches = -1
    for (const candidate of SHAPES) {
      let matches = 0
      for (let i = 0; i < POINTS; i++) matches += candidate.inside[i] === shows[i] ? 1 : 0
      if (matches > bestMatches) {
        bestMatches = matches
        best = candidate
      }
    }
    return best
  }
  // Each split's error is the total of the squares less what its two groups' averages explain: the
  // largest |sum|² / count over the two groups is the least error. The encoded values are whole
  // numbers, so the sums are exact whichever order they are added in.
  const sums = SCRATCH_SUMS.fill(0)
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < POINTS; i++) {
    const x = i % SIDE
    const y = (i - x) / SIDE
    const pr = encoded[i * 3]!
    const pg = encoded[i * 3 + 1]!
    const pb = encoded[i * 3 + 2]!
    r += pr
    g += pg
    b += pb
    addTo(sums, ROW_SUM + y, pr, pg, pb)
    addTo(sums, COLUMN_SUM + x, pr, pg, pb)
    addTo(sums, QUARTER_SUM + quarterOf(x, y), pr, pg, pb)
  }
  let bestScore = (r ** 2 + g ** 2 + b ** 2) / POINTS
  for (const candidate of SHAPES) {
    let sr = 0
    let sg = 0
    let sb = 0
    for (const at of candidate.sums) {
      sr += sums[at * 3]!
      sg += sums[at * 3 + 1]!
      sb += sums[at * 3 + 2]!
    }
    const count = candidate.count
    const rest = POINTS - count
    // Added channel by channel, in the order the score has always been added in.
    const score = (sr ** 2 / count + (r - sr) ** 2 / rest) + (sg ** 2 / count + (g - sg) ** 2 / rest) + (sb ** 2 / count + (b - sb) ** 2 / rest)
    if (score > bestScore + 1e-6) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

/** The color of the points that show on one side of a shape (all of them with none), mixed in linear light. */
function colorOf ({ linear, shows }: Points, shape: Shape | undefined, side: number) {
  const sum = [0, 0, 0]
  let count = 0
  for (let i = 0; i < POINTS; i++) {
    if (shows[i] === 0 || (shape ? shape.inside[i] : 1) !== side) continue
    for (let c = 0; c < 3; c++) sum[c]! += linear[i * 3 + c]!
    count++
  }
  return count === 0 ? DEFAULT_COLOR : (encode(sum[0]! / count) << 16) | (encode(sum[1]! / count) << 8) | encode(sum[2]! / count)
}

/**
 * The picture as a `Raster`'s cells: `columns × rows` block elements, each cell sampled at eight
 * by eight points and drawn with the half, eighth or quarter block that splits them best, in their
 * two colors; the terminal's own color where the picture is see-through.
 */
export function rasterize (pixels: Pixels, columns: number, rows: number): string {
  const words = new Uint32Array(columns * rows * 3)
  const points: Points = { encoded: new Float64Array(POINTS * 3), linear: new Float64Array(POINTS * 3), shows: new Uint8Array(POINTS), shown: 0 }
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      pointsOf(pixels, columns, rows, column, row, points)
      const at = (row * columns + column) * 3
      if (points.shown === 0) {
        words.set([SPACE, DEFAULT_COLOR, DEFAULT_COLOR], at)
        continue
      }
      const best = shapeOf(points)
      const inside = colorOf(points, best, 1)
      const outside = !best ? inside : points.shown < POINTS ? DEFAULT_COLOR : colorOf(points, best, 0)
      words.set([best?.glyph ?? UPPER_HALF, inside, outside], at)
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}
