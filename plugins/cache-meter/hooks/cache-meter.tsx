/**
 * cache-meter — Claude Mod
 *
 * A prompt-cache meter for Claude Code. Every main-loop request reports how
 * many prompt tokens the cache served (`cache_read_input_tokens`), wrote
 * (`cache_creation_input_tokens`) and sent uncached (`input_tokens`); this mod
 * keeps those per request and per turn, counts down to the moment the cache
 * lapses, and says what to do about it: keep going, /compact or /clear.
 *
 *   - `turn.step` reads each main-loop request's usage (subagents have their
 *     own prefixes and are left out). Only the main loop's requests reach it,
 *     and only while a turn runs (2.1.304): Claude Code's side requests (titles,
 *     suggestions, /context's count, /compact's summary) never do, so they can
 *     neither replace the last sample nor restart the countdown
 *   - `command.run`, unfiltered, notes the slash commands run between two
 *     requests; a local command changes nothing here, and a miss right after
 *     one names it
 *   - the samples are mirrored in `$.state`, so a reload of the module (an
 *     option changed in /config, /reload-plugins, a respawned hooks worker)
 *     keeps them; /clear starts a new conversation and a new meter
 *   - a resumed conversation (`claude --resume`, /resume) is read back from its
 *     transcript (`classic.SessionStart`, source resume or fork): the last
 *     request's time and usage, and the lifetime its write asked for, so the
 *     countdown goes on from where the conversation left it
 *   - `$.clock.every(1000)` redraws the countdown, and only while its text
 *     changes: an idle, expired session costs nothing
 *   - a row above the prompt (the AbovePrompt component): the hit rate, the
 *     prompt as read + wrote (+ new, from 10 uncached tokens on), the
 *     countdown and advice. An optional status line entry repeats the hit
 *     rate and countdown
 *   - idle compaction (Claude Code 2.1.290+): when Claude Code will compact
 *     the conversation by itself before the 1-hour cache lapses, the band
 *     counts down to that moment as well as to the expiry, and
 *     `session.compact` (trigger "idle") says when it happened (see idlePolicy
 *     in ./cache.ts for the conditions)
 *
 * The lifetime is counted from the start of the request that last wrote or read
 * the cache, as Anthropic documents it. Which lifetime Claude Code asked for
 * follows its documented rules (see decideTtl in ./cache.ts): FORCE_PROMPT_CACHING_5M,
 * CLAUDE_CODE_PROMPT_CACHE_TTL, the promptCacheTtl setting, ENABLE_PROMPT_CACHING_1H,
 * then the account (1 hour on a Claude subscription, 5 minutes otherwise). The
 * API names the TTL of a write but the mod API passes on only the token counts,
 * so the mod also watches the gaps between requests (a hit after more than 5
 * minutes proves 1 hour; see observeTtl). `ttl: "5m" | "1h"` pins it.
 *
 * Needs Claude Code >= 2.1.287.
 *
 * Options (pluginConfigs["cache-meter@skills-dir"].options):
 *   ttl: "auto" | "5m" | "1h"   cache lifetime (default auto)
 *   warnSeconds: number         countdown threshold for the warning (default 60)
 *   compactAtTokens: number     prompt size that makes an expired cache suggest /compact (default 100000)
 *   band: boolean               row above the prompt (default true)
 *   status: boolean             entry under the prompt (default false)
 *   toast: boolean              toasts near expiry: at warnSeconds, then 10, 3, 2 and 1 s (default true)
 *   idleCompact: boolean        idle compaction countdown and notice (default true)
 */
import type { EngineInterface, Register } from 'claude-code'
import {
  advise,
  COUNTDOWN_MARKS,
  fit,
  fmtClock,
  fmtPct,
  fmtTokens,
  fromTranscript,
  RESUMED,
  hitRatio,
  idleCompactAt,
  idlePolicy,
  isCachingDisabled,
  accountOf,
  decideTtl,
  observeTtl,
  lifeColor,
  nextToastMark,
  positive,
  promptTokens,
  remainingMs,
} from './cache.ts'
import type { Account, Advice, CacheEnv, IdleCompact, Sample, Ttl } from './cache.ts'
import { noteCommand } from './cache.ts'
import type { Snapshot } from '../types'

const KEEP = 200
// below this a lapsed cache costs too little to interrupt anyone about
const TOAST_MIN_TOKENS = 20_000
// a sound cache leaves a few uncached tokens after its last breakpoint; more means something sits outside it
const NEW_MIN_TOKENS = 10

let samples: Sample[] = []
let ttl: Ttl = '5m'
let baseTtl: Ttl = '5m'
let pinned = false
let observed: Ttl | undefined
let setting: unknown
let account: Account = 'other'
let ttlSource = 'default'
let envSource = 'default'
let env: CacheEnv = {}
let timer: { cancel: () => void } | undefined
let lastKey = ''
let toastedFor = 0
let toastLevel = Infinity
let idle: IdleCompact = idlePolicy({})
// the last compaction of the main conversation: a cache entry older than it is gone
let compacted: { at: number; trigger: string; before?: number; after?: number } | undefined
// slash commands run since the last request, for the next sample's `after`
let pending: string[] = []
// the session id a resumed transcript was read for: the session.end of the one it replaced must not wipe it
let seededFor: string | undefined
// what one read of the transcript copies at most: the last requests are at its end
const TAIL_BYTES = 4_000_000

const SNAPSHOT = { plugin: 'cache-meter', key: 'snapshot' } as const

// what a reload of the module would otherwise lose; best effort, the meter works without it
function save($: EngineInterface) {
  const value: Snapshot = { samples, observed: observed ?? null, compacted: compacted ?? null, pending }
  return $.state.set(SNAPSHOT, value).catch(() => undefined)
}

// the end of the transcript: `tail` first, as $.fs.read refuses a file over 4 MiB
async function readTail($: EngineInterface, path: string): Promise<string | undefined> {
  const tail = await $.process.run(['tail', '-c', String(TAIL_BYTES), path]).catch(() => undefined)
  if (tail && tail.exitCode === 0) return tail.stdout
  return $.fs.read(path).catch(() => undefined)
}

// a new conversation (/clear, /resume): its cache is a new one
function forget() {
  samples = []
  pending = []
  lastKey = ''
  toastedFor = 0
  compacted = undefined
  observed = undefined
}

type Policy = { warnMs: number; compactAtTokens: number }

function current(policy: Policy, now: number) {
  const last = samples[samples.length - 1]
  const prev = samples[samples.length - 2]
  const disabled = last ? isCachingDisabled(last.model, env) : isCachingDisabled('', env)
  if (last && compacted && compacted.at > last.startedAt) {
    // the conversation the last request cached is gone: the next one starts from the summary
    const sizes = compacted.before && compacted.after ? ` (${fmtTokens(compacted.before)} → ${fmtTokens(compacted.after)})` : ''
    const how = compacted.trigger === 'idle' ? 'compacted while idle' : 'compacted'
    const advice: Advice = { kind: 'cold', text: `${how}${sizes}: the next message starts from the summary` }
    return { last, advice, left: 0, idleAt: undefined }
  }
  const advice: Advice = advise(last, prev, { ttl, ...policy }, now, disabled)
  const left = last ? remainingMs(last, ttl, now) : 0
  const idleAt = disabled ? undefined : idleCompactAt(last, ttl, idle, now)
  return { last, advice, left, idleAt }
}

// "compacts in 41:12 if idle" until Claude Code compacts on its own, "compacting now (idle)" once that moment has come
const idleClock = (idleAt: number, now: number) => (idleAt > now ? `compacts in ${fmtClock(idleAt - now)} if idle` : 'compacting now (idle)')

const COLOR: Record<Advice['kind'], string | undefined> = {
  warm: 'green',
  soon: 'yellow',
  expired: 'red',
  miss: 'red',
  off: undefined,
  cold: undefined,
  uncached: undefined,
}

const ICON: Record<Advice['kind'], string> = {
  warm: '●',
  soon: '▲',
  expired: '✖',
  miss: '✖',
  off: '○',
  cold: '○',
  uncached: '○',
}

const HIT_COLOR = (pct: number) => (pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red')

function shortLine(policy: Policy, now: number): string {
  const { last, advice, left } = current(policy, now)
  if (!last || advice.kind === 'off') return `cache: ${advice.text}`
  const clock = left > 0 ? ` · ${fmtClock(left)}` : ''
  return `cache ${fmtPct(hitRatio(last))}${clock}`
}

type Settings = { promptCacheTtl?: unknown; idleCompaction?: unknown; autoCompactEnabled?: unknown }

// the settings the mod follows, each from the first settings file that sets it (local over project over user)
async function readSettings($: EngineInterface): Promise<Settings> {
  const home = await $.env.get('HOME').catch(() => undefined)
  const cwd = await $.session.cwd().catch(() => undefined)
  const files = [cwd && `${cwd}/.claude/settings.local.json`, cwd && `${cwd}/.claude/settings.json`, home && `${home}/.claude/settings.json`]
  const out: Settings = {}
  for (const file of files) {
    if (!file) continue
    try {
      const json = JSON.parse(await $.fs.read(file))
      if (out.promptCacheTtl === undefined && (json.promptCacheTtl === '5m' || json.promptCacheTtl === '1h')) out.promptCacheTtl = json.promptCacheTtl
      if (out.idleCompaction === undefined && typeof json.idleCompaction === 'boolean') out.idleCompaction = json.idleCompaction
      if (out.autoCompactEnabled === undefined && typeof json.autoCompactEnabled === 'boolean') out.autoCompactEnabled = json.autoCompactEnabled
    } catch {
      // missing or unreadable: the next file
    }
  }
  return out
}

// Claude Code's global config: the cached idle-compaction rollout flag, and autoCompactEnabled as /config saves it.
// Only those two keys are kept; nothing else in the file is held by the mod.
async function readGlobalConfig($: EngineInterface): Promise<{ flag?: unknown; autoCompact?: unknown }> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const home = await $.env.get('HOME').catch(() => undefined)
  const file = dir ? `${dir}/.claude.json` : home ? `${home}/.claude.json` : undefined
  if (!file) return {}
  try {
    const json = JSON.parse(await $.fs.read(file))
    const flag = json?.cachedGrowthBookFeatures?.tengu_sunny_locket
    return { flag: flag && typeof flag === 'object' ? flag : undefined, autoCompact: json?.autoCompactEnabled }
  } catch {
    return {}
  }
}

export const register: Register = (on, options) => {
  const policy: Policy = {
    warnMs: positive(options.warnSeconds, 60) * 1000,
    compactAtTokens: positive(options.compactAtTokens, 100_000),
  }
  const showBand = options.band !== false
  const showStatus = options.status === true
  const wantToast = options.toast !== false
  const showIdle = options.idleCompact !== false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    forget()
    // a reload (not a new process) finds the conversation's samples in $.state
    const kept = (await $.state.get(SNAPSHOT).catch(() => undefined))?.value
    if (kept) {
      samples = kept.samples
      pending = kept.pending
      compacted = kept.compacted ?? undefined
    }
    const none = () => undefined
    env = {
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(none),
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(none),
      ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(none),
      disableAll: await $.env.get('DISABLE_PROMPT_CACHING').catch(none),
      disableHaiku: await $.env.get('DISABLE_PROMPT_CACHING_HAIKU').catch(none),
      disableSonnet: await $.env.get('DISABLE_PROMPT_CACHING_SONNET').catch(none),
      disableOpus: await $.env.get('DISABLE_PROMPT_CACHING_OPUS').catch(none),
    }
    pinned = options.ttl === '5m' || options.ttl === '1h'
    observed = pinned ? undefined : (kept?.observed ?? undefined)
    const settings = await readSettings($)
    setting = settings.promptCacheTtl
    const global = await readGlobalConfig($)
    idle = idlePolicy({
      minTokensVar: await $.env.get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS').catch(none),
      disableAuto: await $.env.get('DISABLE_AUTO_COMPACT').catch(none),
      disableAll: await $.env.get('DISABLE_COMPACT').catch(none),
      setting: settings.idleCompaction,
      autoCompact: settings.autoCompactEnabled ?? global.autoCompact,
      flag: global.flag,
    })
    account = accountOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
    const choice = decideTtl(options.ttl, env, setting, account)
    baseTtl = choice.ttl
    envSource = choice.source
    ttl = observed ?? baseTtl
    ttlSource = observed ? `observed from request timing; ${envSource} said ${baseTtl}` : envSource

    $.ui.log(`cache-meter loaded: ${ttl} cache (${ttlSource})`, { to: 'debug' })
    $.ui.log(`cache-meter: idle compaction ${idle.on ? 'on' : 'off'}, ${idle.why}${idle.known ? '' : ' (rollout flag not found)'}`, { to: 'debug' })

    timer?.cancel()
    timer = $.clock.every(1000, () => {
      const now = Date.now()
      const { last, advice, left, idleAt } = current(policy, now)
      const key = `${advice.kind}|${advice.text}|${left > 0 ? fmtClock(left) : ''}|${showIdle && idleAt ? idleClock(idleAt, now) : ''}`
      if (key !== lastKey) {
        lastKey = key
        if (showStatus) $.ui.status(shortLine(policy, now))
        $.ui.invalidate('ui.render')
      }
      if (wantToast && last && left > 0 && promptTokens(last) >= TOAST_MIN_TOKENS) {
        if (toastedFor !== last.startedAt) {
          toastedFor = last.startedAt
          toastLevel = Infinity
        }
        // the first toast comes at warnSeconds, then 10, 3, 2 and 1 seconds; a late tick skips to the newest one
        const secs = Math.ceil(left / 1000)
        const mark = nextToastMark(secs, policy.warnMs / 1000, toastLevel)
        if (mark !== undefined) {
          toastLevel = mark
          const tail = secs <= COUNTDOWN_MARKS[0] ? 'send a message now' : `send a message to keep ${fmtTokens(promptTokens(last))} tokens warm`
          $.ui.toast(`cache expires in ${secs >= 60 ? fmtClock(left) : `${secs}s`}: ${tail}`)
        }
      }
    })
    return r
  })

  on('session.end', async ($, e, next) => {
    // /clear and /resume go on in the same process with another conversation, and
    // no session.start follows them: keep the clock, start the meter over
    if (e.reason === 'clear' || e.reason === 'resume') {
      // the resumed conversation was read in before the old one's end: keep it
      if (e.reason === 'resume' && seededFor !== undefined && seededFor !== e.sessionId) return next(e)
      forget()
      seededFor = undefined
      ttl = baseTtl
      ttlSource = envSource
      save($)
      if (showStatus) $.ui.status(shortLine(policy, Date.now()))
      $.ui.invalidate('ui.render')
      return next(e)
    }
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  // a resumed conversation: its cache may still be warm, so the meter starts from its last request
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source !== 'resume' && e.source !== 'fork') return r
    const text = e.transcript_path ? await readTail($, e.transcript_path) : undefined
    const read = text ? fromTranscript(text) : { samples: [] }
    forget()
    seededFor = e.session_id
    if (read.samples.length > 0) {
      samples = read.samples.slice(-KEEP)
    } else if (e.seconds_since_last_response !== undefined && e.context_tokens) {
      // no transcript to read: the hook's own figures, the whole context counted as cached
      const at = Date.now() - e.seconds_since_last_response * 1000
      samples = [{ turnId: RESUMED, index: 0, model: e.model ?? '', startedAt: at, read: e.context_tokens, write: 0, fresh: 0, output: 0 }]
    }
    // the write's own lifetime, which the live usage does not carry; the ttl option still wins
    if (!pinned) {
      observed = read.ttl
      ttl = read.ttl ?? baseTtl
      ttlSource = read.ttl ? `the resumed transcript's last write; ${envSource} said ${baseTtl}` : envSource
    }
    $.ui.log(`cache-meter: resumed, ${samples.length} requests read back, ${ttl} cache (${ttlSource})`, { to: 'debug' })
    await save($)
    if (showStatus) $.ui.status(shortLine(policy, Date.now()))
    $.ui.invalidate('ui.render')
    return r
  }).catch(($, e, next) => next(e))

  // a compaction of the main conversation replaces what the cache held; "idle" is Claude Code compacting on its own (2.1.290+)
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // a precompute only prepares a summary; the conversation is unchanged until it is used.
    // "idle" is not in SessionCompactTrigger yet (d.ts of 2.1.304), hence the string: re-check when it is regenerated
    const trigger = String(e.trigger)
    if (e.agentId || trigger === 'precompute' || 'skip' in r) return r
    // no undefined inside: the snapshot in $.state takes JSON only
    compacted = { at: Date.now(), trigger, ...(r.tokensBefore !== undefined && { before: r.tokensBefore }), ...(r.tokensAfter !== undefined && { after: r.tokensAfter }) }
    lastKey = ''
    save($)
    if (trigger === 'idle') {
      const sizes = r.tokensBefore && r.tokensAfter ? ` ${fmtTokens(r.tokensBefore)} → ${fmtTokens(r.tokensAfter)} tokens` : ''
      $.ui.log(`cache-meter: compacted while idle${sizes}, before the ${ttl} cache lapsed`)
      if (showIdle && wantToast) $.ui.toast(`compacted while idle${sizes}: your next message starts from the summary`)
    }
    if (showStatus) $.ui.status(shortLine(policy, Date.now()))
    $.ui.invalidate('ui.render')
    return r
  })

  // each main-loop request: what the cache did with it
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const startedAt = Date.now()
    const r = yield* next(e)
    if (r.usage) {
      samples.push({
        turnId: e.turnId,
        index: e.index,
        model: r.usage.model || e.model,
        startedAt,
        read: r.usage.cache_read_input_tokens,
        write: r.usage.cache_creation_input_tokens,
        fresh: r.usage.input_tokens,
        output: r.usage.output_tokens,
        ...(e.effort !== undefined && { effort: e.effort }),
        ...(pending.length > 0 && { after: pending }),
      })
      pending = []
      if (samples.length > KEEP) samples = samples.slice(-KEEP)
      if (!pinned) {
        // the account can change under a session: a subscription running out of plan usage moves to usage credits
        account = accountOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
        const choice = decideTtl(options.ttl, env, setting, account)
        baseTtl = choice.ttl
        envSource = choice.source
        if (observed === undefined) {
          ttl = baseTtl
          ttlSource = envSource
        }
        const seen = observeTtl(samples[samples.length - 2], samples[samples.length - 1], observed)
        if (seen !== observed) {
          observed = seen
          ttl = seen ?? baseTtl
          ttlSource = `observed from request timing; ${envSource} said ${baseTtl}`
          $.ui.log(`cache-meter: cache lifetime is ${ttl} (${ttlSource})`, { to: 'debug' })
        }
      }
      lastKey = ''
      save($)
      if (showStatus) $.ui.status(shortLine(policy, Date.now()))
      $.ui.invalidate('ui.render')
    }
    return r
  })

  // every slash command, the person's or a plugin's: observed and passed on, nothing redrawn or reset
  on('command.run', async ($, e, next) => {
    pending = noteCommand(pending, e.command)
    save($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand || e.props.hasSurvey) return next(e)
    const now = Date.now()
    const { last, advice, left, idleAt } = current(policy, now)
    if (!last && advice.kind !== 'off') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? 100
    const color = COLOR[advice.kind]
    // The band is one instance: whatever the plugins beneath draw (another mod's band) stays, under this line.
    const below = await next(e)
    const stack = (own: ReturnType<typeof Text>) => (
      <Box flexDirection="column">
        {own}
        {below}
      </Box>
    )

    if (!last) return stack(<Text dimColor>{fit(`cache: ${advice.text}`, columns)}</Text>)

    // one Text with coloured runs: it cannot break into columns, and it truncates at the end
    const ratio = hitRatio(last)
    const counting = advice.kind !== 'uncached' && advice.kind !== 'off' && advice.kind !== 'cold'
    const idleNote = showIdle && idleAt !== undefined
    const resumed = last.turnId.startsWith(RESUMED) && advice.kind === 'warm' ? 'resumed: the next message can reuse it' : undefined
    // the idle clock names itself: no note after it to repeat what it says
    const note = idleNote ? undefined : (resumed ?? advice.text)
    const sep = <Text dimColor>{' · '}</Text>
    return stack(
      <Text wrap="truncate-end">
        <Text bold color={color}>{`${ICON[advice.kind]} `}</Text>
        <Text bold color="cyan">cache</Text>
        {sep}
        <Text bold color={HIT_COLOR(ratio * 100)}>{`${fmtPct(ratio)} reused`}</Text>
        {columns >= 70 ? (
          <Text dimColor>
            {' ('}
            <Text color="green">{`${fmtTokens(last.read)} read`}</Text>
            {' + '}
            <Text color="yellow">{`${fmtTokens(last.write)} wrote`}</Text>
            {last.fresh >= NEW_MIN_TOKENS ? ' + ' : null}
            {last.fresh >= NEW_MIN_TOKENS ? <Text color="cyan">{`${fmtTokens(last.fresh)} new`}</Text> : null}
            {')'}
          </Text>
        ) : null}
        {counting ? sep : null}
        {counting ? <Text bold color={left > 0 ? lifeColor(left, ttl, policy.warnMs) : 'red'}>{left > 0 ? `expires in ${fmtClock(left)}` : 'expired'}</Text> : null}
        {counting ? <Text dimColor>{` (${ttl} TTL)`}</Text> : null}
        {idleNote ? sep : null}
        {showIdle && idleAt !== undefined ? <Text bold color="magenta">{idleClock(idleAt, now)}</Text> : null}
        {note ? sep : null}
        {note ? <Text dimColor>{note}</Text> : null}
      </Text>,
    )
  })
}
