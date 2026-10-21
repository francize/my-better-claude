// Run with: claude plugin test plugins/cache-meter
import { describe, expect, mock, test } from 'claude-code/testing'
import {
  advise,
  lifeColor,
  observeTtl,
  decideTtl,
  accountOf,
  nextToastMark,
  fmtPct,
  fmtClock,
  fmtTokens,
  fromTranscript,
  hitRatio,
  idleCompactAt,
  idlePolicy,
  isCachingDisabled,
  missReason,
  noteCommand,
  remainingMs,
  resolveTtl,
  RESUMED,
} from '../hooks/cache.ts'
import type { Policy, Sample } from '../hooks/cache.ts'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = 1_000_000_000_000
const policy: Policy = { ttl: '5m', warnMs: 60_000, compactAtTokens: 100_000 }

const sample = (over: Partial<Sample> = {}): Sample => ({
  turnId: 't1',
  index: 0,
  model: 'claude-sonnet-5-5',
  startedAt: T0,
  read: 80_000,
  write: 1_000,
  fresh: 500,
  output: 300,
  ...over,
})

describe('ttl and switches', () => {
  test('auto follows the environment; the option wins; FORCE_5M beats ENABLE_1H', () => {
    expect(resolveTtl('auto', {})).toBe('5m')
    expect(resolveTtl('auto', { enable1h: '1' })).toBe('1h')
    expect(resolveTtl('auto', { enable1h: '1', force5m: '1' })).toBe('5m')
    expect(resolveTtl('1h', { force5m: '1' })).toBe('1h')
    expect(resolveTtl(undefined, { enable1h: 'true' })).toBe('1h')
  })

  test('DISABLE_PROMPT_CACHING variants are per model family', () => {
    expect(isCachingDisabled('claude-opus-5-5', { disableAll: '1' })).toBe(true)
    expect(isCachingDisabled('claude-opus-5-5', { disableSonnet: '1' })).toBe(false)
    expect(isCachingDisabled('claude-sonnet-5-5', { disableSonnet: '1' })).toBe(true)
    expect(isCachingDisabled('claude-haiku-4-5', { disableHaiku: '1' })).toBe(true)
  })
})

describe('the countdown counts from the start of the request', () => {
  test('remaining time and expiry', () => {
    const s = sample()
    expect(remainingMs(s, '5m', T0 + 100_000)).toBe(200_000)
    expect(remainingMs(s, '1h', T0 + 100_000)).toBe(3_500_000)
    expect(remainingMs(s, '5m', T0 + 400_000)).toBe(0)
  })

  test('a request that touched no cache has no countdown', () => {
    expect(remainingMs(sample({ read: 0, write: 0 }), '5m', T0 + 1000)).toBe(0)
  })

  test('formatting', () => {
    expect(fmtClock(200_000)).toBe('3:20')
    expect(fmtClock(3_500_000)).toBe('58:20')
    expect(fmtClock(3_600_000)).toBe('1:00:00')
    expect(fmtClock(1)).toBe('0:01')
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(84_200)).toBe('84.2k')
    expect(fmtTokens(182_000)).toBe('182k')
    expect(fmtTokens(1_200_000)).toBe('1.2M')
    expect(Math.round(hitRatio(sample()) * 1000)).toBe(982)
  })
})

describe('advice', () => {
  test('warm, then soon, then expired', () => {
    const s = sample()
    expect(advise(s, undefined, policy, T0 + 10_000, false).kind).toBe('warm')
    expect(advise(s, undefined, policy, T0 + 250_000, false).kind).toBe('soon')
    expect(advise(s, undefined, policy, T0 + 300_000, false).kind).toBe('expired')
  })

  test('an expired large context suggests /compact, a small one says keep going', () => {
    const big = advise(sample({ read: 150_000 }), undefined, policy, T0 + 400_000, false)
    expect(big.text).toContain('/compact')
    const small = advise(sample({ read: 5_000, write: 100, fresh: 50 }), undefined, policy, T0 + 400_000, false)
    expect(small.text).toContain('keep going')
    expect(small.text).not.toContain('/compact')
  })

  test('the 1h cache stays warm where the 5m one has lapsed', () => {
    const s = sample()
    expect(advise(s, undefined, { ...policy, ttl: '1h' }, T0 + 1_000_000, false).kind).toBe('warm')
  })

  test('off, cold and uncached', () => {
    expect(advise(sample(), undefined, policy, T0, true).kind).toBe('off')
    expect(advise(undefined, undefined, policy, T0, false).kind).toBe('cold')
    expect(advise(sample({ read: 0, write: 0, fresh: 900 }), undefined, policy, T0, false).kind).toBe('uncached')
  })
})

describe('misses', () => {
  const prev = sample({ read: 50_000, write: 1_000, fresh: 200 })

  test('names the cause', () => {
    const wrote = { read: 0, write: 52_000, fresh: 300 }
    expect(missReason(prev, sample({ ...wrote, model: 'claude-opus-5-5', startedAt: T0 + 20_000 }), '5m')).toContain('model changed')
    expect(missReason(prev, sample({ ...wrote, startedAt: T0 + 400_000 }), '5m')).toContain('had lapsed')
    expect(missReason(prev, sample({ ...wrote, startedAt: T0 + 20_000 }), '5m')).toContain('prefix changed')
  })

  test('a hit, a first request and a /compact are not misses', () => {
    expect(missReason(prev, sample({ read: 51_000, write: 400, fresh: 100 }), '5m')).toBeUndefined()
    expect(missReason(undefined, sample(), '5m')).toBeUndefined()
    expect(missReason(prev, sample({ read: 0, write: 8_000, fresh: 100 }), '5m')).toBeUndefined()
  })

  test('advise reports a miss while the entry is still live', () => {
    const cur = sample({ read: 0, write: 52_000, fresh: 300, startedAt: T0 + 20_000 })
    const a = advise(cur, prev, policy, T0 + 30_000, false)
    expect(a.kind).toBe('miss')
    expect(a.text).toContain('prefix changed')
  })
})

describe('hit rate', () => {
  test('one decimal, rounded down, so a prompt that wrote or sent anything never reads as 100%', () => {
    expect(fmtPct(104_000 / 104_396)).toBe('99.6%')
    expect(fmtPct(0.99999)).toBe('99.9%')
    expect(fmtPct(1)).toBe('100.0%')
    expect(fmtPct(0)).toBe('0.0%')
    expect(fmtPct(80_000 / 81_300)).toBe('98.4%')
  })
})

// The module end to end: a main-loop request feeds the band, a subagent's does not.
type Calls = { status: (string | undefined)[]; logs: string[]; toasts?: string[] }

function fakeEngine(
  on: On,
  env: Record<string, string>,
  calls: Calls,
  cache: { read: number; write: number; fresh?: number } = { read: 80_000, write: 1_000 },
  limits: { kind: string; percentUsed: number }[] = [],
  files: Record<string, string> = {},
  clock: 'fake' | 'mock' = 'fake',
) {
  on('fs.read', ($, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('session.compact', async ($, e) => ({ messages: [{ role: 'user', text: 'summary', toolUses: [], toolResults: [] }], tokensBefore: 240_000, tokensAfter: 30_000 }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: limits } }) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.end', async () => ({ sessionId: 's1' }) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('env.get', ($, e) => ({ value: env[e.name] }))
  if (clock === 'fake') on('clock.every', () => ({ value: undefined }) as never)
  // the built-in commands beneath the plugin: each prints a line and changes nothing the mod reads
  on('command.run', ($, e) => ({ text: `ran /${e.command}` }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.toast', ($, e) => {
    calls.toasts?.push(String((e as { text: unknown }).text))
    return { value: undefined }
  })
  // what the plugins beneath draw above the prompt (another mod's band)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  on('ui.log', ($, e) => {
    calls.logs.push(String((e as { text: unknown }).text))
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    calls.status.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'claude-sonnet-5-5', input_tokens: cache.fresh ?? 300, output_tokens: 50, cache_read_input_tokens: cache.read, cache_creation_input_tokens: cache.write },
    } as never
  })
}

async function step($: Engine, over: { turnId?: string; index?: number; agentId?: string; effort?: string } = {}) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 3, ...over } as never)
  for (;;) {
    const n = await stream.next()
    if (n.done) return n.value
  }
}

const BAND = { hasSurvey: false } as never
const band = ($: Engine) => $.ui.mount({ plugin: 'cache-meter', surface: 'terminal', component: 'AbovePrompt', props: BAND })

describe('the band', () => {
  test('shows nothing before the first request, then the hit rate and the countdown', { options: { status: true } }, async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, {}, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)

    expect(calls.status).toEqual([])
    await step($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /98\.4%/ })).toBeDefined()
    // plain words: how much the cache served, of how big a prompt, and when it lapses
    expect(await ui.find({ type: 'Text', text: /98\.4% reused/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /expires in [45]:\d\d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\(5m TTL\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /warm: keep going/ })).toBeDefined()
    // ours first, what the plugins beneath drew under it
    const texts = (await ui.findAll({ type: 'Text', text: /98\.4%|beneath/ })).map(t => t.text)
    expect(texts.at(-1)).toBe('beneath')
    expect(texts.slice(0, -1).some(t => /98\.4%/.test(t))).toBe(true)
    await ui.unmount()
    expect(calls.status.at(-1)).toMatch(/^cache 98\.4% · [45]:\d\d$/)
  })

  test('the prompt is spelled out as read + wrote + new on the one line', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, {}, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: '80k read' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1k wrote' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '300 new' })).toBeDefined()
    // no second line: the model and the session's totals are gone
    expect(await ui.find({ type: 'Text', text: 'claude-sonnet-5-5' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^session / })).toBeUndefined()
    await ui.unmount()
  })

  // a sound cache leaves a few uncached tokens; from 10 on, new says something sits outside it
  for (const [fresh, shown] of [[0, false], [2, false], [9, false], [10, true], [5_000, true]] as const) {
    test(`${fresh} uncached tokens: new is ${shown ? 'shown' : 'left out'}`, async ($, on) => {
      const calls: Calls = { status: [], logs: [] }
      fakeEngine(on, {}, calls, { read: 80_000, write: 1_000, fresh })
      await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
      await step($)
      const ui = await band($)
      expect(await ui.find({ type: 'Text', text: '1k wrote' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: / new$/ })) !== undefined).toBe(shown)
      await ui.unmount()
    })
  }

  test('a narrow terminal drops the breakdown and keeps the hit rate', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, {}, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    const ui = await $.ui.mount({ plugin: 'cache-meter', surface: 'terminal', component: 'AbovePrompt', props: BAND, viewport: { columns: 60, rows: 24 } } as never)
    expect(await ui.find({ type: 'Text', text: '98.4% reused' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /read$/ })).toBeUndefined()
    await ui.unmount()
  })

  test('no /cache command is registered', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    const registered: string[] = []
    fakeEngine(on, {}, calls)
    on('command.register', ($, e) => {
      registered.push(String((e as { name: unknown }).name))
      return { value: undefined } as never
    })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect(registered).toEqual([])
  })

  test('a subagent request is not the main loop and leaves the meter alone', { options: { status: true } }, async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, {}, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, { agentId: 'agent-1' })
    expect(calls.status.filter(t => t?.includes('%'))).toEqual([])
    await step($)
    expect(calls.status.filter(t => t?.includes('%')).length).toBe(1)
  })

  test('ENABLE_PROMPT_CACHING_1H makes the lifetime an hour; the option beats the environment', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, { ENABLE_PROMPT_CACHING_1H: '1' }, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect(calls.logs.join('\n')).toContain('1h cache (ENABLE_PROMPT_CACHING_1H)')
    await step($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /\(1h TTL\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('a Claude subscription defaults to an hour, usage credits to five minutes', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, {}, calls, undefined, [{ kind: 'five_hour', percentUsed: 12 }])
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect(calls.logs.join('\n')).toContain('1h cache (Claude subscription default)')
  })

  test('CLAUDE_CODE_PROMPT_CACHE_TTL beats the subscription default', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, calls, undefined, [{ kind: 'five_hour', percentUsed: 12 }])
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect(calls.logs.join('\n')).toContain('5m cache (CLAUDE_CODE_PROMPT_CACHE_TTL)')
  })

  test('the ttl option beats the environment', { options: { ttl: '5m' } }, async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, { ENABLE_PROMPT_CACHING_1H: '1' }, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect(calls.logs.join('\n')).toContain('5m cache (the ttl option)')
  })

  test('a request that touched no cache shows no countdown', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, {}, calls, { read: 0, write: 0 })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /not cached/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /expires/ })).toBeUndefined()
    await ui.unmount()
  })

  test('DISABLE_PROMPT_CACHING says so instead of a countdown', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, { DISABLE_PROMPT_CACHING: '1' }, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /prompt caching is off/ })).toBeDefined()
    await ui.unmount()

    // after a request the band still shows no countdown
    await step($)
    const after = await band($)
    expect(await after.find({ type: 'Text', text: /expires/ })).toBeUndefined()
    await after.unmount()
  })
})

describe('countdown colour', () => {
  test('the countdown is green, then yellow below 40%, then red from the warning threshold', () => {
    expect(lifeColor(250_000, '5m', 60_000)).toBe('green')
    expect(lifeColor(110_000, '5m', 60_000)).toBe('yellow')
    expect(lifeColor(60_000, '5m', 60_000)).toBe('red')
    expect(lifeColor(5_000, '1h', 60_000)).toBe('red')
    expect(lifeColor(1_800_000, '1h', 60_000)).toBe('green')
  })
})

describe('countdown toasts', () => {
  test('fires at the threshold, then 10, 3, 2 and 1 seconds, once each', () => {
    let level = Infinity
    const fired: number[] = []
    for (let secs = 70; secs >= 1; secs--) {
      const m = nextToastMark(secs, 60, level)
      if (m !== undefined) {
        fired.push(secs)
        level = m
      }
    }
    expect(fired).toEqual([60, 10, 3, 2, 1])
  })
  test('a stalled clock skips to the newest mark; a short warning drops the early ones', () => {
    expect(nextToastMark(2, 60, Infinity)).toBe(2)
    expect(nextToastMark(2, 60, 2)).toBeUndefined()
    expect(nextToastMark(5, 5, Infinity)).toBe(5)
    expect(nextToastMark(30, 5, Infinity)).toBeUndefined()
  })
})

describe('observed lifetime', () => {
  const prev = sample({ startedAt: T0 })
  const MIN = 60_000
  test('a hit more than 5 minutes later proves the 1-hour lifetime and sticks', () => {
    const hit = sample({ startedAt: T0 + 20 * MIN, read: 80_000, write: 500 })
    expect(observeTtl(prev, hit, undefined)).toBe('1h')
    const miss = sample({ startedAt: T0 + 40 * MIN, read: 0, write: 81_000 })
    expect(observeTtl(hit, miss, '1h')).toBe('1h')
  })
  test('a miss 5 minutes to an hour later says 5 minutes; a later hit overrules it', () => {
    const miss = sample({ startedAt: T0 + 7 * MIN, read: 0, write: 81_000 })
    expect(observeTtl(prev, miss, undefined)).toBe('5m')
    const hit = sample({ startedAt: T0 + 20 * MIN, read: 80_000, write: 500 })
    expect(observeTtl(miss, hit, '5m')).toBe('1h')
  })
  test('says nothing inside 5 minutes, across a model change, after /compact, or when nothing was cached', () => {
    expect(observeTtl(prev, sample({ startedAt: T0 + 2 * MIN, read: 0, write: 81_000 }), undefined)).toBeUndefined()
    expect(observeTtl(prev, sample({ startedAt: T0 + 20 * MIN, model: 'claude-opus-5-5', read: 0, write: 81_000 }), undefined)).toBeUndefined()
    expect(observeTtl(prev, sample({ startedAt: T0 + 20 * MIN, read: 0, write: 5_000, fresh: 100 }), undefined)).toBeUndefined()
    expect(observeTtl(sample({ read: 0, write: 0 }), sample({ startedAt: T0 + 20 * MIN }), undefined)).toBeUndefined()
    expect(observeTtl(prev, sample({ startedAt: T0 + 2 * MIN, read: 80_000 }), undefined)).toBeUndefined()
  })
})

describe('which lifetime Claude Code asks for', () => {
  test('follows the documented order: force 5m, CLAUDE_CODE_PROMPT_CACHE_TTL, setting, ENABLE_1H, account', () => {
    expect(decideTtl('auto', { force5m: '1', ttlVar: '1h' }, '1h', 'subscription').ttl).toBe('5m')
    expect(decideTtl('auto', { ttlVar: '5m', enable1h: '1' }, '1h', 'subscription')).toEqual({ ttl: '5m', source: 'CLAUDE_CODE_PROMPT_CACHE_TTL' })
    expect(decideTtl('auto', { enable1h: '1' }, '5m', 'other')).toEqual({ ttl: '5m', source: 'the promptCacheTtl setting' })
    expect(decideTtl('auto', { enable1h: '1' }, undefined, 'other').ttl).toBe('1h')
    expect(decideTtl('auto', {}, 'junk', 'subscription')).toEqual({ ttl: '1h', source: 'Claude subscription default' })
    expect(decideTtl('auto', {}, undefined, 'credits').ttl).toBe('5m')
    expect(decideTtl('auto', {}, undefined, 'other').ttl).toBe('5m')
    expect(decideTtl('1h', { force5m: '1' }, '5m', 'other').ttl).toBe('1h')
  })
  test('the account comes from the plan windows the last response reported', () => {
    expect(accountOf([])).toBe('other')
    expect(accountOf([{ kind: 'spend_limit', percentUsed: 10 }])).toBe('other')
    expect(accountOf([{ kind: 'five_hour', percentUsed: 20 }, { kind: 'seven_day', percentUsed: 5 }])).toBe('subscription')
    expect(accountOf([{ kind: 'five_hour', percentUsed: 100 }])).toBe('credits')
  })
})

describe('idle compaction', () => {
  const ON = { mode: 'compact' }
  test('200k by default, never under 100k, the variable beats the flag', () => {
    expect(idlePolicy({ flag: ON })).toEqual(expect.objectContaining({ on: true, known: true, minTokens: 200_000, fraction: 0.9 }))
    expect(idlePolicy({ flag: ON, minTokensVar: '50000' }).minTokens).toBe(100_000)
    expect(idlePolicy({ flag: { ...ON, minTokens: 150_000 }, minTokensVar: '120000' }).minTokens).toBe(120_000)
    expect(idlePolicy({ flag: { ...ON, minTokens: 150_000 } }).minTokens).toBe(150_000)
    expect(idlePolicy({ flag: { ...ON, fireAtFraction: 0.99 } }).fraction).toBe(0.95)
  })
  test('off: rollout flag off or log-only, the setting, auto-compact off', () => {
    expect(idlePolicy({ flag: { mode: 'off' } })).toEqual(expect.objectContaining({ on: false, why: expect.stringMatching(/not rolled out/) }))
    expect(idlePolicy({ flag: { mode: 'log' } }).on).toBe(false)
    expect(idlePolicy({ flag: ON, setting: false }).why).toMatch(/idleCompaction: false/)
    expect(idlePolicy({ flag: ON, autoCompact: false }).on).toBe(false)
    expect(idlePolicy({ flag: ON, disableAuto: '1' }).on).toBe(false)
    expect(idlePolicy({ flag: ON, setting: true }).on).toBe(true)
  })
  test('no cached flag means no countdown', () => {
    expect(idlePolicy({})).toEqual(expect.objectContaining({ on: false, known: false, why: expect.stringMatching(/flag not found/) }))
  })
  test('fires at 90% of a warm 1h cache, only from the threshold up', () => {
    const big = sample({ read: 230_000 })
    const pol = idlePolicy({ flag: ON })
    expect(idleCompactAt(big, '1h', pol, T0 + 1000)).toBe(T0 + 3_240_000)
    expect(idleCompactAt(big, '5m', pol, T0 + 1000)).toBeUndefined()
    expect(idleCompactAt(sample(), '1h', pol, T0 + 1000)).toBeUndefined()
    expect(idleCompactAt(big, '1h', pol, T0 + 3_700_000)).toBeUndefined()
    expect(idleCompactAt(big, '1h', idlePolicy({ flag: { mode: 'off' } }), T0)).toBeUndefined()
  })

  const config = (flag: unknown) => ({ '/home/me/.claude.json': JSON.stringify({ cachedGrowthBookFeatures: { tengu_sunny_locket: flag } }) })
  const ENV = { HOME: '/home/me', ENABLE_PROMPT_CACHING_1H: '1' }

  test('the band counts down to the idle compaction of a large 1h conversation', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, ENV, calls, { read: 230_000, write: 1_000 }, [], config(ON))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect(calls.logs.join('\n')).toContain('idle compaction on')
    await step($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /^compacts in 5[34]:\d\d if idle$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /beneath/ })).toBeDefined()
    await ui.unmount()
  })

  test('no idle countdown when the account has not got it', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, ENV, calls, { read: 230_000, write: 1_000 }, [], config({ mode: 'off' }))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    expect(calls.logs.join('\n')).toContain('not rolled out')
    await step($)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /if idle/ })).toBeUndefined()
    await ui.unmount()
  })

  test('an idle compaction is announced and the band stops counting down the old cache', async ($, on) => {
    const calls: Calls = { status: [], logs: [], toasts: [] }
    fakeEngine(on, ENV, calls, { read: 230_000, write: 1_000 }, [], config(ON))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    await new Promise(r => setTimeout(r, 5))
    await $.session.compact({ trigger: 'idle', messages: [{ role: 'user', text: 'old', toolUses: [], toolResults: [] }] } as never)
    expect(calls.toasts?.join('\n')).toMatch(/compacted while idle 240k → 30k tokens/)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /compacted while idle/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /expires in \d/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a precompute or a subagent compaction changes nothing', async ($, on) => {
    const calls: Calls = { status: [], logs: [], toasts: [] }
    fakeEngine(on, ENV, calls, { read: 230_000, write: 1_000 }, [], config(ON))
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    await $.session.compact({ trigger: 'precompute', messages: [{ role: 'user', text: 'old', toolUses: [], toolResults: [] }] } as never)
    await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: [{ role: 'user', text: 'old', toolUses: [], toolResults: [] }] } as never)
    expect(calls.toasts).toEqual([])
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /^compacts in / })).toBeDefined()
    await ui.unmount()
  })
})

// A slash command between two requests: /effort, /model, /context and the rest.
describe('slash commands between requests', () => {
  const big = sample({ read: 200_000, write: 1_000, fresh: 200, effort: 'medium' })

  test('a real effort change that rewrote the messages is named as such', () => {
    const cur = sample({ read: 30_000, write: 172_000, fresh: 300, effort: 'low', startedAt: T0 + 20_000, after: ['effort'] })
    expect(missReason(big, cur, '5m')).toBe('effort changed (medium to low)')
    // the model outranks it: a model switch loses everything anyway
    expect(missReason(big, { ...cur, model: 'claude-opus-5-5' }, '5m')).toContain('model changed')
  })

  test('an effort change the cache survived is no miss (2.1.304 sends effort inside the conversation)', () => {
    // the probe's numbers: /effort low between two requests of a 44k conversation
    const prev = sample({ read: 30_667, write: 13_484, fresh: 2, effort: 'medium' })
    const cur = sample({ read: 44_126, write: 226, fresh: 2, effort: 'low', startedAt: T0 + 30_000, after: ['effort'] })
    expect(missReason(prev, cur, '5m')).toBeUndefined()
    expect(advise(cur, prev, policy, T0 + 31_000, false).kind).toBe('warm')
  })

  test('an unexplained miss names the commands run before it', () => {
    const cur = sample({ read: 0, write: 201_000, fresh: 300, effort: 'medium', startedAt: T0 + 20_000, after: ['mcp', 'context'] })
    expect(missReason(big, cur, '5m')).toBe('the prompt prefix changed after /mcp, /context (tools, system prompt or CLAUDE.md)')
    expect(missReason(big, { ...cur, after: undefined }, '5m')).toBe('the prompt prefix changed (tools, system prompt or CLAUDE.md)')
  })

  test('the commands kept: each once, latest last, at most five', () => {
    expect(noteCommand([], 'context')).toEqual(['context'])
    expect(noteCommand(['context', 'cost'], 'context')).toEqual(['cost', 'context'])
    expect(noteCommand(['a', 'b', 'c', 'd', 'e'], 'f')).toEqual(['b', 'c', 'd', 'e', 'f'])
  })

  test('an effort change is no evidence about the lifetime; a hit across one still proves an hour', () => {
    const later = T0 + 20 * 60_000
    const rewrote = sample({ read: 30_000, write: 172_000, fresh: 300, effort: 'low', startedAt: later })
    expect(observeTtl(big, rewrote, undefined)).toBeUndefined()
    expect(observeTtl(big, { ...rewrote, effort: 'medium' }, undefined)).toBe('5m')
    expect(observeTtl(big, { ...rewrote, read: 200_500, write: 300 }, undefined)).toBe('1h')
  })

  test('a local command neither resets the meter nor redraws or toasts', { options: { status: true } }, async ($, on) => {
    const calls: Calls = { status: [], logs: [], toasts: [] }
    fakeEngine(on, {}, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    const before = calls.status.length
    for (const command of ['context', 'cost', 'help', 'config', 'effort', 'model']) {
      const r = await $.command.run({ command, args: '' } as never)
      // passed on to Claude Code's own command
      expect(r.text).toBe(`ran /${command}`)
    }
    expect(calls.status.length).toBe(before)
    expect(calls.toasts).toEqual([])
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /98\.4%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\(5m TTL\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /expires in [45]:\d\d/ })).toBeDefined()
    await ui.unmount()
  })

  test('the next request carries the commands; a miss after them names them', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    const cache = { read: 80_000, write: 1_000 }
    fakeEngine(on, {}, calls, cache)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, { effort: 'medium' })
    await $.command.run({ command: 'mcp', args: '' } as never)
    cache.read = 0
    cache.write = 81_000
    await step($, { turnId: 't2', effort: 'medium' })
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /prefix changed after \/mcp \(/ })).toBeDefined()
    await ui.unmount()
    // the list starts over with each request
    await step($, { turnId: 't3', effort: 'medium' })
    const next = await band($)
    expect(await next.find({ type: 'Text', text: /after \/mcp/ })).toBeUndefined()
    await next.unmount()
  })

  test('an /effort change that rewrote the cache is named as an effort change', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    const cache = { read: 80_000, write: 1_000 }
    fakeEngine(on, {}, calls, cache)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, { effort: 'medium' })
    await $.command.run({ command: 'effort', args: 'low' } as never)
    cache.read = 0
    cache.write = 81_000
    await step($, { turnId: 't2', effort: 'low' })
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /cache missed: effort changed \(medium to low\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('a subagent request between two main ones neither becomes the last nor makes a miss', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    const cache = { read: 80_000, write: 1_000 }
    fakeEngine(on, {}, calls, cache)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    cache.read = 0
    cache.write = 50_000
    await step($, { agentId: 'agent-1' })
    cache.read = 81_000
    cache.write = 200
    await step($, { turnId: 't2' })
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /\(5m TTL\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '81k read' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '200 wrote' })).toBeDefined()
    await ui.unmount()
  })
})

describe('what survives', () => {
  test('/resume starts the meter over and keeps the clock running', { options: { status: true } }, async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    const clock = mock.clock(on, { now: 0 })
    fakeEngine(on, {}, calls, undefined, [], {}, 'mock')
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} } as never)
    expect(calls.status.at(-1)).toMatch(/no request yet/)
    const empty = await band($)
    expect(await empty.find({ type: 'Text', text: /98\.4%/ })).toBeUndefined()
    await empty.unmount()
    // the resumed conversation's first request: the band and the clock carry on
    await step($, { turnId: 't2' })
    calls.status.length = 0
    await clock.advance(2_000)
    expect(calls.status.length).toBeGreaterThan(0)
  })

  test('/clear starts the meter over too', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, {}, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /98\.4%/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a reload of the module (session.start again) keeps the samples', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, {}, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /98\.4%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\(5m TTL\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('a fresh session starts empty', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    fakeEngine(on, {}, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
    await ui.unmount()
  })
})

describe('a resumed conversation', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const line = (o: object) => JSON.stringify(o)
  const usage = (read: number, write: number, ttl: '1h' | '5m') => ({
    input_tokens: 2,
    output_tokens: 300,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation: { ephemeral_1h_input_tokens: ttl === '1h' ? write : 0, ephemeral_5m_input_tokens: ttl === '5m' ? write : 0 },
  })
  const transcript = (ttl: '1h' | '5m', lastAgoMs: number) =>
    [
      '{"cut first line of a tail',
      line({ type: 'user', promptId: 'p1', isSidechain: false, timestamp: ago(lastAgoMs + 60_000) }),
      line({ type: 'assistant', isSidechain: false, requestId: 'r1', timestamp: ago(lastAgoMs + 50_000), effort: 'high', message: { model: 'claude-opus-5-5', usage: usage(40_000, 2_000, ttl) } }),
      // a subagent's request is not the main loop
      line({ type: 'assistant', isSidechain: true, requestId: 'rs', timestamp: ago(1_000), message: { model: 'claude-haiku-4-5', usage: usage(0, 9_000, '5m') } }),
      // two blocks of one response: one request, timed from the first
      line({ type: 'assistant', isSidechain: false, requestId: 'r2', timestamp: ago(lastAgoMs), effort: 'high', message: { model: 'claude-opus-5-5', usage: usage(55_100, 856, ttl) } }),
      line({ type: 'assistant', isSidechain: false, requestId: 'r2', timestamp: ago(lastAgoMs - 5_000), effort: 'high', message: { model: 'claude-opus-5-5', usage: usage(55_100, 856, ttl) } }),
    ].join('\n')

  test('fromTranscript: main-loop requests once each, timed from their first block, with the lifetime of the last write', () => {
    const now = Date.now()
    const { samples, ttl } = fromTranscript(transcript('1h', 120_000))
    expect(samples.length).toBe(2)
    expect(samples.map(s => s.read)).toEqual([40_000, 55_100])
    expect(Math.abs(samples[1]!.startedAt - (now - 120_000))).toBeLessThan(1_000)
    expect(samples[1]!.turnId).toBe(`${RESUMED}:p1`)
    expect(samples[1]!.effort).toBe('high')
    expect(ttl).toBe('1h')
    expect(fromTranscript(transcript('5m', 0)).ttl).toBe('5m')
  })

  test('fromTranscript: empty or unreadable text gives nothing', () => {
    expect(fromTranscript('')).toEqual({ samples: [] })
    expect(fromTranscript('not json\n{"type":"assistant"}')).toEqual({ samples: [] })
  })

  const resumeStart = (over: object = {}) => ({ session_id: 's2', transcript_path: '/t/s2.jsonl', cwd: '/repo', source: 'resume', ...over }) as never
  const noTail = (on: On) => on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no tail' } }) as never)

  test('the band shows the resumed cache at once, counting down from its last request with the lifetime it was written with', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    noTail(on)
    // no plan windows: the account default alone would say 5 minutes
    fakeEngine(on, {}, calls, undefined, [], { '/t/s2.jsonl': transcript('1h', 120_000) })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.classic.SessionStart(resumeStart())
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /98\.4% reused/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /expires in 5[78]:\d\d/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\(1h TTL\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resumed: the next message can reuse it/ })).toBeDefined()
    await ui.unmount()
  })

  test('a resumed cache older than its lifetime reads as expired, and says what the next message costs', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    noTail(on)
    fakeEngine(on, {}, calls, undefined, [], { '/t/s2.jsonl': transcript('5m', 600_000) })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.classic.SessionStart(resumeStart())
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /^expired$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /rebuild/ })).toBeDefined()
    await ui.unmount()
  })

  test('the replaced conversation ending after the resumed one was read in does not wipe it', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    noTail(on)
    fakeEngine(on, {}, calls, undefined, [], { '/t/s2.jsonl': transcript('1h', 60_000) })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    await $.classic.SessionStart(resumeStart())
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} } as never)
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /\(1h TTL\)/ })).toBeDefined()
    await ui.unmount()
  })

  test('without a readable transcript, the hook figures still start the countdown', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    noTail(on)
    fakeEngine(on, {}, calls)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await $.classic.SessionStart(resumeStart({ seconds_since_last_response: 30, context_tokens: 90_000, model: 'claude-sonnet-5-5' }))
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /expires in 4:[23]\d/ })).toBeDefined()
    await ui.unmount()
  })

  test('a fresh start, /clear or a compaction is not a resume and reads nothing back', async ($, on) => {
    const calls: Calls = { status: [], logs: [] }
    noTail(on)
    fakeEngine(on, {}, calls, undefined, [], { '/t/s2.jsonl': transcript('1h', 60_000) })
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    for (const source of ['startup', 'clear', 'compact']) await $.classic.SessionStart(resumeStart({ source }))
    const ui = await band($)
    expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
    await ui.unmount()
  })
})
