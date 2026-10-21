# image-preview

[English](README.md) | 中文

鼠标悬停在粘贴的 `[Image #N]` 上即可预览图片：输入时在输入框上方显示，已发送的消息里也能预览。点击仍和原来一样打开图片。

## 显示方式

1. **终端图形**：Ghostty 和 kitty 直接绘制图片（设置了 `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` 的终端也会这样）
2. **指针旁的窗口**：其他终端会在终端外、指针旁弹出一个小窗口，按原画质显示（macOS、Windows、Linux X11）
3. **彩色字符块**：以上都不可用，或关闭了 `window` 选项时，用字符块近似绘制

## 选项

在 `/config` 中设置。

| 选项     | 默认值 | 含义                                                         |
| -------- | ------ | ------------------------------------------------------------ |
| `window` | `true` | 终端无法直接绘图时，在指针旁的窗口里显示；关闭后用字符块绘制 |

## 环境要求

- Claude Code 2.1.287+，且开启 `"tui": "fullscreen"`（非全屏模式下终端不上报鼠标位置，无法悬停）
- 图片转换工具：`sips`（macOS）、ImageMagick（Linux）、ImageMagick 或 PowerShell（Windows、WSL）
- Linux 窗口模式：需要带 `tkinter` 的 Python 3，且运行在 X11 上

## 安装

```
/plugin install image-preview@my-better-claude
```
