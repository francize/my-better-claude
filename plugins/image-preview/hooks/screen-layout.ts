// What the mod knows of the transcript on screen, from what each row says of itself as it is drawn,
// and where a preview fits over it. A preview never covers the chip that opened it, and covers only
// rows drawn before the one it is attached to (a row drawn after paints over it).
import type { EventOf } from 'claude-code'

import type { Placement } from '../types/plugin-state'

type RenderOf<C extends string> = Extract<EventOf['ui.render'], { component: C; surface: 'terminal' }>

export const ROW_COMPONENTS = ['UserMessage', 'AssistantMessage', 'ToolUse', 'ToolResult', 'ToolGroup', 'CommandOutput', 'TurnDuration', 'InfoNotice'] as const
export type RowEvent = RenderOf<(typeof ROW_COMPONENTS)[number]>
export type OnScreen = NonNullable<RowEvent['props']['onScreen']>

// What the screen keeps under the transcript (the band's row, the prompt and its lines), and above
// its first row (the logo).
const BOTTOM_ROWS = 7
const HEADER_ROWS = 4
// The fewest rows a preview is worth floating in: from the band's chips, and from a sent prompt's.
const MIN_DRAFT_ROWS = 10
const MIN_SENT_ROWS = 6

type TrackedRow = { component: RowEvent['component']; drawOrder: number; inStartupBatch: boolean; onScreen: OnScreen | null | undefined }
type VisibleRow = { rowId: string; order: number; onScreen: OnScreen }

const sameLines = (a: OnScreen | null | undefined, b: OnScreen | null | undefined) =>
  a?.first === b?.first && a?.last === b?.last && a?.of === b?.of

const lineCount = (rows: VisibleRow[]) => rows.reduce((sum, row) => sum + row.onScreen.last - row.onScreen.first + 1, 0)

export class ScreenLayout {
  /** The screen's height, as the last drawing said. */
  screenRows = 40
  private rows = new Map<string, TrackedRow>()
  private drawCount = 0
  private drawCountAtLastTick = 0
  // The module loads as the session starts or reloads, and the engine draws every row right after.
  private inStartupBatch = true
  // Bumped each time a row is added or moves; and its value when the preview last changed.
  private layoutVersion = 0
  private layoutVersionAtPreview = 0

  /** Notes a drawn row. Called before anything is awaited, so rows are noted in the order drawn. */
  record (e: RowEvent) {
    if (e.viewport) this.screenRows = e.viewport.rows
    const onScreen = e.props.onScreen
    const row = this.rows.get(e.requestId)
    if (!row) {
      this.rows.set(e.requestId, { component: e.component, drawOrder: this.drawCount++, inStartupBatch: this.inStartupBatch, onScreen })
      this.layoutVersion++
    } else if (!sameLines(row.onScreen, onScreen)) {
      row.onScreen = onScreen
      this.layoutVersion++
    }
  }

  forget () {
    this.rows.clear()
  }

  /** Called on each poll: a poll with no row drawn since the last ends the startup batch. */
  tick () {
    if (this.drawCount === this.drawCountAtLastTick) this.inStartupBatch = false
    this.drawCountAtLastTick = this.drawCount
  }

  markPreviewChanged () {
    this.layoutVersionAtPreview = this.layoutVersion
  }

  hasMovedSincePreviewChanged () {
    return this.layoutVersion !== this.layoutVersionAtPreview
  }

  /**
   * Each row's place in the transcript, as best known. A row drawn as it came is in place. The batch
   * a start or a reload draws comes in two runs, the sent prompts apart from the rest (each run in
   * order): each prompt is put back at the start of a turn, the row after a turn's duration line,
   * the newest prompt at the newest turn.
   */
  order () {
    const batch = [...this.rows].filter(([, row]) => row.inStartupBatch).sort((a, b) => a[1].drawOrder - b[1].drawOrder)
    const notices = batch.filter(([, row]) => row.component === 'InfoNotice')
    const prompts = batch.filter(([, row]) => row.component === 'UserMessage')
    const others = batch.filter(([, row]) => row.component !== 'InfoNotice' && row.component !== 'UserMessage')
    const turnStarts = [0, ...others.flatMap(([, row], i) => (row.component === 'TurnDuration' && i + 1 < others.length ? [i + 1] : []))]
    const promptsBefore = new Map<number, string[]>()
    prompts.forEach(([rowId], i) => {
      const at = turnStarts[Math.max(0, turnStarts.length - (prompts.length - i))]!
      promptsBefore.set(at, [...(promptsBefore.get(at) ?? []), rowId])
    })
    const ordered = [...notices.map(([rowId]) => rowId), ...others.flatMap(([rowId], i) => [...(promptsBefore.get(i) ?? []), rowId])]
    if (others.length === 0) ordered.push(...prompts.map(([rowId]) => rowId))
    const order = new Map(ordered.map((rowId, i) => [rowId, i]))
    for (const [rowId, row] of this.rows) if (!row.inStartupBatch) order.set(rowId, ordered.length + row.drawOrder)
    return order
  }

  /** The rows on screen, top first. */
  private visibleRows (): VisibleRow[] {
    const order = this.order()
    const visible = [...this.rows]
      .filter(([, row]) => !!row.onScreen)
      .map(([rowId, row]) => ({ rowId, order: order.get(rowId)!, onScreen: row.onScreen! }))
    // A row first drawn late (as one scrolled into view) still has its place where it is cut: the row
    // cut at the top is the first on screen, the one cut at the foot the last.
    const rank = ({ order, onScreen }: VisibleRow) => (onScreen.first > 0 ? -Infinity : onScreen.last < onScreen.of - 1 ? Infinity : order)
    return visible.sort((a, b) => rank(a) - rank(b) || a.order - b.order)
  }

  // A row off the screen, or the first on it cut, is a transcript that fills the screen.
  private fillsScreen (visible: VisibleRow[]) {
    const top = visible[0]
    return top !== undefined && (top.onScreen.first > 0 || [...this.rows.values()].some(row => row.onScreen === null))
  }

  /**
   * For a chip in the band: over the rows above the end of the lowest row on screen; in the band
   * itself where too few rows show. The rows counted are the rows the mod knows of, so a count is
   * never too high.
   */
  placeForDraft (): Placement {
    const visible = this.visibleRows()
    const room = this.screenRows - BOTTOM_ROWS
    const lowest = visible.at(-1)
    // One row kept free: the count of the rows above is a guess.
    const above = !lowest ? 0 : (this.fillsScreen(visible) ? room : Math.min(room, HEADER_ROWS + lineCount(visible))) - 1
    return lowest && above >= MIN_DRAFT_ROWS ? { in: 'row', rowId: lowest.rowId, maxRows: above, anchor: 'lastLine' } : { in: 'band' }
  }

  /**
   * For a chip under sent prompt `promptRowId`: over the rows above the prompt, or over those under
   * its image list, whichever holds more; null where neither holds a preview.
   */
  placeForSent (promptRowId: string): Placement | null {
    const visible = this.visibleRows()
    const at = visible.findIndex(row => row.rowId === promptRowId)
    if (at === -1) return null
    const room = this.screenRows - BOTTOM_ROWS
    const prompt = visible[at]!.onScreen
    // Above: the rows before it that show, the logo's in a short transcript, and its own blank first row.
    const above = prompt.first > 0 ? 0 : Math.min(room, lineCount(visible.slice(0, at)) + (this.fillsScreen(visible) ? 0 : HEADER_ROWS) + 1)
    // Under: the rows after it, between its list and the foot of the lowest.
    const under = Math.min(room, lineCount(visible.slice(at + 1)))
    if (Math.max(above, under) < MIN_SENT_ROWS) return null
    return above >= under
      ? { in: 'row', rowId: promptRowId, maxRows: above, anchor: 'aboveFirstLine' }
      : { in: 'row', rowId: visible.at(-1)!.rowId, maxRows: under, anchor: 'lastLine' }
  }
}
