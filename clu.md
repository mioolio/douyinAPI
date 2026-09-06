# SPRR 命令使用手册

抖音私信聊天自动化工具（纯 API 逆向版）的完整命令参考。
>声明
> 
> 本项目仅供学习参考和思路研究使用。  
> 若内容涉及侵权，请联系邮箱 [islont@proton.me] 进行下架处理
> 
> 项目开发初衷是打造虚拟恋人，为Ai提供简单的命令
> 
>---

## 目录

- [运行方式](#运行方式)
- [全局选项](#全局选项)
- [账号管理](#账号管理)
  - [login - 扫码登录](#login---扫码登录)
  - [accounts - 列出账号](#accounts---列出账号)
  - [use - 切换账号](#use---切换账号)
  - [logout - 删除账号](#logout---删除账号)
  - [whoami - 查看当前账号](#whoami---查看当前账号)
  - [cookie - 用 cookie 字符串登录](#cookie---用-cookie-字符串登录)
  - [cookie-file - 从文件读取 cookie 登录](#cookie-file---从文件读取-cookie-登录)
- [会话与消息](#会话与消息)
  - [list - 列出会话](#list---列出会话)
  - [rename - 设置备注名](#rename---设置备注名)
  - [history - 拉取聊天记录](#history---拉取聊天记录)
  - [send - 发送文本消息](#send---发送文本消息)
  - [send-image - 发送图片消息](#send-image---发送图片消息)
  - [recall - 撤回消息](#recall---撤回消息)
  - [reply - 引用回复](#reply---引用回复)
  - [send-sticker - 发送表情贴纸](#send-sticker---发送表情贴纸)
  - [watch - 实时监控推送](#watch---实时监控推送)
- [AI 自动回复](#ai-自动回复)
  - [ai - 白名单管理](#ai---白名单管理)
  - [watch --ai - 开启自动回复](#watch---ai---开启自动回复)
  - [人设文件格式](#人设文件格式)
  - [ai-server 独立服务](#ai-server-独立服务)
- [资料与互动](#资料与互动)
  - [profile - 查看主页](#profile---查看主页)
  - [edit-profile - 修改资料](#edit-profile---修改资料)
  - [notices - 互动消息](#notices---互动消息)
  - [noticedetail - 通知详情](#noticedetail---通知详情)
- [视频与表情收藏](#视频与表情收藏)
  - [video - 视频详情](#video---视频详情)
  - [collect-sticker - 收藏表情](#collect-sticker---收藏表情)
- [视频与评论交互](#视频与评论交互)
  - [awemedetail - 视频详情（通知来源）](#awemedetail---视频详情通知来源)
  - [comments - 评论列表](#comments---评论列表)
  - [comment - 发布评论/回复](#comment---发布评论回复)
  - [ticket-guard - 管理浏览器加密签名头](#ticket-guard---管理浏览器加密签名头)
- [抓包与调试](#抓包与调试)
  - [debug-capture 抓包脚本](#debug-capture-抓包脚本)
  - [使用流程](#使用流程)
  - [输出目录与汇总格式](#输出目录与汇总格式)
  - [2026 年 8 月 API 变化记录](#2026-年-8-月-api-变化记录)
- [贡献指南](#贡献指南)
  - [贡献类型](#贡献类型)
  - [代码认领方向](#代码认领方向)
  - [贡献流程](#贡献流程)
  - [代码规范](#代码规范)
- [常见问题](#常见问题)

---

## 运行方式

本项目推荐使用 **V2 交互式 REPL** 入口（`src/indexv2.ts`）：启动后进入交互式提示符 `◆ sprr> `，执行完命令不退出，可继续输入下一条命令，会话/联系人自动缓存复用。

### 1. 开发模式（推荐，无需编译）

```bash
npx tsx src/indexv2.ts [全局选项]
```

进入 REPL 后直接输入命令：

```
◆ sprr> list
◆ sprr> send --to TwT --text "你好"
◆ sprr> watch --ai
◆ sprr> exit
```

### 2. 旧版单次执行模式（V1）

如需脚本化单次执行（执行完即退出），仍可用 V1 入口：

```bash
npx tsx src/index.ts <命令> [选项]
```

### 3. 生产模式（需先编译）

```bash
npm run build
node dist/indexv2.js
```

> 下文为简洁起见，统一用 `sprr` 代表运行命令。REPL 模式请直接在 `◆ sprr> ` 提示符后输入命令；脚本化请用 `npx tsx src/indexv2.ts` 后接命令。

### REPL 内置命令

| 命令 | 说明 |
|------|------|
| `help` | 显示帮助 |
| `clear` | 清屏 |
| `reload` | 清除会话/联系人缓存（切换账号后使用） |
| `exit` | 退出 REPL |

---

## 全局选项

所有命令都支持以下全局选项，须放在子命令之前：

```bash
sprr [--verbose] [--json] [--state <path>] [--account <name>] [--cookie <string>] <命令> [命令选项]
```

| 选项 | 说明 |
|------|------|
| `--verbose` | 输出 DEBUG 级别日志，便于排查问题 |
| `--json` | 以 JSON 格式输出结果（便于程序处理） |
| `--state <path>` | 指定 storageState 文件路径（优先级最高） |
| `--account <name>` | 临时使用指定账号，不修改当前账号指针 |
| `--cookie <string>` | 直接使用 cookie 字符串（优先级最高，无需登录） |

**示例：**

```bash
# REPL 模式启动
npx tsx src/indexv2.ts --verbose

# 临时使用 other 账号
npx tsx src/indexv2.ts --account other
```

---

## 账号管理

### `login` - 扫码登录

启动浏览器扫码登录抖音，保存为指定账号并自动设为当前账号。

登录成功后会**自动获取 ticket-guard 三头**（评论发布必需的浏览器加密签名头），无需单独运行 `ticket-guard` 命令。

```bash
sprr login <name> [--timeout <ms>] [--url <url>]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 账号名称（仅小写字母、数字、横线） |
| `--timeout` | 否 | 登录超时毫秒数，默认 300000（5 分钟） |
| `--url` | 否 | 登录页 URL，默认 `https://www.douyin.com/`。火山版等特殊账号需指定 `https://creator.douyin.com/` |

**示例：**

```
◆ sprr> login myaccount
◆ sprr> login work --timeout 600000
◆ sprr> login volcano --url https://creator.douyin.com/
```

> 注意：登录需要 playwright，若报 `Cannot find module 'playwright'`，运行 `npm install playwright`。
> 登录时不再限制浏览器新标签页（火山版等特殊账号需通过新标签页完成登录流程）。

---

### `accounts` - 列出账号

列出所有已保存的账号，标记当前账号。

```bash
sprr accounts
```

---

### `use` - 切换账号

切换当前默认账号（自动清除缓存）。

```bash
sprr use <name>
```

---

### `logout` - 删除账号

删除指定账号的本地 storageState（不影响抖音服务器登录态）。

```bash
sprr logout <name> [-f]
```

| 选项 | 说明 |
|------|------|
| `-f, --force` | 跳过确认提示 |

---

### `whoami` - 查看当前账号

显示当前账号、登录态、保存时间。

```bash
sprr whoami
```

---

### `cookie` - 用 cookie 字符串登录

直接使用 cookie 字符串登录（适用于从 APP 抓包的实时有效 cookie）。无需启动浏览器，无需 playwright。

```bash
sprr cookie <string>
```

**示例：**

```
◆ sprr> cookie "uid_tt=xxx; sessionid=yyy; ..."
```

> 登录后会在终端显示小猫 ASCII 艺术和 cookie 数量。可直接用 `list` 验证登录状态。

---

### `cookie-file` - 从文件读取 cookie 登录

从文件读取 cookie 字符串登录（文件内容为纯 cookie 文本）。

```bash
sprr cookie-file <path>
```

**示例：**

```
◆ sprr> cookie-file ./my-cookie.txt
```

---

## 会话与消息

### `list` - 列出会话

列出所有会话（联系人），自动批量获取昵称。按最近消息时间排序，最多拉取 500 个会话（抖音接口限制）。

```bash
sprr list
```

**输出字段：** 序号 / 昵称 / UID / 未读数 / 会话 ID

---

### `rename` - 设置备注名

为指定用户设置本地备注名，便于通过昵称查找。

```bash
sprr rename --uid <uid> --name <昵称>
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--uid` | 是 | 目标用户 UID |
| `--name` | 是 | 备注名 |

---

### `history` - 拉取聊天记录

获取指定会话的聊天记录，支持分页拉取大量历史。

```bash
sprr history [--to <target>] [--cid <conversationId>] [--limit <count>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--to` | 否 | 目标用户 UID 或昵称，默认 `TwT` |
| `--cid` | 否 | 直接指定会话 ID（优先于 `--to`） |
| `--limit` | 否 | 拉取条数，默认 30，可设为 500/1000 拉取更多 |

**输出字段（每条消息）：** 时间 / 类型标签 / 发送方（我/对方/服务器） / 内容 / serverMsgId

**消息类型标签：** 文本 / 分享视频 / AI回复 / 系统提示 / 图片 / 表情 / 撤回 / 未知

**示例：**

```
◆ sprr> history
◆ sprr> history --to TwT --limit 100
◆ sprr> history --cid "0:1:xxx:xxx" --limit 500
```

---

### `send` - 发送文本消息

向指定用户发送文本消息。默认使用浏览器发送（自动签名），`--native` 切换纯 Node.js 原生发送。

```bash
sprr send -t <text> [--to <target>] [--native] [--show-browser]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `-t, --text` | 是 | 消息内容 |
| `--to` | 否 | 目标用户 UID 或昵称，默认 `TwT` |
| `--native` | 否 | 使用纯 Node.js 原生发送（需手动签名，可能失败） |
| `--show-browser` | 否 | 显示浏览器窗口（默认无头模式） |

---

### `send-image` - 发送图片消息

向指定用户发送图片消息（自动上传到 TOS）。

```bash
sprr send-image -i <path> [--to <target>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `-i, --image` | 是 | 图片文件路径 |
| `--to` | 否 | 目标用户 UID 或昵称，默认 `TwT` |

---

### `recall` - 撤回消息

撤回指定消息，默认撤回最近一条自己发送的消息。

```bash
sprr recall [--to <target>] [--cid <conversationId>] [--msg-id <serverMsgId>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--to` | 否 | 目标用户 UID 或昵称，默认 `TwT` |
| `--cid` | 否 | 直接指定会话 ID（优先于 `--to`） |
| `--msg-id` | 否 | 指定撤回的 server_message_id，不指定则取最近一条自己发的消息 |

---

### `reply` - 引用回复

引用指定消息进行回复。

```bash
sprr reply -t <text> -r <serverMsgId> [--to <target>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `-t, --text` | 是 | 回复内容 |
| `-r, --ref` | 是 | 被引用消息的 server_message_id |
| `--to` | 否 | 目标用户 UID 或昵称，默认 `TwT` |

---

### `send-sticker` - 发送表情贴纸

发送表情贴纸消息，支持两种模式：

```bash
# 模式 A：从历史消息提取（转发对方发来的表情）
sprr send-sticker -m <serverMsgId> [--to <target>]

# 模式 B：从 JSON 文件读取
sprr send-sticker -s <path> [--to <target>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `-s, --sticker` | 否 | sticker 信息 JSON 文件路径 |
| `-m, --from-msg` | 否 | 从历史 sticker 消息中提取信息 |
| `--to` | 否 | 目标用户 UID 或昵称，默认 `TwT` |

> 必须指定 `--sticker` 或 `--from-msg` 之一。

---

### `watch` - 实时监控推送

实时监控新消息（Ctrl+C 返回 REPL）。默认使用 **HTTP 轮询模式**（2026-08 新协议，纯 Node 直连，无需浏览器），`--ws` 切回旧版 WebSocket 模式。

```bash
sprr watch [--interval <ms>] [--to <target>] [--ws] [--access-key <key>] [--device-id <uid>] [--raw] [--ai]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--interval` | 否 | 轮询间隔毫秒（仅轮询模式），默认 3000（官方客户端实测约 3~6 秒） |
| `--to` | 否 | 仅监控指定会话，默认监控所有会话 |
| `--ws` | 否 | 使用旧版 Frontier WebSocket 推送（2026-08 前协议，官方已下线，留档/回退用） |
| `--access-key` | 否 | 仅 `--ws` 模式：手动指定 access_key，不指定则自动从浏览器提取 |
| `--device-id` | 否 | 仅 `--ws` 模式：设备 ID（即用户 UID），默认自动检测 |
| `--raw` | 否 | 仅 `--ws` 模式：显示原始帧，便于调试 |
| `--ai` | 否 | **开启 AI 自动回复**（仅白名单内用户会收到回复，详见 [AI 自动回复](#ai-自动回复)） |

**轮询模式工作原理（默认）：**
1. `cmd=2043` 调用 `/v1/message/get_message_by_init` 初始化同步，取得初始游标（消息游标微秒时间戳 + 收件箱序号）
2. `cmd=2048` 按间隔调用 `/v1/message/get_user_message` 轮询，解析新消息与会话事件（已读回执等），跟随服务端推进游标
3. 连续失败 5 次自动重新 init 重建游标；按 `serverMsgId` 去重防止重复处理
4. **无需 playwright / 无需浏览器**：imapi 接口仅需 Cookie（无 a_bogus/msToken 签名），纯 Node.js 直连

**旧版 WS 模式工作原理（`--ws`）：**
1. 通过 Playwright 启动无头浏览器，导航到 `douyin.com/chat`
2. 拦截浏览器自身建立的 Frontier WebSocket 连接，提取 `access_key`
3. 提取后关闭浏览器，Node.js 带 Cookie 直连 WebSocket
4. 收到推送后解析 protobuf 帧，显示消息内容

**示例：**

```
# 监控所有会话（默认轮询模式）
◆ sprr> watch

# 监控并开启 AI 自动回复
◆ sprr> watch --ai

# 仅监控指定会话
◆ sprr> watch --to TwT

# 自定义轮询间隔（毫秒）
◆ sprr> watch --interval 5000

# 调试模式（仅 --ws）
◆ sprr> watch --ws --raw
```

---

## AI 自动回复

SPRR 支持 AI 自动回复功能：当白名单内的用户发来文本消息时，自动调用 AI 生成回复并发送。

### 架构说明

AI 自动回复采用**双服务架构**：

```
┌─────────────────┐         ┌─────────────────┐         ┌──────────────┐
│   SPRR (CLI)    │ ──HTTP──│  ai-server      │ ──HTTPS─│   DeepSeek   │
│                 │  /chat  │  (本地 7860)    │         │   云端 API   │
│ - WebSocket 监听│         │                 │         └──────────────┘
│ - 白名单管理     │         │ - 会话历史存档  │
│ - 消息发送       │         │ - 人设管理      │
│                 │        │ - 流式调用 LLM  │
└─────────────────┘         └─────────────────┘
```

- **SPRR**：负责监听消息推送、白名单管理、消息发送
- **ai-server**：独立服务，负责管理会话历史、人设、调用 DeepSeek
- **白名单**：存储在 SPRR 本地（`data/ai-whitelist.json`），管理白名单无需启动 ai-server

### 消息处理流程

1. WebSocket 推送收到新消息 → SPRR 收到通知
2. 调用 `getHistory` 拉取权威消息列表（不依赖 WS 推送的方向字段，避免被混淆）
3. 找到最新的、对方发送的、未处理的文本消息（按 `serverMsgId` 去重，允许相同文本）
4. 调用 ai-server `/chat` 接口，ai-server 拼接人设 + 历史上下文调 DeepSeek
5. 收到 AI 回复后，SPRR 发送消息给对方
6. AI 回复的推送回来时，history 显示 `isSelf=true`，自动跳过，避免循环回复

**节流机制（防风控）：** 同一会话 5 秒内多次推送合并为一次 history 查询，避免频繁调用触发抖音风控。

---

### `ai` - 白名单管理

管理 AI 自动回复的白名单。白名单存储在 SPRR 本地文件，**无需启动 ai-server 即可管理**。

```bash
sprr ai [--add <uid>] [--del <uid>] [--list] [--refresh]
```

| 选项 | 说明 |
|------|------|
| `--add <uid>` | 添加用户到白名单 |
| `--del <uid>` | 从白名单移除用户 |
| `--list` | 查看当前白名单 |
| `--refresh` | 从本地文件重新加载白名单 |

**示例：**

```
# 添加用户到白名单
◆ sprr> ai --add 517231230585881

# 查看白名单
◆ sprr> ai --list

# 移除用户
◆ sprr> ai --del 517231230585881
```

> 提示：先用 `list` 命令查看联系人 UID，再用 `ai --add <uid>` 添加。注意 UID 是纯数字（如 `517231230585881`），不是 serverMsgId。

---

### `watch --ai` - 开启自动回复

启动 WebSocket 监听并开启 AI 自动回复：

```
◆ sprr> watch --ai
```

**启动后会显示：**
- 当前账号 UID
- 白名单加载结果（用户数量 + UID 列表）
- WebSocket 连接状态
- 实时消息推送日志

**消息日志格式：**

```
[新消息] TwT | 对方: 嘿嘿              ← 对方发的消息
[新消息] TwT | 我: (AI回复内容)        ← 自己/AI 发的消息
[新消息] TwT | 我: (非文本消息)        ← 图片/表情/视频等
```

**调试日志（`--verbose` 模式）：**

```
[watch调试] senderUid=517231230585881 myUid=1196717705541576 isSelf=false direction=1 msgType=500 cid=...
[AI回复调试] history 返回 10 条, myUid=1196717705541576:
[AI回复调试]   id=7670243957838349882 ts=02:24:05 isSelf=false isRobot=false cat=text senderId=517231230585881 text="坏坏"
[AI回复调试] 选中 target: id=7670243957838349882 ts=... text="坏坏"
[AI回复] TwT(517231230585881): 坏坏
[AI回复] 已回复 TwT: （歪头看着你，猫耳朵轻轻抖动）...
```

---

### 人设文件格式

人设文件位于 `ai-server/personas/` 目录，JSON 格式，人类可读可修改。

**文件命名：**
- `default.json` — 全局默认人设
- `<uid>.json` — 指定用户的专属人设（如 `517231230585881.json`）

**四字段结构：**

```json
{
  "name": "人设名称",
  "description": "简短描述",

  "systemPrompt": "核心规则（身份隐藏、禁忌、不懂的回复方式等）",

  "identity": {
    "名字": "小嘴",
    "年龄": "12岁相当",
    "性格": "...",
    "外貌": {
      "发型发色": "...",
      "猫耳": "..."
    }
  },

  "background": {
    "身份认知": "...",
    "与主人关系": "...",
    "生活场景": "..."
  },

  "tone": {
    "口癖": "句末时不时加「喵」",
    "回复长度": "2~4句为宜",
    "暧昧边界": "可以有一点俏皮的撩拨，但绝不深入色情"
  }
}
```

| 字段 | 类型 | 作用 |
|------|------|------|
| `systemPrompt` | string | 核心规则（身份隐藏、禁忌词、不懂的回复方式） |
| `identity` | object | 身份设定（名字、年龄、身高、性格、外貌，支持嵌套） |
| `background` | object | 背景设定（与主人关系、生活场景、禁忌话题绕开方式） |
| `tone` | object | 语气与行为风格（口癖、回复长度、语言风格、暧昧边界） |

ai-server 启动时会自动把四个字段按 `systemPrompt → 身份设定 → 背景设定 → 语气风格` 顺序拼接成完整的 system prompt 发给 LLM。修改人设文件后重启 ai-server 生效。

---

### ai-server 独立服务

ai-server 是独立的 Node.js 服务，提供 HTTP API 供 SPRR 调用，负责管理会话历史、人设、调用 DeepSeek。

**启动：**

```bash
cd ai-server
node server.js
```

**配置文件** `ai-server/config.json`：

```json
{
  "port": 7860,
  "deepseekApiKey": "sk-xxx",
  "deepseekModel": "deepseek-chat",
  "deepseekBaseUrl": "https://api.deepseek.com"
}
```

**会话存档：**
- 会话历史：`ai-server/data/sessions/<uid>.json`（每用户独立，含完整上下文）
- 单轮存档：`ai-server/data/turns/<uid>/<timestamp>.json`（每轮对话独立存档）

**API 接口：**

| 接口 | 方法 | 说明 |
|------|------|------|
| `POST /chat` | POST | 对话接口，参数：`uid`、`message`、`stream`（可选） |

> 白名单管理已迁移到 SPRR 本地，ai-server 不再处理白名单校验，SPRR 端完全控制哪些用户触发 AI 回复。

---

## 资料与互动

### `profile` - 查看主页

获取当前账号主页信息。

```bash
sprr profile
```

**输出字段：** 昵称 / 抖音号 / UID / sec_uid / 简介 / 关注 / 粉丝 / 获赞 / 作品 / 地区 / 绑定手机 / 头像

---

### `edit-profile` - 修改资料

修改个人资料（昵称、简介、头像），至少指定一项。

```bash
sprr edit-profile [--nickname <text>] [--signature <text>] [--avatar <path>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--nickname` | 否 | 新昵称 |
| `--signature` | 否 | 新简介 |
| `--avatar` | 否 | 头像本地文件路径 |

> 此命令使用 a_bogus 签名（由 `src/crypto/abogus.ts` 纯算生成）。

---

### `notices` - 互动消息

获取互动消息列表（点赞、评论、新粉丝等）。

```bash
sprr notices [--count <n>] [--max <n>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--count` | 否 | 每页数量，默认 20 |
| `--max` | 否 | 最大拉取条数，默认 50 |

> type=45（@提及）的通知会自动从 `at.schema_url` 解析 `comment_id`，便于后续回复评论。

---

### `noticedetail` - 通知详情

按 `notice_id` 获取单条通知完整详情，特别是 @提及通知的跳转参数（含 `aweme_id` 和 `cid`）。

```bash
sprr noticedetail --nid <notice_id>
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--nid` | 是 | 通知 ID（可从 `notices` 命令输出获取） |

> 此命令使用 a_bogus 签名（调用 `/aweme/v1/web/notice/detail/` 接口）。

**输出字段：** 时间 / 类型 / 已读 / 触发用户 / 关联视频 / 关联评论 / 跳转链接 / 跳转文案 / 标签

典型工作流：先 `notices` 找到目标通知 nid，再用 `noticedetail` 拿到 `aweme_id` 和 `comment_id`，然后调用 `awemedetail`/`comments`/`comment` 完成互动。

---

## 视频与表情收藏

### `video` - 视频详情

查看视频分享详情，支持从历史消息提取或直接指定 aweme_id。

```bash
sprr video [--to <target>] [--aweme-id <id>] [--msg-id <serverMsgId>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--to` | 否 | 目标用户 UID 或昵称，默认 `TwT` |
| `--aweme-id` | 否 | 视频 aweme_id（直接指定，优先于 `--msg-id`） |
| `--msg-id` | 否 | 从历史视频分享消息中提取 aweme_id |

> 必须指定 `--aweme-id` 或 `--msg-id` 之一。此命令使用 a_bogus 签名。

**输出字段：** 视频 ID / 标题 / 作者 / 时长 / 点赞 / 评论 / 分享 / 封面 / 播放地址

---

### `collect-sticker` - 收藏表情

收藏或取消收藏表情贴纸。

```bash
sprr collect-sticker -m <serverMsgId> [--to <target>] [--action <n>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `-m, --msg-id` | 是 | sticker 消息的 server_message_id |
| `--to` | 否 | 目标用户 UID 或昵称，默认 `TwT` |
| `--action` | 否 | 1=收藏（默认），0=取消收藏 |

> 此命令使用 a_bogus 签名。

---

## 视频与评论交互

本节命令用于通知来源视频解析与评论互动，典型流程为：`notices` → `noticedetail` → `awemedetail`/`comments` → `comment`。

### `awemedetail` - 视频详情（通知来源）

查询单个视频详情，用于解析通知来源视频。

```bash
sprr awemedetail --aweme-id <id> [--ticket-guard-client-data <v>] [--ticket-guard-ree-public-key <v>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--aweme-id` | 是 | 视频 aweme_id（可从 `notices`/`noticedetail` 命令获取） |
| `--ticket-guard-client-data` | 否 | `bd-ticket-guard-client-data` 头值，GET 接口通常可省略，仅风控触发时使用 |
| `--ticket-guard-ree-public-key` | 否 | `bd-ticket-guard-ree-public-key` 头值 |

> 此命令使用 a_bogus 签名（GET `/aweme/v1/web/aweme/detail/`）。

---

### `comments` - 评论列表

获取视频评论列表，支持分页拉取。

```bash
sprr comments --aweme-id <id> [--cursor <n>] [--count <n>] [--max <n>] \
  [--ticket-guard-client-data <v>] [--ticket-guard-ree-public-key <v>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--aweme-id` | 是 | 视频 aweme_id |
| `--cursor` | 否 | 分页游标，默认 0，下一页用上一页返回的 cursor |
| `--count` | 否 | 每页数量，默认 10 |
| `--max` | 否 | 最大拉取条数，默认 30 |
| `--ticket-guard-client-data` | 否 | `bd-ticket-guard-client-data` 头值，GET 接口通常可省略 |
| `--ticket-guard-ree-public-key` | 否 | `bd-ticket-guard-ree-public-key` 头值 |

> 此命令使用 a_bogus 签名（GET `/aweme/v1/web/comment/list/`）。

---

### `comment` - 发布评论/回复

发布顶级评论或回复指定评论。**ticket-guard 三头会自动从 `data/ticket-guard.json` 加载**，无需每次手动传入。

```bash
sprr comment --aweme-id <id> --text <content> \
  [--reply-id <cid>] [--at-uid <uid>] [--at-sec-uid <sec_uid>] \
  [--ticket-guard-client-data <v>] [--ticket-guard-ree-public-key <v>] [--tt-session-dtrait <v>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--aweme-id` | 是 | 目标视频 aweme_id |
| `--text` | 是 | 评论内容 |
| `--reply-id` | 否 | 被回复评论 cid，不传则发布顶级评论 |
| `--at-uid` | 否 | @用户 uid，多个用逗号分隔 |
| `--at-sec-uid` | 否 | @用户 sec_uid，与 `--at-uid` 一一对应，逗号分隔 |
| `--ticket-guard-client-data` | 否 | 手动指定 `bd-ticket-guard-client-data` 头值（优先于配置文件） |
| `--ticket-guard-ree-public-key` | 否 | 手动指定 `bd-ticket-guard-ree-public-key` 头值 |
| `--tt-session-dtrait` | 否 | 手动指定 `x-tt-session-dtrait` 头值 |

> 重要说明：评论发布接口强制校验 `bd-ticket-guard-*` 和 `x-tt-session-dtrait` 三个头。这三个头由浏览器 secsdk（webmssdk.es5.js，VM 字节码保护）生成。**`sprr login` 登录时会自动获取这三个头**并保存到 `data/ticket-guard.json`，后续 `comment` 命令自动加载。三头在同一会话内稳定可复用，会话失效（cookie 过期）后重新登录或运行 `ticket-guard --auto` 刷新即可。

**三头加载优先级：**

1. CLI 手动指定的 `--ticket-guard-client-data` / `--ticket-guard-ree-public-key` / `--tt-session-dtrait`（三者必须同时提供）
2. `data/ticket-guard.json` 中已保存的配置（由 `login` 或 `ticket-guard --auto` 生成）
3. 首次运行 `comment` 时若配置文件不存在，会自动启动无头浏览器获取三头（等同于运行 `ticket-guard --auto`），获取成功后保存到配置文件供后续复用

---

### `ticket-guard` - 管理浏览器加密签名头

管理评论发布所需的 `bd-ticket-guard-client-data` / `bd-ticket-guard-ree-public-key` / `x-tt-session-dtrait` 三个浏览器加密签名头。配置保存在 `data/ticket-guard.json`，由 `comment` 命令自动加载。

**正常使用无需手动运行此命令** —— `sprr login` 登录时会自动获取三头。本命令仅用于以下场景：
- 三头过期后刷新（默认 24 小时有效期）
- 登录时自动获取失败后重试
- 调试或查看当前配置

```bash
# 刷新三头（推荐，启动无头浏览器自动获取）
sprr ticket-guard --auto

# 从抓包数据提取（开发者模式，需要先有 comment_publish 抓包样本）
sprr ticket-guard --from-capture

# 手动导入（从浏览器 DevTools 复制后粘贴）
sprr ticket-guard --client-data <v> --ree-public-key <v> --session-dtrait <v>

# 查看当前已保存的配置
sprr ticket-guard --show
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--auto` | 否 | 启动无头 Chromium 浏览器，加载用户 storageState 后自动触发 secsdk 生成三头并保存 |
| `--from-capture` | 否 | 扫描 `data/capture/interact/requests/` 下最新的 `comment_publish` 抓包样本提取三头（开发者模式） |
| `--client-data` | 否 | 手动指定 `bd-ticket-guard-client-data` 头值（须与 `--ree-public-key`、`--session-dtrait` 同时提供） |
| `--ree-public-key` | 否 | 手动指定 `bd-ticket-guard-ree-public-key` 头值 |
| `--session-dtrait` | 否 | 手动指定 `x-tt-session-dtrait` 头值 |
| `--show` | 否 | 显示当前已保存的配置（含来源、获取时间、过期状态） |

> 技术说明：三个头由浏览器 secsdk（webmssdk.es5.js，VM 字节码保护）在运行时生成，会话内静态稳定。逆向分析确认 `ree_public_key` 是客户端 ECDH 公钥、ECDH 共享密钥可本地计算，但 `req_sign` 的 HMAC 密钥派生和 `x-tt-session-dtrait` 的生成使用 VM 保护的自定义 KDF，无法在纯 Node.js 中复现。因此采用浏览器拦截方案：加载 cookie → 导航视频页 → secsdk 初始化 → 拦截无效 `comment_publish` 请求（aweme_id=0，不会真的发评论）→ 提取三头。

**何时需要重新获取三头：**

- `ticket-guard --show` 提示「可能已过期」（默认 24 小时有效期）
- `comment` 命令返回风控码或空响应
- 重新登录账号后（cookie 变化导致会话失效）
- 切换到不同账号时

> `comment` 命令在缺失三头时会自动触发浏览器获取流程，无需用户手动运行 `ticket-guard --auto`。

---

## 抓包与调试

当接口变更导致功能失效时，可通过抓包工具采集最新协议数据，辅助逆向分析。

### debug-capture 抓包脚本

`SPRR/scripts/debug-capture.ts` 基于 Playwright 实现，可完整捕获浏览器侧的 HTTP 请求与 WebSocket 帧，并在终止时输出结构化汇总报告，用于识别新增 cmd 编号、接口路径、请求参数、签名头变化等。

启动方式：

```bash
cd SPRR
npx tsx scripts/debug-capture.ts
```

脚本依赖：Playwright 与 Chromium。若首次运行提示缺少浏览器，请执行 `npx playwright install chromium`。

### 使用流程

1. 脚本启动 Chromium（默认显示界面，便于手动操作）并自动导航到 `https://www.douyin.com/`
2. 在浏览器中完成目标操作：扫码登录、发送消息、接收仅读一次、发表评论、查看通知等
3. 完成操作后，在运行脚本的终端按下 `Ctrl+C` 终止抓包进程
4. 脚本将在终端打印汇总报告，并将完整数据写入本地目录

汇总报告包含以下内容：
- 本次抓取的 HTTP 请求总数、WebSocket 连接数与帧数
- 按 cmd 编号分组的请求列表（含 URL、方法、请求体大小、响应状态码）
- 未知 cmd 编号提醒（标记为「未知 cmd」，是新增 API 的重要线索）
- 签名参数汇总（query 参数中出现的 a_bogus、msToken 等）
- 请求头汇总（特别是 `bd-ticket-guard-*` 系列与 `x-tt-session-dtrait`）

### 输出目录与汇总格式

每次抓包生成独立的输出目录：

```
SPRR/data/capture/debug/debug-YYYYMMDD-HHMMSS/
├── requests/        # 单请求 JSON，包含完整 headers、query、body、response body
├── frames/          # WebSocket 原始帧数据与方向标注
└── summary.json     # 汇总报告（结构化 JSON，便于程序读取）
```

`summary.json` 核心字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| capturedAt | string | ISO 时间戳 |
| httpRequests | array | 全部 HTTP 请求摘要（cmd、url、headers、query、响应片段） |
| websocketFrames | array | WS 帧（方向、cmd、payload、protobuf 原始字节） |
| unknownCmds | array<number> | 本次发现的未在已知列表中的 cmd 编号 |
| signatureParams | object | 统计签名参数与出现频次 |
| signatureHeaders | object | 统计签名头与出现频次 |

### 2026 年 8 月 API 变化记录

以下通过 `debug-capture.ts` 采集获得，供逆向分析参考。

**消息推送架构变更：**
- 由 Frontier WebSocket 长连接迁移至 HTTP 短轮询机制（抓包证实聊天页 0 个 WS 连接）
- 新增接口：`cmd=2048`，路径 `/v1/message/get_user_message`（轮询取新消息/事件）
- 新增接口：`cmd=2043`，路径 `/v1/message/get_message_by_init`（初始化同步，返回初始游标）
- 新增接口：`cmd=2010`，路径 `/v1/client/ack`（客户端按 serverMsgId 确认消息）
- **已适配**：`watch` 默认轮询模式（`src/api/polling.ts` + `src/commands/poll-watch.ts`），
  请求/响应结构经 `scripts/_test-poll-encoder.ts` 与抓包样本逐字节校验

**仅读一次消息协议：**
- 消息类型：`msgType=104`, `aweType=10400`
- 扩展字段：`ext: s:once_view_count = "1"`
- 其他字段结构与普通文本消息一致，仅扩展标识不同

**签名方法更新：**
- 签名参数（query/body）：`device_platform`, `msToken`, `a_bogus`, `verifyFp`, `fp`
- 新增签名头（请求头）：
  - `bd-ticket-guard-client-data`
  - `bd-ticket-guard-ree-public-key`
  - `bd-ticket-guard-version`
  - `bd-ticket-guard-web-sign-type`
  - `bd-ticket-guard-web-version`
  - `x-tt-session-dtrait`

如发现新的 cmd、字段或签名变化，欢迎按「贡献指南」中的方式分享。

---

## 贡献指南

项目的持续演进依赖社区参与，欢迎以多种形式贡献。以下为完整的贡献类型、认领方向、流程与规范。

### 贡献类型

**1. Bug 报告**

通过 Issue 提交问题，请提供以下信息以提高定位效率：
- 执行的具体命令与预期行为
- 实际输出内容，推荐附带 `--verbose --json` 组合下的完整日志
- 抖音 Web 端是否存在可观察到的对应变化（界面改版、功能下线、风控提示等）
- 若为接口失败，附 `notices --count 5` 命令的输出以确认 cookie 是否仍然有效

**2. API 逆向发现分享**

观察到 API 变更时，欢迎分享分析成果：
- 使用 `scripts/debug-capture.ts` 完成抓包后，将 `summary.json` 中的关键信息整理至 Issue
- 新增 cmd 编号、接口路径、字段语义、payload 结构变化等
- 签名机制变化：新增参数、新增请求头、签名算法变更迹象
- 若能提供对应的 protobuf 字段编号与类型映射，尤为珍贵

**3. 代码 Pull Request**

可认领以下方向，亦可自选合理主题。提交前请确保 `tsc --noEmit`（SPRR 目录）与 `node --check`（ai-server 目录）通过。

**4. 文档改进**

- 修正文档中的错误或过时说明
- 补充缺失的参数描述、示例、注意事项
- 文档多语言翻译
- 补充使用教程、集成示例、最佳实践

### 代码认领方向

| 难度 | 方向 | 说明 |
| --- | --- | --- |
| 入门 | 新命令实现 | 参考 `src/commands/` 下已有实现，按 CLI 框架扩展所需命令 |
| 入门 | 类型补全 | 完善 `src/types/index.ts` 中仍标注为 `unknown` 的字段 |
| 入门 | 消息类型解析 | 在 `history` 输出中补充目前标记为「未知」的消息类型 |
| 进阶 | cmd 2043/2048/2010 解析 | 2043/2048 已完成（见 `src/api/polling.ts`）；2010 ack 已知结构、按需接入 |
| 进阶 | 轮询 watch 适配 | 已完成：`watch` 默认轮询模式（`poll-watch.ts`），可进一步打磨重连/异常体验 |
| 进阶 | 仅读一次消息发送 | 在 `send` 中新增 `--once` 选项，写入对应的 msgType 与 ext |
| 进阶 | 资料/通知新字段解析 | 随着资料与通知接口更新，补充新字段的语义映射 |
| 高阶 | secsdk 三头纯算研究 | ticket-guard 三头生成机制的纯算可行性研究与实现 |
| 高阶 | 风控策略研究 | 高频请求下的风控触发阈值、触发条件、应对方案沉淀 |
| 高阶 | ProtoBuf 完整 Schema | 持续完善 protobuf 字段映射，输出稳定的 .proto 定义 |

### 贡献流程

1. Fork 本仓库至个人账号
2. Clone 至本地：
   ```bash
   git clone https://github.com/<username>/douyinAPI.git
   cd douyinAPI
   ```
3. 创建功能分支（命名建议 `feature/<topic>` 或 `fix/<topic>`）：
   ```bash
   git checkout -b feature/cmd-2048-parser
   ```
4. 本地完成开发与自测，提交变更：
   ```bash
   git add -A
   git commit -m "<type>(<scope>): <description>"
   ```
5. 推送分支至个人 Fork：
   ```bash
   git push -u origin feature/cmd-2048-parser
   ```
6. 通过 GitHub 提交 Pull Request，在 PR 描述中说明：改动目的、相关 Issue（如有）、验证方式、是否存在破坏性变更，等待审核与合并。

### 代码规范

- TypeScript 代码需符合 `SPRR/tsconfig.json` 编译配置；提交前通过 `tsc --noEmit`
- ai-server 的 JavaScript 代码通过 `node --check` 语法校验
- 新增命令需同步更新本文件的对应章节与示例
- 提交信息推荐采用 Conventional Commits 格式：`type(scope): description`

  常用 type 取值：
  | type | 适用场景 |
  | --- | --- |
  | feat | 新增功能、新命令、新解析能力 |
  | fix | 修复已有功能的 bug、修复风控兼容性 |
  | docs | 文档变更（README、clu.md、注释） |
  | refactor | 代码重构，不改变外部行为 |
  | perf | 性能优化（启动耗时、请求合并、节流策略） |
  | chore | 构建配置、依赖升级、脚本调整 |
  | test | 测试用例新增或调整 |

  示例：
  ```
  feat(message): 新增仅读一次消息发送选项
  fix(comment): 调整 ticket-guard 三头加载优先级
  docs(clu): 补充抓包工具使用说明
  refactor(commands): 账号命令抽取为 account-cmds 模块
  ```

- 保持变更粒度最小化：单次 Pull Request 聚焦单一主题，避免混合重构、功能、依赖升级
- 新增逆向分析脚本放在 `SPRR/scripts/` 目录，文件名使用 `_` 前缀标明为一次性分析工具，或使用稳定命名标明可复用（如 `debug-capture.ts`）

---

## 常见问题

### 1. Cookie 过期

**症状：** 所有命令都返回错误，`list` 命令返回空或 401。

**解决：** 重新登录

```
◆ sprr> login myaccount
```

或用 cookie 字符串直接登录（无需浏览器）：

```
◆ sprr> cookie "uid_tt=xxx; sessionid=yyy; ..."
```

### 2. 找不到目标用户

**症状：** `找不到目标用户: xxx`

**解决：**

```
# 查看所有会话和对应的 UID/昵称
◆ sprr> list

# 用 UID 而不是昵称
◆ sprr> send --to 517231230585881 --text "你好"

# 或为 UID 设置备注名后用备注名
◆ sprr> rename --uid 517231230585881 --name "张三"
◆ sprr> send --to 张三 --text "你好"
```

### 3. 签名失败

**症状：** `video`、`collect-sticker`、`edit-profile` 返回 status_code 非 0 或签名校验失败。

**排查：**

```
# 1. 用 notices 命令验证 cookie 是否有效（此接口无需签名）
◆ sprr> notices --count 5

# 2. 开启详细日志查看签名生成情况
◆ sprr> --verbose
◆ sprr> video --to TwT --aweme-id 7400000000000000000
# 日志中应看到: aBogus=192chars（表示签名生成正常）

# 3. 检查 cookie 是否包含 msToken 和 s_v_web_id
# 若缺失，需重新登录获取完整 cookie
```

### 4. aweme_id 精度问题

aweme_id 超过 JavaScript 的 `Number.MAX_SAFE_INTEGER`，处理时必须用字符串：

- 正确：`--aweme-id 7400000000000000000`
- 错误：在代码中用 `Number(aweme_id)` 转换

### 5. 速率限制

**症状：** 出现 `status=409 desc=too many requests`

**解决：** 命令执行间隔不要太短，频繁调用会触发风控。AI 自动回复已内置 5 秒节流（同一会话 5 秒内只查询一次 history），避免触发风控。

### 6. 评论发布失败（ticket-guard 头无效或缺失）

**症状：** `comment` 命令报「缺少 ticket-guard 三头」，或返回 HTTP 200 但 status_code 非 0、空 body。

**排查：**

```
# 1. 查看当前 ticket-guard 配置状态
◆ sprr> ticket-guard --show
# 若提示「当前无已保存的配置」或「可能已过期」，执行下面任一步骤

# 2. 方式 A：无头浏览器自动获取（推荐，仅需已登录的 cookie）
◆ sprr> ticket-guard --auto

# 3. 方式 B：从已有抓包数据提取（开发者模式，需要抓包样本）
◆ sprr> ticket-guard --from-capture

# 4. 方式 C：手动从浏览器 DevTools 复制三头后导入
#    在浏览器中发布一条评论 → F12 Network → 找到 comment/publish 请求
#    复制 bd-ticket-guard-client-data / bd-ticket-guard-ree-public-key / x-tt-session-dtrait 三个头
◆ sprr> ticket-guard \
  --client-data "eyJ0c19zaWdu..." \
  --ree-public-key "BHmVOc8Zj1..." \
  --session-dtrait "d0_jSbZQNXVp..."

# 5. 验证 comment 是否恢复正常
◆ sprr> --verbose
◆ sprr> comment --aweme-id 7400000000000000000 --text "测试"
```

### 7. playwright 缺失

**症状：** `login`、`watch --ws` 或 `comment` 首次自动获取三头时报 `Cannot find module 'playwright'` 或 `Cannot find package 'playwright'`。

**解决：**

```bash
# 在 SPRR 目录下安装
cd SPRR
npm install playwright
```

> 默认轮询模式的 `watch` **不需要** playwright（纯 Node 直连 imapi 接口）。仅 `--ws` 旧版模式需要 playwright 来提取 WebSocket 的 `access_key`（由 webmssdk.es5.js 的 frontierSign 函数生成，VM 字节码保护，无法在纯 Node.js 中复现）。

### 8. AI 自动回复不触发

**症状：** `watch --ai` 已启动，白名单已添加，但对方发消息后 AI 没回复。

**排查步骤：**

```
# 1. 确认 ai-server 已启动（在另一个终端）
cd ai-server
node server.js
# 应看到: ai-server listening on http://127.0.0.1:7860

# 2. 确认白名单已正确加载
◆ sprr> ai --list
# 应显示: 白名单: 1 个用户 [517231230585881]

# 3. 用 --verbose 模式启动 watch，查看调试日志
◆ sprr> --verbose
◆ sprr> watch --ai
# 对方发消息后应看到:
#   [watch调试] senderUid=... myUid=... isSelf=false ...
#   [AI回复调试] history 返回 N 条 ...
#   [AI回复调试] 选中 target: id=... text="..."
#   [AI回复] TwT(...): 消息内容
#   [AI回复] 已回复 TwT: 回复内容
```

**常见原因：**
- ai-server 未启动 → 启动 ai-server
- 白名单 UID 错误（误用 serverMsgId）→ 用 `list` 查看正确 UID，重新 `ai --add`
- 消息方向判断错误 → 查看调试日志 `isSelf` 值，对方消息应为 `false`
- 消息已处理（重复推送）→ 调试日志会显示 `跳过已处理(id)`

### 9. AI 重复回复 / 循环回复

**症状：** 对方发一条消息，AI 回复了多条；或 AI 回复自己的消息。

**原因与解决：**

- **AI 回复被当作对方消息**：已修复，现在用 history 的 `isSelf` 字段判断方向，AI 回复会显示 `isSelf=true` 自动跳过
- **trailing 查询回复历史消息**：已修复，trailing 查询只处理比上次已处理消息更新的消息（`lastProcessedMsgTs` 过滤）
- **仍然循环**：开启 `--verbose`，把 `[AI回复调试]` 日志发我排查

### 10. 输出格式

- 默认：人类可读的表格/列表格式
- `--json`：JSON 格式，便于程序处理
- `--verbose`：DEBUG 级别日志，排查问题时使用

```bash
# 推荐排查问题时的组合
npx tsx src/indexv2.ts --verbose --json
```

---

## 完整工作流示例

### 场景 1：首次使用

```
# 1. 登录（或用 cookie 字符串登录）
◆ sprr> login myaccount

# 2. 查看当前账号
◆ sprr> whoami

# 3. 列出会话
◆ sprr> list

# 4. 给指定用户发消息
◆ sprr> send --to TwT --text "你好"
```

### 场景 2：拉取并处理历史消息

```
# 1. 拉取最近 100 条消息
◆ sprr> history --to TwT --limit 100

# 2. 查看视频分享详情
◆ sprr> video --to TwT --aweme-id 7400000000000000000
```

### 场景 3：实时监控消息

```
# 1. 监控指定会话
◆ sprr> watch --to TwT

# 2. 收到表情贴纸后收藏
◆ sprr> collect-sticker --to TwT --msg-id 7670000000000000000
```

### 场景 4：AI 自动回复完整流程

```
# 1. 启动 ai-server（在另一个终端）
cd ai-server
node server.js

# 2. 启动 SPRR REPL
npx tsx src/indexv2.ts

# 3. 登录（若已登录可跳过）
◆ sprr> login myaccount
# 或用 cookie 字符串:
◆ sprr> cookie "uid_tt=xxx; sessionid=yyy; ..."

# 4. 查看联系人，找到要开启 AI 回复的用户 UID
◆ sprr> list

# 5. 添加用户到白名单
◆ sprr> ai --add 517231230585881

# 6. 确认白名单
◆ sprr> ai --list
# 应显示: 白名单: 1 个用户 [517231230585881]

# 7. 开启 AI 自动回复监听
◆ sprr> watch --ai

# 8. 对方发消息后，AI 会自动回复
# 日志会显示:
#   [新消息] TwT | 对方: 嘿嘿
#   [AI回复] TwT(517231230585881): 嘿嘿
#   [AI回复] 已回复 TwT: （歪头看着你...）喵～

# 9. Ctrl+C 返回 REPL，AI 回复停止
# 10. 移除白名单用户（停止对该用户自动回复）
◆ sprr> ai --del 517231230585881
```

### 场景 5：修改个人资料

```
# 1. 查看当前资料
◆ sprr> profile

# 2. 修改简介
◆ sprr> edit-profile --signature "新简介"

# 3. 修改头像
◆ sprr> edit-profile --avatar ./new_avatar.jpg
```

### 场景 6：通知→评论互动（@提及回复）

```
# 1. 拉取互动通知，找有人 @ 我的通知
◆ sprr> notices --count 20
# 输出中找到 type=45（@提及）的 nid

# 2. 查看通知详情，获取 aweme_id 和 comment_id
◆ sprr> --json
◆ sprr> noticedetail --nid 7400000000000000000
# 从 JSON 中提取 awemeId 和 commentId

# 3. 查看通知来源视频详情
◆ sprr> awemedetail --aweme-id 7400000000000000000

# 4. 拉取视频评论列表，定位被 @ 的评论
◆ sprr> --json
◆ sprr> comments --aweme-id 7400000000000000000 --max 50
# 从 JSON 中找到 cid == 7400000000000000000 的评论

# 5. 首次发布评论前，确保 ticket-guard 三头已就绪（已配置过可跳过）
◆ sprr> ticket-guard --show
# 若无配置或已过期，自动获取（仅需已登录的 cookie）：
◆ sprr> ticket-guard --auto

# 6. 回复该评论（三头自动从 data/ticket-guard.json 加载；首次缺失时会自动触发 --auto）
◆ sprr> comment \
  --aweme-id 7400000000000000000 \
  --text "感谢提及" \
  --reply-id 7400000000000000000
```

### 场景 7：抓包分析 API 变更

当抖音接口更新导致现有功能异常或出现未知 cmd 时，按以下流程采集数据：

```bash
# 1. 进入 SPRR 目录，启动 debug-capture
cd SPRR
npx tsx scripts/debug-capture.ts
# 脚本启动 Chromium，自动打开 douyin.com

# 2. 在浏览器中执行目标操作（约 2-5 分钟）：
#    - 扫码登录（若未登录）
#    - 发送普通文本、图片、表情
#    - 发送或接收仅读一次消息
#    - 进入通知页、查看通知详情
#    - 打开任意视频、发布或回复一条评论

# 3. 操作完成后，回到终端按下 Ctrl+C 终止
# 脚本输出汇总报告，示例如下：
#   ══════════════════════════════════════════════════
#   ║ 抓包完成，数据已保存到: .../debug-YYYYMMDD-HHMMSS
#   ║ HTTP 请求: 72 个
#   ║ WS 连接: 0 个
#   ║ ★ 发现未知 cmd: 2043, 2048, 2010
#   ╚═════════════════════════════════════════════════

# 4. 打开 summary.json，提取以下信息并提交 Issue：
#    - unknownCmds 中的新增 cmd 编号
#    - httpRequests 中对应 cmd 的完整 URL（去掉敏感 cookie）
#    - signatureParams 与 signatureHeaders 两项的完整内容
#    - 若涉及新消息类型，附上对应消息的 request/response body 片段
```

将抓包目录下的 `summary.json` 与关键请求 JSON 打包后，可通过 Issue 附带的形式分享，用于共同逆向分析。
