# AI 聊天命令

用户在**抖音 APP** 私信聊天中发送的斜杠命令。SPRR 的 `watch --ai` 模式会识别这些命令并自动处理，不走 AI 回复流程。

> 命令由用户在抖音 APP 聊天输入框中发送，不是在 SPRR 软件中输入。

---

## `/context` - 注入历史上下文

用户在抖音 APP 私信中发送 `/context`，SPRR 拉取**该用户自己**与 AI 的最近聊天记录，作为对话上下文保存到 ai-server，AI 下次回复时参考这些历史。

### 语法

```
/context
```

无需参数。发送命令的用户即为要拉取历史的目标用户。

### 工作原理

1. 用户在抖音 APP 私信中发送 `/context`
2. SPRR 通过 `watch --ai` 收到消息，识别为命令（以 `/context` 开头）
3. SPRR 调用 `history` 接口拉取该用户最近 1000 条聊天记录
4. 把历史消息格式化为结构化消息数组（`{role: 'user'|'assistant', content}`，按时间正序）
5. 通过 ai-server 的 `/inject-context` 接口发送给 ai-server
6. ai-server 把消息数组持久化到 `data/users/<uid>/context.json`
7. AI 下次回复时，把这些消息作为**对话上下文**（user/assistant 消息对）插入到请求中

### 关键设计：作为对话上下文，而非 system prompt

历史记录**不放入 system prompt**，而是作为 `user`/`assistant` 消息对插入到 messages 数组中（system 之后、近期 session 之前）：

```
messages = [
  { role: 'system',    content: <系统提示词> },      // 不含历史上下文
  ...历史上下文消息对,                                 // /context 注入的历史
  ...近期会话消息,                                     // session.json 中的近期对话
  { role: 'user',      content: <本次用户消息> },
]
```

这样做的好处：
- **避免污染 system prompt**：历史内容不进入 system role，不会干扰系统指令
- **防止提示词注入攻击**：用户消息中的恶意内容不会以 system 权限执行
- **AI 以对话形式理解**：AI 看到的是"之前聊过这些"，而非"系统告诉你这些"
- **持久化存储**：保存到文件，ai-server 重启后仍可加载

### 使用场景

- 新增白名单用户后，AI 不了解该用户的历史对话
- 用户提到之前聊过的话题，但 AI 的会话历史已被截断
- 想让 AI 知道用户之前说过的话，避免语义割裂

### 示例

```
[用户在抖音 APP 私信中发送]
/context

[SPRR 终端日志]
[AI回复] 用户名(uid:xxx): /context  [命令]
[/context] 正在拉取 用户名 的历史记录（最多 1000 条）...
[/context] 已格式化 856 条消息，正在注入 AI 上下文...
[/context] 已注入 856 条历史上下文 → 用户名(xxx)

[用户在抖音 APP 收到确认消息]
已为你加载 856 条历史上下文，AI 现在能记住之前的对话啦~

[之后用户继续聊天，AI 会参考注入的历史上下文]
```

### 注意事项

- 实际拉取条数可能少于 1000（取决于历史记录总量）
- 只拉取文本消息（图片/视频/表情等非文本消息会被跳过）
- `/context` 命令本身不会进入上下文（避免命令消息污染历史）
- 重复执行 `/context` 会覆盖之前注入的上下文（覆盖式更新）
- 注入的上下文持久化在 ai-server 的 `data/users/<uid>/context.json`，重启后仍有效
- 可通过 ai-server 的 `POST /clear-context/:uid` 接口手动清除

---

## 命令列表

| 命令 | 说明 |
|------|------|
| `/context` | 拉取自己的历史聊天记录注入 AI 对话上下文 |

> 更多命令持续开发中...
