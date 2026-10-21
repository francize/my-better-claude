// Reads each pasted image a session, in two stages, each once:
//   - its file, format and size: all a popup needs, read with no converter run
//   - only where the terminal draws the card: its pixels for the cells, and the PNG a terminal that
//     draws pictures is given. This converts the picture and reads it back, the costly part
import type { EngineInterface } from 'claude-code'

import { decodeBmp } from './bmp-decoder'
import type { Pixels } from './bmp-decoder'
import { rasterize } from './cell-raster'
import { convertImage, findImageFile, makeDir, sessionDirOf } from './host'
import type { TerminalImages } from './host'
import type { Drawing, ImageInfo } from '../types/plugin-state'

type Engine = EngineInterface

export const NOT_STORED = 'not stored in this session'

// The longest side a picture is shrunk to before it is sampled into cells, eight points a cell across.
const SAMPLE_PIXELS = 800
// The longest side of the PNG a terminal is sent to draw itself, and the most bytes it may take.
const BYTES_PIXELS = 1024
const BYTES_MAX = 2 * 1024 * 1024
// The engine writes the file just after the paste puts the placeholder in the box: wait this long for it.
const STORE_WAIT_MS = 200
const STORE_WAIT_TRIES = 15

const infos = new Map<number, ImageInfo>()
const decoded = new Map<number, Pixels>()
const loading = new Set<number>()
// Found but not drawable: the file and the converters do not change, so it is not tried again.
const unreadable = new Set<number>()
// The base64 PNG sent to a terminal that takes bytes, by id.
const pngBytes = new Map<number, string>()
// The cells drawn of each picture, by `<id>:<columns>x<rows>`.
const rasters = new Map<string, string>()

/** After /clear the ids start again from 1: forget the last session's images. */
export function forgetImages () {
  infos.clear()
  decoded.clear()
  unreadable.clear()
  pngBytes.clear()
  rasters.clear()
}

export const isDecoded = (id: number) => decoded.has(id)
export const pngBytesOf = (id: number) => pngBytes.get(id)

/** Image `id` as `columns × rows` cells, drawn once a size. */
export function rasterOf (id: number, columns: number, rows: number) {
  const key = `${id}:${columns}x${rows}`
  let cells = rasters.get(key)
  if (cells === undefined) {
    cells = rasterize(decoded.get(id)!, columns, rows)
    rasters.set(key, cells)
  }
  return cells
}

/** The stored file of image `id`: as read, or looked for. */
export async function imageFileOf ($: Engine, id: number) {
  const info = infos.get(id)
  return info && !('error' in info) ? info.file : await findImageFile($, id)
}

/** Whether `loadImage` has more to read of an image whose info is `info`. */
export const needsLoading = (info: ImageInfo | undefined, needsDrawing: boolean) =>
  !info || (needsDrawing && !('error' in info) && !info.drawing)

async function waitForFile ($: Engine, id: number) {
  let file = await findImageFile($, id)
  for (let tries = 0; !file && tries < STORE_WAIT_TRIES; tries++) {
    await $.clock.sleep(STORE_WAIT_MS)
    file = await findImageFile($, id)
  }
  return file
}

async function readInfo ($: Engine, id: number): Promise<ImageInfo> {
  const file = await waitForFile($, id)
  if (!file) return { error: NOT_STORED }
  const { size } = await $.fs.stat(file)
  return { file, format: file.slice(file.lastIndexOf('.') + 1), bytes: size }
}

async function decode ($: Engine, file: string, out: string) {
  if (!(await convertImage($, file, out, 'bmp', { side: SAMPLE_PIXELS, onlyShrink: false }))) {
    throw new Error('needs sips (macOS), ImageMagick or PowerShell (Windows) to read it')
  }
  const { base64 } = await $.fs.read(out, { as: 'bytes' })
  return decodeBmp(Uint8Array.fromBase64(base64))
}

/** A PNG a terminal that reads files can draw: the file itself, or a copy. */
async function pngFileOf ($: Engine, file: string, out: string) {
  if (file.endsWith('.png')) return file
  return (await convertImage($, file, out, 'png')) ? out : undefined
}

/** The picture shrunk to a PNG, base64, for a terminal that takes bytes: none past what one may take. */
async function pngBytesFor ($: Engine, file: string, out: string) {
  const isConverted = await convertImage($, file, out, 'png', { side: BYTES_PIXELS, onlyShrink: true })
  if (!isConverted || (await $.fs.stat(out)).size > BYTES_MAX) return undefined
  return (await $.fs.read(out, { as: 'bytes' })).base64
}

type Drawn = { drawing: Drawing; pixels: Pixels; bytes?: string }

async function readDrawing ($: Engine, id: number, file: string, terminalImages: TerminalImages): Promise<Drawn> {
  const cache = `${await sessionDirOf($)}/image-preview`
  await makeDir($, cache)
  const pixels = await decode($, file, `${cache}/${id}.bmp`)
  let png: string | undefined
  let bytes: string | undefined
  if (terminalImages === 'file') png = await pngFileOf($, file, `${cache}/${id}.png`)
  if (terminalImages === 'bytes') {
    bytes = await pngBytesFor($, file, `${cache}/${id}.view.png`)
    if (bytes) png = `${cache}/${id}.view.png`
  }
  return { drawing: { width: pixels.width, height: pixels.height, ...(png && { png }) }, pixels, bytes }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Reads what is still to read of image `id`: its info, then, with `needsDrawing`, what the terminal
 * draws it from. Resolves the new info, or undefined where there is nothing new: nothing was left
 * to read, it is being read, or the session changed meanwhile.
 */
export async function loadImage ($: Engine, id: number, terminalImages: TerminalImages, needsDrawing: boolean): Promise<ImageInfo | undefined> {
  if (loading.has(id) || unreadable.has(id) || !needsLoading(infos.get(id), needsDrawing)) return undefined
  loading.add(id)
  const session = await $.session.id().catch(() => undefined)
  let info: ImageInfo
  let drawn: Drawn | undefined
  try {
    info = infos.get(id) ?? (await readInfo($, id))
    if (needsDrawing && !('error' in info)) {
      drawn = await readDrawing($, id, info.file, terminalImages)
      info = { ...info, drawing: drawn.drawing }
    }
  } catch (error) {
    info = { error: messageOf(error) }
  } finally {
    loading.delete(id)
  }
  // A /clear while it was read: the new session's ids start again from 1, so this one is not its.
  if ((await $.session.id().catch(() => undefined)) !== session) return undefined
  // One not stored yet may be stored later: it is looked for again.
  if ('error' in info && info.error === NOT_STORED) return info
  infos.set(id, info)
  if ('error' in info) unreadable.add(id)
  if (drawn) {
    decoded.set(id, drawn.pixels)
    if (drawn.bytes) pngBytes.set(id, drawn.bytes)
  }
  return info
}
