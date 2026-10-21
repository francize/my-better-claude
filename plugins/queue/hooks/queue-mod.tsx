/**
 * queue — Claude Mod
 *
 * A prompt queue that never steers. Claude Code hands a prompt typed over a
 * running turn to that turn at its next step; this mod holds it instead and
 * sends it as a turn of its own once the running one ends.
 *
 *   - `prompt.submit` fires at Enter even mid-turn, with that turn's id: the
 *     person's own Enter over a running turn is queued and dropped, so the
 *     model never reads it early. With pasted images it is let through (a
 *     plugin's prompt cannot carry them), and said so
 *   - `/queue <prompt>` queues from the prompt too (`immediate`, so it runs
 *     mid-turn); its arguments are scrubbed from the transcript row the model
 *     reads (`session.append`, door `command`). With no model turn running it
 *     waits for Send now: a `!` shell command may be, and no event says so
 *   - `turn.complete` of the main loop, ended by an answer, sends the next one
 *     with `$.prompt.submit({ asUser })`. Esc, a refusal or an error leave the
 *     queue waiting for the person
 *   - one prompt at a time is handed to the engine, which runs it once the
 *     session is idle. It shows as sending until the engine took it; refused
 *     or taken off the engine's own queue, it goes back to the front
 *   - a band above the prompt: `▾ Queued N`, one row per prompt with
 *     [Send now] [edit] [cancel]. Send now over a running turn interrupts it
 *     (`$.turn.abort`) and sends; edit puts the text back in the prompt box
 *   - the queue lives in `$.state` (the band redraws from it, a reload keeps
 *     it) and in `$.store` per session id, so a resumed session finds it,
 *     waiting until the person sends one
 *
 * Built on the approach of After (github.com/midudev/better-claude, MIT).
 *
 * Options (userConfig):
 *   enterQueues: boolean   Enter over a running turn queues (default true);
 *                          off, only ctrl+x enter and /queue do
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { add, decide, EMPTY, normalize, oneLine, remove, settle, take } from './queue.ts'
import type { Queue, QueuedPrompt } from '../types'

type Engine = EngineInterface

const QUEUE_REF = { plugin: 'queue', key: 'queue' } as const
const COLLAPSED_REF = { plugin: 'queue', key: 'collapsed' } as const
const QUEUE = atom(QUEUE_REF, EMPTY)
const COLLAPSED = atom(COLLAPSED_REF, false)

const STORE_PREFIX = 'queue:'
// The row a /queue command leaves in the transcript, which the model reads
const COMMAND_RECORD = /<command-name>\/(?:queue:)?queue<\/command-name>/
const COMMAND_ARGS = /<command-args>[\s\S]*?<\/command-args>/

// The main loop's running turn; a reload lands between turns, so module variables do
let runningTurn: string | undefined
let chain: Promise<unknown> = Promise.resolve()

export const register: Register = (on, options) => {
  const enterQueues = options.enterQueues !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'queue',
      description: 'Queue a prompt to send after the current turn, without steering it',
      argumentHint: '<prompt>',
      immediate: true,
    })
    runningTurn = undefined
    const stored = await $.store.get(await storeKey($))
    await $.state.set(QUEUE_REF, normalize(stored))
    await warnIfShadowed($)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) runningTurn = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    runningTurn = undefined
    if (e.reason === 'answer') void sendNext($).catch(error => debug($, error))
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const verdict = decide(e, enterQueues)
    if (verdict === 'pass') return next(e)
    if (verdict === 'attachments') {
      $.ui.toast('a prompt with pasted images cannot wait in the queue: sent into the running turn')
      return next(e)
    }
    const { position } = await enqueue($, e.text)
    if (position === 0) return next(e)
    clearBoxIfStill($, e.text)
    return { drop: `Queued #${position} · sent when this turn ends` }
  })

  on('command.run', { command: 'queue' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) {
      $.ui.toast('/queue <prompt> queues it; the band above the prompt lists the queue')
      return {}
    }
    const { position } = await enqueue($, text)
    // No model turn may still be busy (a `!` shell command, which no event
    // reports): it waits in the band for Send now
    $.ui.toast(runningTurn === undefined
      ? `Queued #${position} · Send now in the band sends it`
      : `Queued #${position} · sent when this turn ends`)
    // The transcript row is what the model reads: nothing of the prompt
    return {}
  })

  // The command's record would show Claude the queued prompt before its turn
  on('session.append', { door: 'command' }, ($, e, next) => {
    const isQueue = e.message.content.some(block => typeof block.text === 'string' && COMMAND_RECORD.test(block.text))
    if (!isQueue) return next(e)
    const content = e.message.content.map(block => typeof block.text === 'string'
      ? { ...block, text: block.text.replace(COMMAND_ARGS, '<command-args></command-args>') }
      : block)
    return next({ ...e, message: { ...e.message, content } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const queue = await read($, QUEUE)
    if (queue.items.length === 0 && !queue.sending) return next(e)
    const isCollapsed = await read($, COLLAPSED)
    const { Box, Button, Text } = $.ui.resolve(e)
    // The band is one instance: whatever the plugins beneath draw stays, under the queue
    const below = await next(e)

    // The engine's node may stand in `below`, and it is refused under a Box that sets a width
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" width={e.props.bodyColumns}>
          <Box flexDirection="row" columnGap={1}>
            <Button key="toggle" plain onPress={() => update($, COLLAPSED, value => !value)}>
              {isCollapsed ? '▸ ' : '▾ '}
              <Text bold>Queued</Text>
              {` ${queue.items.length}`}
            </Button>
            {e.props.isWorking || queue.sending || queue.items.length === 0
              ? null
              : <Text dimColor>· waiting: Send now to go on</Text>}
          </Box>
          {isCollapsed || !queue.sending ? null : (
            <Text dimColor wrap="truncate-end">{`  → ${oneLine(queue.sending.text)} · sending, once Claude Code is idle`}</Text>
          )}
          {isCollapsed ? null : queue.items.map((item, i) => (
            <Box key={`row-${item.id}`} flexDirection="row" justifyContent="space-between" columnGap={2}>
              <Box flexShrink={1}>
                <Text wrap="truncate-end">{`  #${i + 1} ${oneLine(item.text)}`}</Text>
              </Box>
              <Box flexDirection="row" flexShrink={0}>
                {queue.sending ? null : <Button key={`send-${item.id}`} label="Send now" onPress={() => sendNow($, item.id)} />}
                <Button key={`edit-${item.id}`} label="edit" onPress={() => edit($, item.id)} />
                <Button key={`cancel-${item.id}`} label="cancel" onPress={() => cancel($, item.id)} />
              </Box>
            </Box>
          ))}
        </Box>
        {below}
      </Box>
    )
  })
}

// ── The queue ──────────────────────────────────────────────────────────────────

/** Runs queue writes one at a time, in order. */
function exclusive<T> (work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => {})
  return run
}

async function storeKey ($: Engine) {
  return `${STORE_PREFIX}${await $.session.id()}`
}

/** Applies `apply` to the queue and saves what it returns. */
function commit<T> ($: Engine, apply: (queue: Queue) => { queue: Queue } & T): Promise<{ queue: Queue } & T> {
  return exclusive(async () => {
    const before = await read($, QUEUE)
    const outcome = apply(before)
    if (outcome.queue === before) return outcome
    await $.state.set(QUEUE_REF, outcome.queue)
    const key = await storeKey($)
    if (outcome.queue.items.length === 0 && !outcome.queue.sending) await $.store.delete(key)
    else await $.store.set(key, outcome.queue)
    return outcome
  })
}

/** Queues `text`; resolves its 1-based position, 0 when nothing was queued. */
async function enqueue ($: Engine, text: string) {
  const { queue, item } = await commit($, queue => add(queue, text))
  return { position: item ? queue.items.length : 0 }
}

// ── Sending ────────────────────────────────────────────────────────────────────

async function sendNext ($: Engine) {
  const { item } = await commit($, queue => take(queue))
  if (item) await submit($, item)
}

/**
 * Hands the prompt being sent to Claude as the person's own words. It resolves
 * once the engine took it; refused or taken off the engine's queue, it is back
 * at the front.
 */
async function submit ($: Engine, item: QueuedPrompt) {
  let reason: string | undefined
  try {
    reason = (await $.prompt.submit({ text: item.text, asUser: true })).drop
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error)
  }
  await commit($, queue => ({ queue: settle(queue, item, reason === undefined) }))
  if (reason !== undefined) $.ui.log(`not sent, back at the front of the queue: “${oneLine(item.text).slice(0, 48)}” (${reason})`)
}

/** Send now: interrupts a running turn, then sends. */
async function sendNow ($: Engine, id: number) {
  const { item } = await commit($, queue => take(queue, id))
  if (!item) return
  if (runningTurn !== undefined) await $.turn.abort({ turnId: runningTurn }).catch(error => debug($, error))
  await submit($, item)
}

/** Puts the prompt back in the box to rewrite; Enter queues it again. */
async function edit ($: Engine, id: number) {
  const { item } = await commit($, queue => remove(queue, id))
  if (!item) return
  const box = await $.prompt.read()
  if (box.text.trim()) await $.prompt.fill({ text: `\n${item.text}`, mode: 'append' })
  else await $.prompt.fill({ text: item.text, mode: 'replace' })
}

async function cancel ($: Engine, id: number) {
  await commit($, queue => remove(queue, id))
}

/** A dropped prompt may be put back in the box; empty it unless the person typed since. */
function clearBoxIfStill ($: Engine, text: string) {
  // Never throws: the prompt is queued by now, and a throw would let it through too
  try {
    $.clock.after(50, () => {
      void $.prompt.read()
        .then(box => box.text === text ? $.prompt.fill({ text: '', mode: 'replace' }) : undefined)
        .catch(error => debug($, error))
    })
  } catch (error) {
    debug($, error)
  }
}

// ── Diagnostics ────────────────────────────────────────────────────────────────

/** A user or project /queue command would shadow the mod's. */
async function warnIfShadowed ($: Engine) {
  const shadowing = (await $.command.list()).filter(command => command.name === 'queue' && command.source !== 'plugin')
  if (shadowing.length > 0) $.ui.log('another /queue command shadows the mod; Enter while Claude works still queues')
}

/** Work nobody awaits reports its failures to the debug log (claude --debug). */
function debug ($: Engine, error: unknown) {
  try {
    $.ui.log(error instanceof Error ? error.message : String(error), { to: 'debug' })
  } catch {}
}
