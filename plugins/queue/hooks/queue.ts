// Pure queue operations: each returns a new queue and never mutates its input.
import type { Queue, QueuedPrompt } from '../types'

export const EMPTY: Queue = { items: [], sending: null, nextId: 1 }

const isPrompt = (item: unknown): item is QueuedPrompt => {
  const value = item as Partial<QueuedPrompt> | null | undefined
  return Number.isInteger(value?.id) && typeof value?.text === 'string'
}

/**
 * A stored queue, or anything else, as a queue. A prompt stored as sending
 * goes back to the front: the engine that held it is gone.
 */
export function normalize (raw: unknown): Queue {
  const value = raw as Partial<Queue> | null | undefined
  const stored = Array.isArray(value?.items) ? value.items.filter(isPrompt) : []
  const items = isPrompt(value?.sending) ? [value.sending, ...stored] : stored
  const maxId = items.reduce((max, item) => Math.max(max, item.id), 0)
  return { items, sending: null, nextId: Math.max(Number(value?.nextId) || 1, maxId + 1) }
}

/** Appends `text`; a blank text queues nothing. */
export function add (queue: Queue, text: string): { queue: Queue; item: QueuedPrompt | null } {
  const value = text.trim()
  if (!value) return { queue, item: null }
  const item = { id: queue.nextId, text: value }
  return { queue: { ...queue, items: [...queue.items, item], nextId: queue.nextId + 1 }, item }
}

export function remove (queue: Queue, id: number): { queue: Queue; item: QueuedPrompt | null } {
  const item = queue.items.find(other => other.id === id) ?? null
  if (!item) return { queue, item }
  return { queue: { ...queue, items: queue.items.filter(other => other.id !== id) }, item }
}

/**
 * Hands one prompt over to be sent (the front one, or `id`): it leaves the
 * list and is `sending` until the engine took or refused it. One at a time.
 */
export function take (queue: Queue, id?: number): { queue: Queue; item: QueuedPrompt | null } {
  if (queue.sending) return { queue, item: null }
  const item = (id === undefined ? queue.items[0] : queue.items.find(other => other.id === id)) ?? null
  if (!item) return { queue, item }
  return { queue: { ...queue, items: queue.items.filter(other => other.id !== item.id), sending: item }, item }
}

/** The engine took the prompt being sent, or refused it: then it goes back to the front. */
export function settle (queue: Queue, item: QueuedPrompt, isTaken: boolean): Queue {
  if (queue.sending?.id !== item.id) return queue
  return { ...queue, items: isTaken ? queue.items : [item, ...queue.items], sending: null }
}

export type SubmitFacts = {
  turnId?: string
  wait: boolean
  origin: { kind: string }
  command?: unknown
  isMeta?: true
  attachments?: readonly unknown[]
}

/**
 * What to do with a submission: `queue` it, `pass` it on, or pass it on as
 * `attachments` (a plugin's prompt cannot carry pasted images, so it steers).
 * Only the person's own Enter typed over a running turn is queued; with
 * `enterQueues` off, only the queue chord (`wait`).
 */
export function decide (e: SubmitFacts, enterQueues: boolean): 'queue' | 'pass' | 'attachments' {
  if (!e.turnId || e.origin.kind !== 'composer' || e.command || e.isMeta) return 'pass'
  if (!enterQueues && !e.wait) return 'pass'
  if (e.attachments?.length) return 'attachments'
  return 'queue'
}

/** One line for the band: newlines drawn as ⏎. */
export const oneLine = (text: string) => text.replace(/\s*\n\s*/g, ' ⏎ ')
