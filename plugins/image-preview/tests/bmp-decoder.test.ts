// Run with: claude plugin test plugins/image-preview
import { expect, test } from 'claude-code/testing'

import { decodeBmp } from '../hooks/bmp-decoder'
import { bmp, bmp32 } from './bmp-fixture'

const RED = 0xff0000
const BLUE = 0x0000ff

test('reads a BMP bottom-up into RGBA, top row first', () => {
  const { width, height, data } = decodeBmp(bmp([[RED, BLUE], [BLUE, RED]]))
  expect([width, height]).toEqual([2, 2])
  expect([...data.slice(0, 8)]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  expect([...data.slice(8, 16)]).toEqual([0, 0, 255, 255, 255, 0, 0, 255])
})

const ARGB: [number, number, number, number] = [0xff0000, 0xff00, 0xff, 0xff000000]

test('reads a 32-bit BMP with an alpha byte, top-down, each channel as written', () => {
  const { data } = decodeBmp(bmp32([[0x80ff0000, 0x400000ff]], ARGB))
  expect([...data]).toEqual([255, 0, 0, 0x80, 0, 0, 255, 0x40])
})

test('a 32-bit BMP whose alpha bytes are all zero is opaque', () => {
  const { data } = decodeBmp(bmp32([[0x00ff0000, 0x0000ff00]], ARGB))
  expect([...data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255])
})

test('channels narrower than a byte are scaled to 0–255; a missing alpha is opaque', () => {
  // 10 bits a channel: red at the top, blue at the bottom, no alpha.
  const TEN: [number, number, number, number] = [0x3ff00000, 0xffc00, 0x3ff, 0]
  const { data } = decodeBmp(bmp32([[(1023 << 20) | (512 << 10) | 0]], TEN))
  expect([...data]).toEqual([255, Math.round((512 * 255) / 1023), 0, 255])
})

test('refuses what is not an uncompressed 24- or 32-bit BMP', () => {
  expect(() => decodeBmp(new Uint8Array(10))).toThrow('not a BMP file')
  const eight = bmp([[0]])
  new DataView(eight.buffer).setUint16(28, 8, true)
  expect(() => decodeBmp(eight)).toThrow('a 8-bit BMP')
  const truncated = bmp([[0, 0], [0, 0]]).slice(0, 56)
  expect(() => decodeBmp(truncated)).toThrow('a truncated BMP')
})
