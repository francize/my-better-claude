# queue

English | [中文](README.zh-CN.md)

A prompt queue for Claude Code that never steers. Out of the box, a prompt typed while Claude works is handed to the running turn at its next step and changes what Claude is doing. With this mod, Enter during a turn queues the prompt instead. It is sent as a turn of its own once the running one ends.

## What you see

- **Band above the prompt**, while anything is queued:
  ```
  ▾ Queued 2
    #1 hi                                        [ Send now ] [ edit ] [ cancel ]
    #2 run the tests                             [ Send now ] [ edit ] [ cancel ]
  ```
  `▾` collapses it. Another mod's band (cache-meter) stays, under the queue
- **Send now**: interrupts the running turn and sends this prompt. While idle it just sends it
- **edit**: takes the prompt out of the queue and puts it back in the prompt box. Press Enter to queue it again
- **cancel**: removes it

## How it behaves

- Only your own Enter over a running turn is queued. Slash commands, background-task notifications and messages from other sessions behave as before
- After a turn that ended with an answer, the next prompt is sent, one per turn, in order. If you pressed Esc, or the turn was refused or errored, the queue waits and the band says `waiting: Send now to go on`
- The model never reads a queued prompt before its turn. The prompt is dropped at Enter, and the arguments of `/queue <prompt>` are scrubbed from the transcript row
- A prompt with pasted images cannot be held, because a mod's prompt cannot carry images. It is sent into the running turn as before, and a toast says so
- `/queue` with no model turn running keeps the prompt in the band until you press Send now: a `!` shell command may be running, and Claude Code reports none to a mod. A plain Enter during a `!` command is not a model turn, so Claude Code queues it as usual
- One prompt at a time is handed to Claude Code, which runs it once it is idle. Until it runs it shows as `→ … sending`; taken off Claude Code's own queue (Esc), it comes back to the front
- The transcript shows a sent prompt as `Prompt from the queue plugin`: Claude Code names the plugin that sent it, though the model reads it as your own words
- A resumed session (`claude --resume`) finds its queue, waiting until you send one

## Commands

| Command           | What it does                                       |
| ----------------- | -------------------------------------------------- |
| `/queue <prompt>` | Queue a prompt; with no model turn running, it waits for Send now |

## Options

Set in `/config`.

| Option        | Default | Meaning                                                                                        |
| ------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `enterQueues` | `true`  | Enter during a turn queues. Off: Enter steers as before; ctrl+x enter and `/queue` still queue |

## Requirements

Claude Code 2.1.304 (the build it was written and checked against).

## Install

```
/plugin install queue@my-better-claude
```

## Credits

Built on the approach of [After](https://github.com/midudev/better-claude) by midudev (MIT).
