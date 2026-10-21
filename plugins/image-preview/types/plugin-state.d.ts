/** What the terminal draws an image from: its size in pixels, and a PNG for a terminal that draws pictures. */
export type Drawing = { width: number; height: number; png?: string }

/**
 * A pasted image as the mod read it: its file, format and size, and once the terminal is to draw
 * it, its drawing; or why it has no preview.
 */
export type ImageInfo =
  | { file: string; format: string; bytes: number; drawing?: Drawing }
  | { error: string }

/**
 * Where the open preview is drawn:
 * - `popup`: a window of its own by the pointer, outside the terminal
 * - `band`: inside the band above the prompt
 * - `row`: floating over the transcript, attached to row `rowId` (a `requestId`) and at most `maxRows`
 *   tall; `lastLine` stands on that row's last line on screen, `aboveFirstLine` ends just above its first
 */
export type Placement =
  | { in: 'popup' }
  | { in: 'band' }
  | { in: 'row'; rowId: string; maxRows: number; anchor: 'lastLine' | 'aboveFirstLine' }

/** The preview the pointer has open: its image, the pointer target that opened it (`<requestId>/<element>`), and where it is drawn. */
export type Preview = { imageId: number; target: string; placement: Placement }

declare module 'claude-code' {
  interface PluginState {
    'image-preview': {
      /** The `[Image #N]` ids in the prompt box, in the order typed. */
      draftImageIds: number[]
      /** Each image read so far, by id. */
      images: Record<string, ImageInfo>
      /** The open preview; null while none is. */
      preview: Preview | null
      /** Whether a transcript row, by its `requestId`, draws the preview: so only the rows it leaves and joins redraw. */
      rowHasPreview: StateFamily<boolean>
    }
  }
}
