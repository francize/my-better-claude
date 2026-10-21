# queue

[English](README.md) | 中文

一个不会 steer 的 Claude Code 消息队列。默认情况下，Claude 工作时输入的消息会在下一步被塞进正在运行的这一轮，从而改变 Claude 正在做的事。装上这个 mod 后，忙时按 Enter 会把消息放进队列，等当前这一轮结束后再作为单独的一轮发出。

## 界面

- **输入框上方的条**，队列非空时显示：
  ```
  ▾ Queued 2
    #1 hi                                        [ Send now ] [ edit ] [ cancel ]
    #2 run the tests                             [ Send now ] [ edit ] [ cancel ]
  ```
  点 `▾` 折叠。其他 mod 的条（如 cache-meter）保留，显示在队列下方
- **Send now**：打断当前这一轮，立即发送这条；空闲时直接发送
- **edit**：从队列取出，放回输入框；改完按 Enter 会重新入队
- **cancel**：删除这条

## 行为

- 只拦截你自己在运行中按下的 Enter；斜杠命令、后台任务通知、其他会话发来的消息照旧
- 一轮以正常回答结束后，按顺序发出下一条，每轮一条；按了 Esc、被拒绝或出错时，队列暂停等待，条上显示 `waiting: Send now to go on`
- 模型在轮到之前读不到排队的消息：Enter 时就被拦下，`/queue <prompt>` 的参数也会从 transcript 中清掉
- 带粘贴图片的消息无法排队（mod 发出的 prompt 不能携带图片），会照旧进入当前这一轮，并弹出提示
- 没有模型轮次在跑时，`/queue` 的消息留在横条里，等你点 Send now 再发：可能有 `!` shell 命令在跑，而 Claude Code 不会告诉 mod。`!` 命令运行期间直接按 Enter 不算模型轮次，由 Claude Code 照常排队
- 一次只交给 Claude Code 一条，由它在空闲后执行。执行前显示为 `→ … sending`；若被从 Claude Code 自己的队列移除（Esc），会回到队首
- transcript 中发出的消息显示为 `Prompt from the queue plugin`：Claude Code 会标出发送它的插件，但模型读到的就是你本人的话
- 恢复的会话（`claude --resume`）会找回队列，等你手动发出第一条

## 命令

| 命令              | 作用                                 |
| ----------------- | ------------------------------------ |
| `/queue <prompt>` | 排队一条消息；没有模型轮次在跑时，留在横条里等 Send now |

## 选项

在 `/config` 中设置。

| 选项          | 默认   | 含义                                                                        |
| ------------- | ------ | --------------------------------------------------------------------------- |
| `enterQueues` | `true` | 忙时 Enter 进入队列；关闭后 Enter 照旧 steer，ctrl+x enter 与 `/queue` 仍排队 |

## 要求

Claude Code 2.1.304（编写与验证所用的版本）。

## 安装

```
/plugin install queue@my-better-claude
```

## 致谢

思路来自 midudev 的 [After](https://github.com/midudev/better-claude)（MIT）。
