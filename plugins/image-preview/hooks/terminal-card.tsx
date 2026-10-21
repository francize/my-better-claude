// The card drawn in the terminal: the picture in a rounded border, its caption under it.
import type { Elements } from 'claude-code'

import { fitCells } from './cell-raster'
import { isDecoded, pngBytesOf, rasterOf } from './image-cache'
import type { TerminalImages } from './host'
import type { ImageInfo } from '../types/plugin-state'

export type Bounds = { columns: number; rows: number }

// What a card adds around the picture: the border, and the caption under it.
const FRAME_COLUMNS = 2
const FRAME_ROWS = 3

// Rounded to KB first, so a size just under a megabyte reads `1.0 MB`, not `1024 KB`.
export const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : Math.round(bytes / 1024) < 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * Image `id` in a card as large as `bounds` allow. It floats over the transcript, which shows
 * through any cell it leaves unwritten: every line is written to the card's width, spaces and all.
 */
export function renderCard ({ Box, Image, Raster, Text }: Elements['terminal'], info: ImageInfo | undefined, id: number, bounds: Bounds, terminalImages: TerminalImages) {
  const label = `[Image #${id}]`
  const line = (text: string, width: number) => <Text dimColor wrap="truncate-end">{text.padEnd(width)}</Text>
  if (info && 'error' in info) return line(`${label} no preview: ${info.error}`, bounds.columns)
  if (!info?.drawing || !isDecoded(id)) return line(`${label} loading…`, bounds.columns)

  const { width: pixelWidth, height: pixelHeight, png } = info.drawing
  const { columns, rows } = fitCells(pixelWidth, pixelHeight, bounds.columns - FRAME_COLUMNS, bounds.rows - FRAME_ROWS)
  const bytes = pngBytesOf(id)
  const source = !png ? undefined : terminalImages === 'file' ? { file: png, format: 'png' as const } : bytes && { png: bytes }
  const caption = `${label} ${info.format.toUpperCase()} · ${formatSize(info.bytes)}`
  // A picture narrower than its caption is centered, the rows beside it written blank.
  const width = Math.max(columns, Math.min(caption.length, bounds.columns - FRAME_COLUMNS))
  const blank = (n: number) => n > 0 && <Text>{Array.from({ length: rows }, () => ' '.repeat(n)).join('\n')}</Text>
  const left = Math.floor((width - columns) / 2)
  return (
    <Box key={`card-${id}`} flexDirection="column" borderStyle="round" borderDimColor flexShrink={0} width={width + FRAME_COLUMNS}>
      <Box flexDirection="row">
        {blank(left)}
        {source
          ? <Image key={`image-${id}`} source={source} columns={columns} rows={rows} alt={label} />
          : <Raster key={`image-${id}`} columns={columns} rows={rows} cells={rasterOf(id, columns, rows)} />}
        {blank(width - columns - left)}
      </Box>
      {line(caption, width)}
    </Box>
  )
}
