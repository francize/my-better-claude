# image-preview

English | [中文](README.zh-CN.md)

Hover a pasted `[Image #N]` to see the picture — above the prompt while you write, and on the prompts you already sent. Click still opens it as before.

## How it shows the picture

1. **Terminal graphics**: Ghostty and kitty draw it themselves (also any terminal with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` set)
2. **Window by the pointer**: elsewhere, a small window outside the terminal at full quality (macOS, Windows, Linux X11)
3. **Colored cells**: when neither is available, or `window` is off

## Options

Set in `/config`.

| Option   | Default | Meaning                                                                   |
| -------- | ------- | ------------------------------------------------------------------------- |
| `window` | `true`  | Use a window by the pointer where the terminal cannot draw pictures; off draws in cells |

## Requirements

- Claude Code 2.1.287+ with `"tui": "fullscreen"` (outside fullscreen the terminal reports no pointer, so nothing can be hovered)
- An image converter: `sips` (macOS), ImageMagick (Linux), ImageMagick or PowerShell (Windows, WSL)
- Linux windows: Python 3 with `tkinter`, on X11

## Install

```
/plugin install image-preview@my-better-claude
```
