// Test pictures, written as the converters write them.

/** A 24-bit bottom-up BMP, as ImageMagick writes one: `rows` top first, each pixel `0xRRGGBB`. */
export function bmp (rows: number[][]) {
  const width = rows[0]!.length
  const height = rows.length
  const stride = Math.ceil((width * 3) / 4) * 4
  const bytes = new Uint8Array(54 + stride * height)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  rows.forEach((row, y) => row.forEach((color, x) => {
    const at = 54 + (height - 1 - y) * stride + x * 3
    bytes.set([color & 0xff, (color >> 8) & 0xff, color >> 16], at)
  }))
  return bytes
}

/**
 * A 32-bit top-down BI_BITFIELDS BMP: `rows` top first, each pixel the 32-bit word written as is,
 * its channels where `masks` (red, green, blue, alpha) say.
 */
export function bmp32 (rows: number[][], masks: [number, number, number, number]) {
  const width = rows[0]!.length
  const height = rows.length
  const offset = 14 + 56
  const bytes = new Uint8Array(offset + width * height * 4)
  const view = new DataView(bytes.buffer)
  bytes.set([0x42, 0x4d])
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, offset, true)
  view.setUint32(14, 56, true)
  view.setInt32(18, width, true)
  view.setInt32(22, -height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 32, true)
  view.setUint32(30, 3, true)
  masks.forEach((mask, i) => view.setUint32(54 + i * 4, mask, true))
  rows.forEach((row, y) => row.forEach((word, x) => view.setUint32(offset + (y * width + x) * 4, word >>> 0, true)))
  return bytes
}
