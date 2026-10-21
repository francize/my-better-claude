# codex-bridge

Use the local `codex` CLI from inside Claude Code — as a reviewer, or as an implementer.

## Skills

### `codex-consult` — get a second opinion

Triggers on "和 codex 讨论", "问问 codex", "second opinion", "让 gpt-6-astra 评审", and proactively when a design has more than one viable approach or a bug has survived two fix attempts.

The value of a second model is its independence, so the skill is built around two facts:

- **Agreement is cheap; disagreement is information.** The brief asks falsifiable questions — what input breaks this, which caller dies, which assumption is wrong — instead of soliciting approval.
- **Codex's conversation context is empty, but its filesystem is not.** It runs in the same repo and can verify claims itself, so the brief hands it `file:line` anchors rather than a paraphrase.

Claude forms its own position first, debates up to three rounds, then reports the conclusion, the consensus, the remaining disagreements with both sides' reasoning, and anything that is genuinely the user's call. Codex runs `read-only` throughout.

### `codex-delegate` — hand off the implementation

Triggers on "交给 codex 做", "用 codex 实现", "delegate this to codex".

Claude does intake, context gathering, planning and verification; Codex makes every edit and runs every test. One plan step per turn on a single thread, and after each step Claude verifies against `git diff`, `git status` and HEAD rather than Codex's self-report — a commit leaves diff and status clean, which is precisely the case you want to catch.

Runs `workspace-write` by default (`.git` stays read-only at the OS level), `--network` when a build needs it, `danger-full-access` only when a step must write outside the repo.

## The wrapper

Both skills call `scripts/codex-chat.sh`, a thin wrapper over `codex exec`:

```
codex-chat.sh ask   [options] <brief-file>
codex-chat.sh reply [options] <thread-id> <brief-file>

  --sandbox MODE   read-only | workspace-write | danger-full-access  (default: read-only)
  --network        allow network under workspace-write
  --effort LEVEL   low | medium | high | xhigh                       (default: xhigh)
  --model NAME                                                       (default: gpt-6-astra)
  --cwd DIR        repo root Codex works in
  --log FILE       raw JSONL log path
```

It prints three blocks: a compact activity log of what Codex actually ran, the final message, and a meta block with the thread id, the raw JSONL log path, and the exit status.

Two details it exists to hide: `codex exec resume` has no `-s/--sandbox` flag (the sandbox must go through `-c sandbox_mode=...`), and the brief is fed on stdin so it needs no shell quoting and has no length limit.

## Requirements

`codex` CLI on `PATH` (developed against 0.154.0), `jq`, bash 3.2+.

Set the Bash timeout generously — at `xhigh` reasoning a real consult runs for minutes and a real implementation step longer.
