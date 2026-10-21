// The contract must be self-contained: these mirror Sample and Ttl in ../hooks/cache.ts.
export type KeptSample = {
  turnId: string
  index: number
  model: string
  startedAt: number
  read: number
  write: number
  fresh: number
  output: number
  effort?: string | number
  after?: readonly string[]
}

/** What the meter knows about the conversation, kept in $.state so a reload of the module (an option changed in /config, /reload-plugins, a respawned hooks worker) picks up where it was. */
export type Snapshot = {
  samples: KeptSample[]
  observed: '5m' | '1h' | null
  compacted: { at: number; trigger: string; before?: number; after?: number } | null
  /** slash commands run since the last request */
  pending: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': { snapshot: Snapshot | null }
  }
}
