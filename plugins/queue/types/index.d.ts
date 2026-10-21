// The values queue keeps in `$.state` for the session (the band draws from them)
// and in `$.store` across sessions (one queue per session id).

export type QueuedPrompt = { id: number; text: string }

export type Queue = {
  /** Prompts waiting, in send order. */
  items: QueuedPrompt[]
  /** Handed to the engine, which runs it once the session is idle; not taken or refused yet. */
  sending: QueuedPrompt | null
  nextId: number
}

declare module 'claude-code' {
  interface PluginState {
    queue: {
      queue: Queue
      collapsed: boolean
    }
  }
}
