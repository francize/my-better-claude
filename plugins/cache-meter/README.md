# cache-meter

English | [中文](README.zh-CN.md)

A prompt-cache meter for Claude Code. Every main-loop request reports how many prompt tokens the cache served, wrote and sent uncached; this mod shows them above the prompt, counts down to the moment the cache lapses, and says what to do about it.

## What you see

- **Band above the prompt**, one line:
  ```
  ● cache · 98.3% reused (55.1k read + 812 wrote + 87 new) · expires in 59:52 (1h TTL) · warm: keep going
  ```
  The hit rate is the last request's, to one decimal and rounded down, so anything written or sent uncached keeps it under 100%; the brackets add up to the prompt. `new` is what the cache did not cover: a sound cache leaves only a few tokens past its last breakpoint, so `new` shows only from 10 tokens on, when something sits outside the cache. The icon and countdown turn green → yellow near expiry → red once expired or missed
- **Named misses**: when the cache missed, the band says why — lifetime lapsed, model or effort changed, or the prompt prefix changed (naming any slash command run just before)
- **Advice**: on an expired cache with a large prompt, suggests `/compact` or `/clear` before you pay to write the whole prefix again
- **Idle compaction** (Claude Code 2.1.290+): counts down to the moment Claude Code compacts a large idle conversation by itself, and says when it did
- **Toasts** as the cache lapses (prompts of 20k tokens or more)

Local slash commands like `/effort` or `/context` never reset the meter; `/clear` starts a new one. A resumed conversation (`claude --resume`, `/resume`) is read back from its transcript, so the band shows right away and the countdown goes on from the last request, with the TTL that request was written with.

## Options

Set in `/config`.

| Option            | Default  | Meaning                                                                       |
| ----------------- | -------- | ----------------------------------------------------------------------------- |
| `ttl`             | `auto`   | Cache lifetime: `auto` follows Claude Code's rules and request timing; `5m` / `1h` pins it |
| `warnSeconds`     | `60`     | Seconds left at which the band turns yellow and a toast fires                 |
| `compactAtTokens` | `100000` | Prompt size from which an expired cache suggests `/compact`                   |
| `band`            | `true`   | Show the band above the prompt                                                |
| `status`          | `false`  | Also pin hit rate and countdown under the prompt                              |
| `toast`           | `true`   | Toasts near expiry                                                            |
| `idleCompact`     | `true`   | Idle-compaction countdown and notice                                          |

## Requirements

Claude Code 2.1.287+ (checked against 2.1.304).

## Install

```
/plugin install cache-meter@my-better-claude
```
