// Reads the BMP the converters write into the RGBA pixels the cells are sampled from.
/** A picture decoded to 8-bit RGBA, row-major from the top-left pixel. */
export type Pixels = { width: number; height: number; data: Uint8Array }

/** The lowest set bit of a channel mask, and how many bits wide the channel is. */
function channelOf (mask: number) {
  if (mask === 0) return null
  let shift = 0
  while (((mask >>> shift) & 1) === 0) shift++
  let bits = 0
  while (((mask >>> (shift + bits)) & 1) === 1) bits++
  return { shift, max: 2 ** bits - 1 }
}

/** Reads an uncompressed 24- or 32-bit BMP, the kind `sips` and ImageMagick write. */
export function decodeBmp (bytes: Uint8Array): Pixels {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('not a BMP file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = view.getUint32(10, true)
  const headerSize = view.getUint32(14, true)
  const width = view.getInt32(18, true)
  const signedHeight = view.getInt32(22, true)
  const bits = view.getUint16(28, true)
  const compression = view.getUint32(30, true)
  const height = Math.abs(signedHeight)

  if (width <= 0 || height === 0) throw new Error('an empty BMP')
  if (bits !== 24 && bits !== 32) throw new Error(`a ${bits}-bit BMP`)
  if (compression !== 0 && compression !== 3) throw new Error('a compressed BMP')

  const stride = Math.ceil((width * bits) / 32) * 4
  if (offset + stride * height > bytes.length) throw new Error('a truncated BMP')

  // BI_BITFIELDS keeps its masks right after the 40-byte header, or inside a longer one.
  const masks = compression === 3
    ? [54, 58, 62, 66].map(at => (at === 66 && headerSize < 56) || at + 4 > bytes.length ? 0 : view.getUint32(at, true))
    : bits === 32 ? [0xff0000, 0xff00, 0xff, 0xff000000] : null
  const channels = masks?.map(channelOf)

  const data = new Uint8Array(width * height * 4)
  // Each channel a whole byte of the pixel (as sips and ImageMagick write): copied, not scaled.
  const byteOf = channels?.map(channel => (!channel ? -1 : channel.max === 255 && channel.shift % 8 === 0 ? channel.shift / 8 : undefined))
  const isByteAligned = !!byteOf && byteOf.every(at => at !== undefined)
  const [r, g, b, a] = isByteAligned ? (byteOf as number[]) : [0, 0, 0, 0]
  let hasAlpha = false
  for (let y = 0; y < height; y++) {
    const start = offset + (signedHeight < 0 ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4
      if (isByteAligned) {
        const at = start + x * 4
        data[out] = r! < 0 ? 255 : bytes[at + r!]!
        data[out + 1] = g! < 0 ? 255 : bytes[at + g!]!
        data[out + 2] = b! < 0 ? 255 : bytes[at + b!]!
        data[out + 3] = a! < 0 ? 255 : bytes[at + a!]!
        if (data[out + 3] !== 0) hasAlpha = true
      } else if (channels) {
        const value = view.getUint32(start + x * 4, true)
        for (let c = 0; c < 4; c++) {
          const channel = channels[c]
          data[out + c] = channel ? Math.round((((value >>> channel.shift) & channel.max) * 255) / channel.max) : 255
        }
        if (data[out + 3] !== 0) hasAlpha = true
      } else {
        const at = start + x * 3
        data[out] = bytes[at + 2]!
        data[out + 1] = bytes[at + 1]!
        data[out + 2] = bytes[at]!
        data[out + 3] = 255
      }
    }
  }
  // A writer that leaves the alpha byte unused fills it with zeros: the picture is opaque.
  if (channels && !hasAlpha) for (let i = 3; i < data.length; i += 4) data[i] = 255

  return { width, height, data }
}
