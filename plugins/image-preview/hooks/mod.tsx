/**
 * image-preview — Claude Mod
 *
 * Hover a pasted `[Image #N]` to see the picture.
 *
 *   - the band above the prompt lists the draft's images as chips (`chip:N`); the prompt box is
 *     polled, as a paste changes it with no edit event
 *   - under a sent prompt the engine lists its images, one a row; an unpainted chip lies over each
 *     (`sent:N`), and over each `[Image #N]` on the prompt's first line (`token:N`)
 *   - the pointer on a chip opens its preview: in a popup by the pointer where the terminal cannot
 *     draw pictures, else a card floating over the transcript (or in the band, where too few rows
 *     show). A click opens the image in the system's viewer
 *   - the open preview lives in `$.state`; `rowHasPreview` makes only the rows it leaves and joins
 *     redraw, and a sent prompt with no image reads no image state, so no image load redraws it
 *
 * Files: `host` (OS, image store, converter, viewer), `image-cache` (reading each image, the
 * conversion only where the terminal draws it), `screen-layout` (rows on screen, where a preview
 * fits), `terminal-card` (the terminal's drawing), `bmp-decoder` and `cell-raster` (pixels into
 * cells), `popup-process` and `os-scripts` (the window by the pointer), `hover-target` (the client
 * module of the pointer targets). All `$.state` lives in this file: the engine's scan requires each
 * atom passed to `read`/`update` to be a const of the file that calls them, so the other modules
 * return values instead of writing state.
 *
 * Options (userConfig):
 *   window: boolean   use a popup where the terminal cannot draw pictures (default true); off, cells
 */
import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { renderCard } from './terminal-card'
import { NOT_STORED, forgetImages, imageFileOf, loadImage, needsLoading } from './image-cache'
import { closePopup, showPopup } from './popup-process'
import { detectPopupPlatform, detectTerminalImages, forgetSessionDir, openInViewer } from './host'
import type { Platform, TerminalImages } from './host'
import { ROW_COMPONENTS, ScreenLayout } from './screen-layout'
import type { RowEvent } from './screen-layout'
import type { ImageInfo, Placement, Preview } from '../types/plugin-state'

type Engine = EngineInterface

const draftImageIds = atom({ plugin: 'image-preview', key: 'draftImageIds' } as const, [] as number[])
const images = atom({ plugin: 'image-preview', key: 'images' } as const, {} as Record<string, ImageInfo>)
const preview = atom({ plugin: 'image-preview', key: 'preview' } as const, null as Preview | null)
const rowHasPreview = atom({ plugin: 'image-preview', key: 'rowHasPreview' } as const, false)

const IMAGE_TOKEN = /\[Image #(\d+)\]/g
// A pointer target's element: `chip:N` in the band, `sent:N` or `token:N` on a sent prompt.
const CHIP_ELEMENT = /^(chip|sent|token):(\d+)$/
const MAX_COLUMNS = 160
const MAX_ROWS = 48
// Under a sent prompt the engine lists its images, one a row, each after `  ⎿  `; the prompt's own
// first line starts after `❯ `, on the row after the blank one above it.
const LISTED_COLUMN = 5
const PROMPT_COLUMN = 2
const POLL_MS = 500

/** The ids of the `[Image #N]` placeholders in a text, each once, in order. */
export const imageIdsIn = (text: string) => [...new Set([...text.matchAll(IMAGE_TOKEN)].map(match => Number(match[1])))]

const sameIds = (a: readonly number[], b: readonly number[] = []) => a.length === b.length && a.every((id, i) => id === b[i])

/**
 * Set at session start. `terminalImages`: how the terminal draws a picture itself. `popup`: the OS
 * whose popup shows previews by the pointer; unset, the terminal draws them.
 */
const display: { terminalImages: TerminalImages; popup: Platform | undefined } = { terminalImages: 'none', popup: undefined }
const layout = new ScreenLayout()
let sessionId: string | undefined

/** Forgets what was read in another session: after /clear the ids start again from 1. */
async function followSession ($: Engine) {
  const id = await $.session.id()
  if (id === sessionId) return
  // The rows drawn so far are this session's, unless another came before it.
  if (sessionId !== undefined) layout.forget()
  sessionId = id
  forgetSessionDir()
  forgetImages()
  await update($, images, () => ({}))
  await setPreview($, () => null)
}

// A target is `<requestId>/<element>`: for a chip on a sent prompt, the requestId is the prompt's row.
const isOnSentPrompt = (target: string) => /\/(sent|token):/.test(target)

// A popup shows the file as it is: only a card the terminal draws needs the picture converted.
const needsDrawing = () => display.popup === undefined

/** Reads what is still to read of image `id`, in the background; the drawings that wait on it redraw. */
async function readImage ($: Engine, id: number) {
  const info = await loadImage($, id, display.terminalImages, needsDrawing())
  // A module unloaded meanwhile has no state to write to.
  if (info) await update($, images, all => ({ ...all, [id]: info })).catch(() => undefined)
}

/** Where the preview a target opens goes; null where it fits nowhere. */
function previewFor (imageId: number, target: string): Preview | null {
  if (display.popup) return { imageId, target, placement: { in: 'popup' } }
  if (!isOnSentPrompt(target)) return { imageId, target, placement: layout.placeForDraft() }
  const placement = layout.placeForSent(target.slice(0, target.indexOf('/')))
  return placement && { imageId, target, placement }
}

const closeDraftPreview = (now: Preview | null) => (now && !isOnSentPrompt(now.target) ? null : now)

const rowIdOf = (now: Preview | null) => (now?.placement.in === 'row' ? now.placement.rowId : null)

const samePlacement = (a: Placement, b: Placement) =>
  a.in === b.in && (a.in !== 'row' || (b.in === 'row' && a.rowId === b.rowId && a.maxRows === b.maxRows && a.anchor === b.anchor))

const samePreview = (a: Preview | null, b: Preview | null) =>
  a === b || (a !== null && b !== null && a.imageId === b.imageId && a.target === b.target && samePlacement(a.placement, b.placement))

let previewChanges = Promise.resolve()

/**
 * Opens, moves or closes (null) the preview, one change at a time, each `next` handed the preview
 * the one before left: the pointer leaving one chip and coming onto the next are two changes, in
 * either order. The row the preview leaves and the one it joins redraw.
 */
function setPreview ($: Engine, next: (now: Preview | null) => Preview | null) {
  const run = previewChanges.then(async () => {
    const last = await read($, preview)
    const to = next(last)
    if (samePreview(last, to)) return
    layout.markPreviewChanged()
    await update($, preview, () => to)
    const [left, joined] = [rowIdOf(last), rowIdOf(to)]
    if (left && left !== joined) await update($, memberOf(rowHasPreview, { requestId: left }), () => false)
    if (joined && joined !== left) await update($, memberOf(rowHasPreview, { requestId: joined }), () => true)
    if (to?.placement.in === 'popup') void runPopup($, to.imageId)
    else closePopup()
  })
  previewChanges = run.catch(() => undefined)
  return run
}

/** Shows the popup; where the system shows none, the terminal draws previews from then on. */
async function runPopup ($: Engine, imageId: number) {
  if (!display.popup || (await showPopup($, display.popup, imageId)) !== 'failed') return
  display.popup = undefined
  void readImage($, imageId)
  await setPreview($, now => (now?.placement.in === 'popup' ? previewFor(now.imageId, now.target) : now))
}

/**
 * Keeps the open preview in step with the layout. A band chip's preview follows the lowest row.
 * A sent prompt's chip moves with it, and one that moves from under a resting pointer says nothing:
 * its preview closes when anything moves (a move of the pointer opens it again).
 */
async function followTranscript ($: Engine) {
  layout.tick()
  await setPreview($, now => {
    if (!now) return null
    if (!isOnSentPrompt(now.target)) return previewFor(now.imageId, now.target)
    return layout.hasMovedSincePreviewChanged() ? null : now
  })
}

async function openImage ($: Engine, imageId: number) {
  const file = await imageFileOf($, imageId)
  if (file) await openInViewer($, file)
}

/** Keeps the band's chips in step with the prompt box, and reads the images in it. */
async function syncDraft ($: Engine, text: string) {
  await followSession($)
  const ids = imageIdsIn(text)
  if (!sameIds(ids, await read($, draftImageIds))) {
    await update($, draftImageIds, () => ids)
    await setPreview($, closeDraftPreview)
  }
  for (const id of ids) void readImage($, id)
}

/** A transcript row, with `overlays` and the preview where it holds it: out of the flow, so they move nothing. */
async function drawRow ($: Engine, e: RowEvent, drawn: RenderElement, overlays: RenderElement[] = []) {
  const now = (await read($, memberOf(rowHasPreview, e))) ? await read($, preview) : null
  const onScreen = e.props.onScreen
  const placement = now?.placement.in === 'row' && now.placement.rowId === e.requestId && onScreen ? now.placement : undefined
  if (!placement && overlays.length === 0) return drawn
  const ui = $.ui.resolve(e)
  const { Box } = ui
  let floating: RenderElement | undefined
  if (placement && now && onScreen) {
    const bounds = { columns: Math.max(8, Math.min(MAX_COLUMNS, (e.viewport?.columns ?? 80) - 4)), rows: Math.min(MAX_ROWS, placement.maxRows) }
    // On the last line of this row that shows (the rest are past the screen's edge), or ending on
    // its first, the blank line above a message.
    const bottom = placement.anchor === 'lastLine' ? onScreen.of - 1 - onScreen.last : onScreen.of - 1
    floating = (
      <Box key={`float-${now.imageId}`} position="absolute" bottom={bottom} left={0}>
        {renderCard(ui, (await read($, images))[now.imageId], now.imageId, bounds, display.terminalImages)}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {drawn}
      {overlays}
      {floating}
    </Box>
  )
}

/**
 * The chips over a sent prompt, unpainted, so the engine's rows show as they were. One over each
 * image the engine lists under it. And one over each `[Image #N]` on its first line, which also takes
 * the click (the listed rows take the pointer but leave the click to the engine): placed only where
 * its column can be told, before the line could wrap and after text one cell a character.
 */
function sentPromptChips ($: Engine, e: Extract<RowEvent, { component: 'UserMessage' }>, ids: number[], all: Record<string, ImageInfo>) {
  const { Box, Client } = $.ui.resolve(e)
  const chips: RenderElement[] = []
  // The engine lists the images it was sent in the order pasted: each one stored, read or not.
  const listed = ids.filter(id => { const info = all[id]; return info && !('error' in info && info.error === NOT_STORED) }).sort((a, b) => a - b)
  listed.forEach((id, i) => {
    if ('error' in all[id]!) return
    chips.push(
      <Box key={`listed-${id}`} position="absolute" bottom={-1 - i} left={LISTED_COLUMN}>
        <Client key={`sent:${id}`} module="./hover-target.tsx" width={`[Image #${id}]`.length} height={1} />
      </Box>
    )
  })
  const line = e.props.text.split('\n')[0]!
  const width = (e.viewport?.columns ?? 80) - 1
  const placed = new Set<number>()
  for (const match of line.matchAll(IMAGE_TOKEN)) {
    const id = Number(match[1])
    const column = PROMPT_COLUMN + match.index
    const info = all[id]
    const isReadable = !!info && !('error' in info)
    const isSingleWidth = /^[ -˿]*$/.test(line.slice(0, match.index))
    if (placed.has(id) || !isReadable || !isSingleWidth || column + match[0].length > width) continue
    placed.add(id)
    chips.push(
      <Box key={`token-${id}`} position="absolute" top={1} left={column}>
        <Client key={`token:${id}`} module="./hover-target.tsx" width={match[0].length} height={1} />
      </Box>
    )
  }
  return chips
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    display.terminalImages = await detectTerminalImages($)
    const wantsPopup = options.window !== false && display.terminalImages === 'none' && e.isInteractive
    display.popup = wantsPopup ? await detectPopupPlatform($) : undefined
    // A reload starts with empty caches: read again what is in the box.
    await followSession($)
    await syncDraft($, (await $.prompt.read()).text)
    if (e.isInteractive) {
      // A poll that fails (the module unloading under it) waits for the next.
      $.clock.every(POLL_MS, () => {
        void $.prompt.read().then(box => syncDraft($, box.text)).then(() => followTranscript($)).catch(() => undefined)
      })
    }
    return result
  })

  // Typing closes a band chip's preview: the box may grow and move the chip from under the pointer.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await setPreview($, closeDraftPreview)
    await syncDraft($, box.text)
    return box
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind !== 'composer') return result
    await update($, draftImageIds, () => [])
    await setPreview($, () => null)
    for (const id of imageIdsIn(e.text)) void readImage($, id)
    return result
  }).catch(($, e, next) => next(e))

  // A chip posts when the pointer comes onto it (or moves on it) and when it leaves, and when clicked.
  on('ui.message', async ($, e, next) => {
    const result = await next(e)
    const chip = CHIP_ELEMENT.exec(e.element)
    if (!chip) return result
    const imageId = Number(chip[2])
    const target = `${e.requestId}/${e.element}`
    const data = e.data as { isOver?: unknown; isClicked?: unknown } | null
    // Clicked, the image opens in its viewer, which a preview left open would stand over.
    if (data?.isClicked === true) {
      void openImage($, imageId)
      await setPreview($, () => null)
      return result
    }
    const isOver = data?.isOver === true
    await setPreview($, now => {
      if (!isOver) return now?.target === target ? null : now
      return now?.target === target ? now : previewFor(imageId, target)
    })
    return result
  })

  // Every transcript row is recorded in one hook, so rows redrawn together (as after a reload) are
  // recorded in the transcript's order.
  on('ui.render', { component: [...ROW_COMPONENTS] }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.viewport?.isFullscreen === false) return next(e)
    layout.record(e)
    if (e.component !== 'UserMessage') return drawRow($, e, await next(e))
    const ids = e.props.origin.kind === 'composer' ? imageIdsIn(e.props.text) : []
    // A prompt with no image reads no image state, so an image read elsewhere never redraws it.
    if (ids.length === 0) return drawRow($, e, await next(e))
    const all = await read($, images)
    for (const id of ids) if (needsLoading(all[id], needsDrawing())) void readImage($, id)
    const drawn = await next(e)
    return drawRow($, e, drawn, sentPromptChips($, e, ids, all))
  })

  // Above the prompt: the draft's chips, and the preview where the band holds it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Off fullscreen the terminal reports no pointer: nothing could be hovered.
    if (e.surface !== 'terminal' || e.props.hasSurvey || e.viewport?.isFullscreen === false) return next(e)
    const ids = await read($, draftImageIds)
    const now = await read($, preview)
    const inBand = now?.placement.in === 'band' ? now.imageId : undefined
    if (ids.length === 0 && inBand === undefined) return next(e)
    if (e.viewport) layout.screenRows = e.viewport.rows

    const ui = $.ui.resolve(e)
    const { Box, Client, Text } = ui
    const below: RenderElement = await next(e)
    const bounds = {
      columns: Math.max(8, Math.min(MAX_COLUMNS, e.props.bodyColumns)),
      rows: Math.max(4, Math.min(MAX_ROWS, e.props.maxRows - 1))
    }
    return (
      <Box flexDirection="column">
        {below}
        {inBand !== undefined && renderCard(ui, (await read($, images))[inBand], inBand, bounds, display.terminalImages)}
        {ids.length > 0 && (
          <Box flexDirection="row" columnGap={1}>
            {ids.map(id => <Client key={`chip:${id}`} module="./hover-target.tsx" props={{ label: `[Image #${id}]` }} />)}
            <Text dimColor>hover to preview · click to open</Text>
          </Box>
        )}
      </Box>
    )
  })
}
