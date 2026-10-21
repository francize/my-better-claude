// Run with: claude plugin test plugins/queue
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { add, decide, EMPTY, normalize, oneLine, remove, settle, take } from '../hooks/queue.ts'

const SURFACES = ['terminal', 'desktop'] as const
const BAND = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

/** Everything beneath the mod, answered from memory. */
function world (on: On) {
  const clock = mock.clock(on, { now: 1_000 })
  const store: Record<string, unknown> = {}
  const sent: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const aborted: string[] = []
  const box = { text: '' }
  const listed: { name: string; description: string; source: 'user' | 'plugin'; isFullscreen: boolean }[] = []
  const refuse = { next: undefined as string | undefined }
  // While on, the engine holds what is submitted (a `!` shell command runs) until released
  const hold = { on: false }
  const held: { text: string; resolve: (result: { text: string } | { drop: string }) => void }[] = []

  on('session.id', () => ({ value: 's1' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.abort', ($, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: listed }))
  on('command.run', () => ({ text: 'no plugin answered' }))
  on('prompt.submit', ($, e) => {
    if (hold.on) return new Promise(resolve => held.push({ text: e.text, resolve }))
    if (refuse.next) {
      const drop = refuse.next
      refuse.next = undefined
      return { drop }
    }
    sent.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', ($, e) => {
    box.text = e.mode === 'replace' ? e.text : box.text + e.text
    return { isFilled: true }
  })
  on('store.get', ($, e) => ({ value: store[e.key] }))
  on('store.set', ($, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  // What the engine draws where the mod draws nothing
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })

  type Stored = { items?: { text: string }[]; sending?: { text: string } | null }
  const queued = () => ((store['queue:s1'] as Stored | undefined)?.items ?? []).map(item => item.text)
  const sending = () => (store['queue:s1'] as Stored | undefined)?.sending?.text ?? null
  return { clock, store, sent, toasts, logs, aborted, box, listed, refuse, hold, held, queued, sending }
}

const start = ($: Engine) => $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
const turnStart = ($: Engine, turnId = 't1') => $.turn.start({ text: 'work', turnId })
const turnEnd = ($: Engine, reason: 'answer' | 'aborted' | 'error' = 'answer', turnId = 't1') =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId, reason } as never)
/** The person's Enter at the prompt; mid-turn when `turnId` is given. */
const enter = ($: Engine, text: string, extra: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra } as never)
const slash = ($: Engine, args: string) => $.command.run({
  command: 'queue',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as never)
const band = ($: Engine, surface: (typeof SURFACES)[number], props: Partial<typeof BAND> = {}) =>
  $.ui.mount({ plugin: 'queue', surface, component: 'AbovePrompt', props: { ...BAND, ...props } })

describe('the queue, as pure operations', () => {
  test('add appends with a fresh id; blank text queues nothing', () => {
    const one = add(EMPTY, ' hi ')
    expect(one.item).toEqual({ id: 1, text: 'hi' })
    expect(add(one.queue, 'there').queue.items.map(item => item.id)).toEqual([1, 2])
    expect(add(EMPTY, '   ').item).toBeNull()
  })

  test('remove takes out one prompt', () => {
    const q = add(add(EMPTY, 'a').queue, 'b').queue
    expect(remove(q, 1).queue.items.map(item => item.text)).toEqual(['b'])
    expect(remove(q, 9).item).toBeNull()
  })

  test('take hands over one prompt at a time; settle clears it or puts it back in front', () => {
    const q = add(add(add(EMPTY, 'a').queue, 'b').queue, 'c').queue
    const first = take(q)
    expect(first.item?.text).toBe('a')
    expect(first.queue.sending?.text).toBe('a')
    expect(take(first.queue).item).toBeNull()
    expect(take(first.queue, 2).item).toBeNull()
    expect(settle(first.queue, first.item!, true)).toEqual({ ...first.queue, sending: null })
    const refused = settle(first.queue, first.item!, false)
    expect(refused.items.map(item => item.text)).toEqual(['a', 'b', 'c'])
    expect(refused.sending).toBeNull()
    expect(settle(q, first.item!, false)).toBe(q)
    expect(take(q, 3).item?.text).toBe('c')
    expect(take(EMPTY).item).toBeNull()
  })

  test('normalize repairs a stored queue, puts a sending prompt back in front, never reuses an id', () => {
    expect(normalize(undefined)).toEqual(EMPTY)
    expect(normalize({ items: [{ id: 4, text: 'x' }, { id: 'bad' }], nextId: 2 }))
      .toEqual({ items: [{ id: 4, text: 'x' }], sending: null, nextId: 5 })
    expect(normalize({ items: [{ id: 2, text: 'b' }], sending: { id: 1, text: 'a' }, nextId: 3 }).items.map(item => item.text))
      .toEqual(['a', 'b'])
  })

  test('decide queues only the person’s Enter over a running turn', () => {
    const typed = { turnId: 't1', wait: false, origin: { kind: 'composer' } }
    expect(decide(typed, true)).toBe('queue')
    expect(decide({ ...typed, turnId: undefined }, true)).toBe('pass')
    expect(decide({ ...typed, origin: { kind: 'peer' } }, true)).toBe('pass')
    expect(decide({ ...typed, command: { name: 'x', args: '' } }, true)).toBe('pass')
    expect(decide({ ...typed, isMeta: true }, true)).toBe('pass')
    expect(decide({ ...typed, attachments: [{ type: 'image' }] }, true)).toBe('attachments')
    expect(decide(typed, false)).toBe('pass')
    expect(decide({ ...typed, wait: true }, false)).toBe('queue')
  })

  test('oneLine draws newlines as ⏎', () => {
    expect(oneLine('a\n\n b')).toBe('a ⏎ b')
  })
})

describe('Enter while Claude works', () => {
  test('idle: the prompt goes through untouched', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await enter($, 'hi')).toEqual({ text: 'hi' })
    expect(w.sent).toEqual(['hi'])
    expect(w.queued()).toEqual([])
  })

  test('mid-turn: queued and dropped, so the running turn never reads it', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    const result = await enter($, 'hi', { turnId: 't1' })
    expect(result).toEqual({ drop: 'Queued #1 · sent when this turn ends' })
    expect(w.sent).toEqual([])
    expect(w.queued()).toEqual(['hi'])
  })

  test('a dropped prompt left in the box is cleared, a newer draft kept', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    w.box.text = 'hi'
    await enter($, 'hi', { turnId: 't1' })
    await w.clock.advance(60)
    expect(w.box.text).toBe('')

    w.box.text = 'typing on'
    await enter($, 'more', { turnId: 't1' })
    await w.clock.advance(60)
    expect(w.box.text).toBe('typing on')
  })

  test('pasted images are let through and said so', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    await enter($, 'look', { turnId: 't1', attachments: [{ type: 'image' }] })
    expect(w.sent).toEqual(['look'])
    expect(w.queued()).toEqual([])
    expect(w.toasts).toEqual([expect.stringMatching(/pasted images/)])
  })

  test('enterQueues off: Enter steers, the queue chord still queues', { options: { enterQueues: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    await enter($, 'steer', { turnId: 't1' })
    await enter($, 'wait', { turnId: 't1', wait: true })
    expect(w.sent).toEqual(['steer'])
    expect(w.queued()).toEqual(['wait'])
  })
})

describe('sending when a turn ends', () => {
  test('an answered turn sends the next one, one per turn, in order', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    await enter($, 'first', { turnId: 't1' })
    await enter($, 'second', { turnId: 't1' })
    await turnEnd($)
    await w.clock.settle()
    expect(w.sent).toEqual(['first'])
    expect(w.queued()).toEqual(['second'])

    await turnStart($, 't2')
    await turnEnd($, 'answer', 't2')
    await w.clock.settle()
    expect(w.sent).toEqual(['first', 'second'])
    expect(w.store['queue:s1']).toBeUndefined()
  })

  test('Esc or an error leaves the queue waiting', async ($, on) => {
    const w = world(on)
    await start($)
    for (const reason of ['aborted', 'error'] as const) {
      await turnStart($)
      await enter($, reason, { turnId: 't1' })
      await turnEnd($, reason)
      await w.clock.settle()
    }
    expect(w.sent).toEqual([])
    expect(w.queued()).toEqual(['aborted', 'error'])
  })

  test('a subagent’s turn changes nothing', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    await enter($, 'later', { turnId: 't1' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'a1', reason: 'answer', agentId: 'a1' } as never)
    await w.clock.settle()
    expect(w.sent).toEqual([])
  })

  test('a refused send goes back to the front and is logged', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    await enter($, 'first', { turnId: 't1' })
    await enter($, 'second', { turnId: 't1' })
    w.refuse.next = 'a Stop hook stands'
    await turnEnd($)
    await w.clock.settle()
    expect(w.queued()).toEqual(['first', 'second'])
    expect(w.sending()).toBeNull()
    expect(w.logs).toEqual([expect.stringMatching(/back at the front of the queue: “first” \(a Stop hook stands\)/)])
  })

  test('a resumed session finds its queue and waits', async ($, on) => {
    const w = world(on)
    w.store['queue:s1'] = { items: [{ id: 3, text: 'from before' }], nextId: 4 }
    await start($)
    await w.clock.settle()
    expect(w.sent).toEqual([])
    const ui = await band($, 'terminal', { isWorking: false })
    expect((await ui.find({ type: 'Text', text: /from before/ }))?.text).toContain('#1 from before')
    expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('/queue', () => {
  test('mid-turn it queues and answers nothing the model could read', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    expect(await slash($, 'run the tests')).toEqual({})
    expect(w.queued()).toEqual(['run the tests'])
    expect(w.toasts).toEqual(['Queued #1 · sent when this turn ends'])
  })

  test('with no model turn (a ! shell command may run) it waits in the band; bare it only explains', async ($, on) => {
    const w = world(on)
    await start($)
    await slash($, 'later please')
    await w.clock.settle()
    expect(w.sent).toEqual([])
    expect(w.queued()).toEqual(['later please'])
    expect(w.toasts).toEqual(['Queued #1 · Send now in the band sends it'])
    const ui = await band($, 'terminal', { isWorking: false })
    expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeDefined()
    await ui.press({ key: 'send-1' })
    expect(w.sent).toEqual(['later please'])
    await ui.unmount()
    expect(await slash($, '  ')).toEqual({})
  })

  test('Send now during a ! shell command hands one over; the rest wait', async ($, on) => {
    const w = world(on)
    await start($)
    w.hold.on = true
    await slash($, 'first')
    await slash($, 'second')
    const ui = await band($, 'terminal', { isWorking: false })
    void ui.press({ key: 'send-1' })
    await w.clock.settle()
    expect(w.held.map(prompt => prompt.text)).toEqual(['first'])
    expect(w.sending()).toBe('first')
    expect(w.queued()).toEqual(['second'])
    expect((await ui.find({ type: 'Text', text: /sending/ }))?.text).toContain('→ first')
    expect(await ui.find({ key: 'send-2' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeUndefined()
    await ui.unmount()

    // The shell command ends and the prompt runs as a turn of its own
    w.held[0]!.resolve({ text: 'first' })
    await w.clock.settle()
    expect(w.sending()).toBeNull()
    await turnStart($)
    w.hold.on = false
    await turnEnd($)
    await w.clock.settle()
    expect(w.sent).toEqual(['second'])
  })

  test('taken off the engine’s own queue (Esc), it is back at the front', async ($, on) => {
    const w = world(on)
    await start($)
    w.hold.on = true
    await slash($, 'first')
    await slash($, 'second')
    const ui = await band($, 'terminal', { isWorking: false })
    void ui.press({ key: 'send-1' })
    await w.clock.settle()
    await ui.unmount()
    w.held[0]!.resolve({ drop: 'the prompt was removed from the queue before it ran' })
    await w.clock.settle()
    expect(w.queued()).toEqual(['first', 'second'])
    expect(w.sending()).toBeNull()
    expect(w.logs).toEqual([expect.stringMatching(/^not sent, back at the front/)])
  })

  test('its transcript row keeps the command, not the prompt', async ($, on) => {
    const s = mock.session(on)
    world(on)
    await start($)
    const row = '<command-name>/queue</command-name><command-message>queue</command-message><command-args>secret plan</command-args>'
    await $.session.append({ door: 'command', message: { role: 'user', content: [{ type: 'text', text: row }] } } as never)
    const text = JSON.stringify(s.appended())
    expect(text).not.toContain('secret plan')
    expect(text).toContain('<command-args></command-args>')
  })

  test('another /queue command is reported', async ($, on) => {
    const w = world(on)
    w.listed.push({ name: 'queue', description: 'mine', source: 'user', isFullscreen: false })
    await start($)
    expect(w.logs).toEqual([expect.stringMatching(/shadows/)])
  })
})

describe('the band', () => {
  test('empty: the band is left to whatever draws beneath', async ($, on) => {
    world(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await band($, surface)
      expect(await ui.find({ type: 'Text', text: /Queued/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('lists each prompt over what draws beneath, and collapses', async ($, on) => {
    world(on)
    await start($)
    await turnStart($)
    await enter($, 'hi', { turnId: 't1' })
    await enter($, 'two\nlines', { turnId: 't1' })
    for (const surface of SURFACES) {
      const ui = await band($, surface)
      expect((await ui.find({ key: 'toggle' }))?.text).toContain('Queued 2')
      expect((await ui.find({ type: 'Text', text: /#2/ }))?.text).toContain('#2 two ⏎ lines')
      expect(await ui.find({ key: 'send-1' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /engine band/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeUndefined()
      await ui.press({ key: 'toggle' })
      expect(await ui.find({ key: 'send-1' })).toBeUndefined()
      await ui.press({ key: 'toggle' })
      await ui.unmount()
    }
  })

  test('cancel removes the one prompt', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    await enter($, 'a', { turnId: 't1' })
    await enter($, 'b', { turnId: 't1' })
    const ui = await band($, 'terminal')
    await ui.press({ key: 'cancel-1' })
    expect(w.queued()).toEqual(['b'])
    await ui.unmount()
  })

  test('edit puts the prompt back in the box, after a draft if there is one', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    await enter($, 'a', { turnId: 't1' })
    await enter($, 'b', { turnId: 't1' })
    await w.clock.advance(60)
    const ui = await band($, 'terminal')
    await ui.press({ key: 'edit-1' })
    expect(w.box.text).toBe('a')
    await ui.press({ key: 'edit-2' })
    expect(w.box.text).toBe('a\nb')
    expect(w.queued()).toEqual([])
    await ui.unmount()
  })

  test('Send now over a running turn interrupts it and sends', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    await enter($, 'a', { turnId: 't1' })
    await enter($, 'b', { turnId: 't1' })
    const ui = await band($, 'terminal')
    await ui.press({ key: 'send-2' })
    expect(w.aborted).toEqual(['t1'])
    expect(w.sent).toEqual(['b'])
    expect(w.queued()).toEqual(['a'])
    await ui.unmount()
  })

  test('Send now while idle sends without interrupting', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($)
    await enter($, 'a', { turnId: 't1' })
    await turnEnd($, 'aborted')
    const ui = await band($, 'terminal', { isWorking: false })
    await ui.press({ key: 'send-1' })
    expect(w.aborted).toEqual([])
    expect(w.sent).toEqual(['a'])
    await ui.unmount()
  })

  test('a survey keeps the band', async ($, on) => {
    world(on)
    await start($)
    await turnStart($)
    await enter($, 'a', { turnId: 't1' })
    const ui = await band($, 'terminal', { hasSurvey: true })
    expect(await ui.find({ type: 'Text', text: /Queued/ })).toBeUndefined()
    await ui.unmount()
  })
})
