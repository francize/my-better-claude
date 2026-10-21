# cache-meter

[English](README.md) | 中文

Claude Code 的 prompt cache 仪表。每次主循环请求都会报告缓存命中、写入和未缓存的 token 数；这个 mod 把它们显示在输入框上方，倒计时到缓存过期，并告诉你接下来该怎么做。

## 显示内容

- **输入框上方的状态条**，一行：
  ```
  ● cache · 98.3% reused (55.1k read + 812 wrote + 87 new) · expires in 59:52 (1h TTL) · warm: keep going
  ```
  命中率是上一次请求的，保留一位小数并向下取整，只要有写入或未缓存的部分就不会显示 100%；括号里三项相加就是整个 prompt。`new` 是缓存没覆盖到的部分：缓存正常时，最后一个断点之后只剩几个 token，所以 `new` 只在达到 10 个 token 时才显示，此时说明有内容落在了缓存之外。图标和倒计时绿色 → 临近过期变黄 → 已过期或未命中变红
- **说明未命中原因**：缓存未命中时，状态条会写明原因：缓存已过期、换了模型或 effort，或者 prompt 前缀变了（会点名之前刚执行的斜杠命令）
- **建议**：缓存已过期且上下文较大时，建议先 `/compact` 或 `/clear`，免得重新写入整个前缀
- **空闲压缩**（Claude Code 2.1.290+）：倒计时到 Claude Code 自动压缩空闲大会话的时刻，并在压缩后提示
- **Toast 提醒**：缓存即将过期时弹出（仅对 2 万 token 以上的 prompt）

`/effort`、`/context` 这类本地斜杠命令不会重置仪表；`/clear` 会开启新的一轮计量。恢复的会话（`claude --resume`、`/resume`）会从 transcript 读回最后一次请求：状态条立即显示，倒计时从那次请求接着算，TTL 也取自那次写入。

## 选项

在 `/config` 中设置。

| 选项              | 默认值   | 含义                                                                  |
| ----------------- | -------- | --------------------------------------------------------------------- |
| `ttl`             | `auto`   | 缓存有效期：`auto` 按 Claude Code 的规则和请求间隔推断；`5m` / `1h` 固定 |
| `warnSeconds`     | `60`     | 剩余多少秒时状态条变黄并弹出提醒                                      |
| `compactAtTokens` | `100000` | prompt 达到这个大小后，缓存过期时建议 `/compact`                      |
| `band`            | `true`   | 在输入框上方显示状态条                                                |
| `status`          | `false`  | 同时在输入框下方显示命中率和倒计时                                    |
| `toast`           | `true`   | 临近过期时弹出提醒                                                    |
| `idleCompact`     | `true`   | 显示空闲压缩倒计时和提示                                              |

## 环境要求

Claude Code 2.1.287+（已在 2.1.304 上验证）。

## 安装

```
/plugin install cache-meter@my-better-claude
```
