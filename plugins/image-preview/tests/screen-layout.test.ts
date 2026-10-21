// Run with: claude plugin test plugins/image-preview
import { expect, test } from 'claude-code/testing'

import { ScreenLayout } from '../hooks/screen-layout'
import type { OnScreen, RowEvent } from '../hooks/screen-layout'

type Component = RowEvent['component']

/** A drawn row as the engine reports it: just what the transcript reads. */
const row = (requestId: string, onScreen: OnScreen | null, component: Component = 'AssistantMessage', rows = 40) =>
  ({ requestId, component, surface: 'terminal', props: { onScreen }, viewport: { columns: 120, rows, isFullscreen: true } }) as unknown as RowEvent

/** A transcript past its startup batch, so each row recorded now is a new one in place. */
function running () {
  const transcript = new ScreenLayout()
  transcript.tick()
  transcript.tick()
  return transcript
}

const lines = (count: number): OnScreen => ({ first: 0, last: count - 1, of: count })

test('with no rows on screen a band chip\'s preview stays in the band', () => {
  expect(running().placeForDraft()).toEqual({ in: 'band' })
})

test('over a screen-filling transcript a band chip\'s preview stands on the lowest row, one row kept free', () => {
  const transcript = running()
  transcript.record(row('a-1', lines(20)))
  transcript.record(row('a-2', null))
  transcript.record(row('a-3', lines(4)))
  expect(transcript.placeForDraft()).toEqual({ in: 'row', rowId: 'a-3', maxRows: 40 - 7 - 1, anchor: 'lastLine' })
})

test('a short transcript counts its rows and the logo\'s: under ten, the band holds the preview', () => {
  const nine = running()
  nine.record(row('a-1', lines(6)))
  expect(nine.placeForDraft()).toEqual({ in: 'band' })
  const ten = running()
  ten.record(row('a-1', lines(7)))
  expect(ten.placeForDraft()).toEqual({ in: 'row', rowId: 'a-1', maxRows: 10, anchor: 'lastLine' })
})

test('a sent prompt not on screen places nothing', () => {
  const transcript = running()
  transcript.record(row('a-1', lines(10)))
  expect(transcript.placeForSent('m-9')).toBeNull()
})

test('a sent prompt with more rows above it places its preview just above its first line', () => {
  const transcript = running()
  transcript.record(row('a-0', lines(15)))
  transcript.record(row('m-1', lines(3), 'UserMessage'))
  transcript.record(row('a-1', lines(4)))
  expect(transcript.placeForSent('m-1')).toEqual({ in: 'row', rowId: 'm-1', maxRows: 15 + 4 + 1, anchor: 'aboveFirstLine' })
})

test('a sent prompt with more rows under it places its preview on the lowest row', () => {
  const transcript = running()
  transcript.record(row('a-0', null))
  transcript.record(row('m-1', lines(3), 'UserMessage'))
  transcript.record(row('a-1', lines(20)))
  expect(transcript.placeForSent('m-1')).toEqual({ in: 'row', rowId: 'a-1', maxRows: 20, anchor: 'lastLine' })
})

test('a sent prompt cut at the top has no room above it', () => {
  const transcript = running()
  transcript.record(row('m-1', { first: 2, last: 4, of: 5 }, 'UserMessage'))
  transcript.record(row('a-1', lines(8)))
  expect(transcript.placeForSent('m-1')).toEqual({ in: 'row', rowId: 'a-1', maxRows: 8, anchor: 'lastLine' })
})

test('a sent prompt with fewer than six rows either side places nothing', () => {
  const transcript = running()
  transcript.record(row('a-0', null))
  transcript.record(row('m-1', lines(3), 'UserMessage'))
  transcript.record(row('a-1', lines(5)))
  expect(transcript.placeForSent('m-1')).toBeNull()
})

test('the startup batch puts each prompt back at the start of its turn', () => {
  const transcript = new ScreenLayout()
  transcript.record(row('m-1', lines(2), 'UserMessage'))
  transcript.record(row('m-2', lines(2), 'UserMessage'))
  transcript.record(row('i-1', lines(1), 'InfoNotice'))
  transcript.record(row('a-1', lines(2)))
  transcript.record(row('t-1', lines(1), 'TurnDuration'))
  transcript.record(row('a-2', lines(2)))
  const order = transcript.order()
  expect([...order.keys()].sort((a, b) => order.get(a)! - order.get(b)!)).toEqual(['i-1', 'm-1', 'a-1', 't-1', 'm-2', 'a-2'])
})

test('a startup batch of prompts alone keeps them in the order drawn', () => {
  const transcript = new ScreenLayout()
  transcript.record(row('m-1', lines(2), 'UserMessage'))
  transcript.record(row('m-2', lines(2), 'UserMessage'))
  expect([...transcript.order()]).toEqual([['m-1', 0], ['m-2', 1]])
})

test('a poll with no row drawn since the last ends the startup batch: later rows follow in the order drawn', () => {
  const transcript = new ScreenLayout()
  transcript.record(row('a-1', lines(2)))
  transcript.tick()
  transcript.tick()
  transcript.record(row('m-1', lines(2), 'UserMessage'))
  transcript.record(row('a-2', lines(2)))
  const order = transcript.order()
  expect(order.get('a-1')! < order.get('m-1')! && order.get('m-1')! < order.get('a-2')!).toBe(true)
})

test('the transcript has moved since the preview changed once a row is added or its lines change, not when redrawn the same', () => {
  const transcript = running()
  transcript.record(row('a-1', lines(4)))
  transcript.markPreviewChanged()
  transcript.record(row('a-1', lines(4)))
  expect(transcript.hasMovedSincePreviewChanged()).toBe(false)
  transcript.record(row('a-1', { first: 1, last: 3, of: 4 }))
  expect(transcript.hasMovedSincePreviewChanged()).toBe(true)
  transcript.markPreviewChanged()
  transcript.record(row('a-2', lines(1)))
  expect(transcript.hasMovedSincePreviewChanged()).toBe(true)
})

test('the screen height is the last drawing\'s, and forgetting clears the rows', () => {
  const transcript = running()
  transcript.record(row('a-1', lines(20), 'AssistantMessage', 30))
  expect(transcript.screenRows).toBe(30)
  expect(transcript.placeForDraft()).toEqual({ in: 'row', rowId: 'a-1', maxRows: 30 - 7 - 1, anchor: 'lastLine' })
  transcript.forget()
  expect(transcript.placeForDraft()).toEqual({ in: 'band' })
})
