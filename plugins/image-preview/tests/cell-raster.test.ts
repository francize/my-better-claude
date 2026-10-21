// Run with: claude plugin test plugins/image-preview
import { expect, test } from 'claude-code/testing'

import { decodeBmp } from '../hooks/bmp-decoder'
import { fitCells, rasterize } from '../hooks/cell-raster'
import { bmp, bmp32 } from './bmp-fixture'

const RED = 0xff0000
const BLUE = 0x0000ff

test('fits a picture in the bounds, keeping its shape', () => {
  expect(fitCells(1280, 800, 64, 18)).toEqual({ columns: 58, rows: 18 })
  expect(fitCells(1600, 400, 64, 18)).toEqual({ columns: 64, rows: 8 })
  expect(fitCells(10, 10, 64, 18)).toEqual({ columns: 10, rows: 5 })
})

const wordsOf = (cells: string) => [...new Uint32Array(Uint8Array.fromBase64(cells).buffer)]

test('paints a cell of two colors as a half block: the top one over the bottom one', () => {
  expect(wordsOf(rasterize(decodeBmp(bmp([[RED], [BLUE]])), 1, 1))).toEqual([0x2580, RED, BLUE])
})

test('paints the quarters of a cell that differ in the foreground', () => {
  expect(wordsOf(rasterize(decodeBmp(bmp([[RED, BLUE], [RED, RED]])), 1, 1))).toEqual([0x259d, BLUE, RED])
  expect(wordsOf(rasterize(decodeBmp(bmp([[RED, BLUE], [BLUE, RED]])), 1, 1))).toEqual([0x259a, RED, BLUE])
})

test('paints an edge between the halves of a cell with an eighth block', () => {
  const rows = [RED, RED, RED, RED, RED, RED, BLUE, BLUE].map(color => [color])
  expect(wordsOf(rasterize(decodeBmp(bmp(rows)), 1, 1))).toEqual([0x2582, BLUE, RED])
  const columns = [[RED, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE]]
  expect(wordsOf(rasterize(decodeBmp(bmp([...columns, ...columns])), 1, 1))).toEqual([0x258f, RED, BLUE])
})

const SEE_THROUGH = 0x01000000
const ARGB: [number, number, number, number] = [0xff0000, 0xff00, 0xff, 0xff000000]

test('a cell of one color is a half block in that color over itself', () => {
  expect(wordsOf(rasterize(decodeBmp(bmp([[RED], [RED]])), 1, 1))).toEqual([0x2580, RED, RED])
})

test('a see-through cell is a space in the terminal\'s own colors', () => {
  const shown = (0xff000000 | RED) >>> 0
  const words = wordsOf(rasterize(decodeBmp(bmp32([[0x00ff0000, shown], [0x00ff0000, shown]], ARGB)), 2, 1))
  expect(words.slice(0, 3)).toEqual([0x20, SEE_THROUGH, SEE_THROUGH])
  expect(words.slice(3)).toEqual([0x2580, RED, RED])
})

test('a cell half see-through draws the half that shows over the terminal\'s color', () => {
  const opaque = (0xff000000 | RED) >>> 0
  expect(wordsOf(rasterize(decodeBmp(bmp32([[opaque], [0x000000ff]], ARGB)), 1, 1))).toEqual([0x2580, RED, SEE_THROUGH])
})

test('a picture is drawn as columns × rows cells', () => {
  expect(wordsOf(rasterize(decodeBmp(bmp([[RED, BLUE, RED], [BLUE, RED, BLUE]])), 3, 1))).toHaveLength(9)
})

test('fitting keeps at least one cell, and never more columns than pixels', () => {
  expect(fitCells(1, 1000, 64, 18)).toEqual({ columns: 1, rows: 18 })
  expect(fitCells(3, 2, 64, 18)).toEqual({ columns: 3, rows: 1 })
  expect(fitCells(100, 100, 0, 0)).toEqual({ columns: 1, rows: 1 })
})
