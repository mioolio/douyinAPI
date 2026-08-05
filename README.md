# SPRR 命令使用手册
---
抖音私信聊天自动化工具（纯 API 逆向版）的完整命令参考。
>声明
> 
> 本项目仅供学习参考和思路研究使用。  
> 若内容涉及侵权，请联系邮箱 [islont@proton.me] 进行下架处理
> 
> 项目开发初衷是打造虚拟恋人，为Ai提供简单的命令
> 
---

## 目录

- [运行方式](#运行方式)
- [全局选项](#全局选项)
- [账号管理](#账号管理)
  - [login - 扫码登录](#login---扫码登录)
  - [accounts - 列出账号](#accounts---列出账号)
  - [use - 切换账号](#use---切换账号)
  - [logout - 删除账号](#logout---删除账号)
  - [whoami - 查看当前账号](#whoami---查看当前账号)
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
- [常见问题](#常见问题)

---

## 运行方式

本项目提供两种运行方式：

### 1. 开发模式（推荐，无需编译）

```bash
npx tsx src/index.ts <命令> [选项]
```

### 2. 生产模式（需先编译）

```bash
npm run build
node dist/index.js <命令> [选项]
```

> 下文为简洁起见，统一用 `sprr` 代表运行命令。开发模式请替换为 `npx tsx src/index.ts`。

---

## 全局选项

所有命令都支持以下全局选项，须放在子命令之前：

```bash
sprr [--verbose] [--json] [--state <path>] [--account <name>] <命令> [命令选项]
```

| 选项 | 说明 |
|------|------|
| `--verbose` | 输出 DEBUG 级别日志，便于排查问题 |
| `--json` | 以 JSON 格式输出结果（便于程序处理） |
| `--state <path>` | 指定 storageState 文件路径（优先级最高） |
| `--account <name>` | 临时使用指定账号，不修改当前账号指针 |

**示例：**

```bash
# 详细日志 + JSON 输出
npx tsx src/index.ts --verbose --json list

# 临时使用 other 账号
npx tsx src/index.ts --account other list
```

---

## 账号管理

### `login` - 扫码登录

启动浏览器扫码登录抖音，保存为指定账号并自动设为当前账号。

登录成功后会**自动获取 ticket-guard 三头**（评论发布必需的浏览器加密签名头），无需单独运行 `ticket-guard` 命令。原理：复用已打开的浏览器会话，导航到视频页触发 secsdk 初始化，拦截一个无效的 `comment_publish` 探测请求（aweme_id=0，不会真的发评论）提取三头，保存到 `data/ticket-guard.json`。

```bash
sprr login <name> [--timeout <ms>]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 账号名称（仅小写字母、数字、横线） |
| `--timeout` | 否 | 登录超时毫秒数，默认 300000（5 分钟） |

**示例：**

```bash
npx tsx src/index.ts login myaccount
npx tsx src/index.ts login work --timeout 600000
```

> 注意：登录后自动获取 ticket-guard 三头约需 10 秒（浏览器导航 + secsdk 初始化）。若获取失败不影响登录结果，可手动运行 `sprr ticket-guard --auto` 重新获取。

---

### `accounts` - 列出账号

列出所有已保存的账号，标记当前账号。

```bash
sprr accounts
```

**示例：**

```bash
npx tsx src/index.ts accounts
```

---

### `use` - 切换账号

切换当前默认账号。

```bash
sprr use <name>
```

**示例：**

```bash
npx tsx src/index.ts use work
```

---

### `logout` - 删除账号

删除指定账号的本地 storageState（不影响抖音服务器登录态）。

```bash
sprr logout <name>
```

**示例：**

```bash
npx tsx src/index.ts logout old_account
```

---

### `whoami` - 查看当前账号

显示当前账号、登录态、保存时间。

```bash
sprr whoami
```

**示例：**

```bash
npx tsx src/index.ts whoami
```

---

## 会话与消息

### `list` - 列出会话

列出所有会话（联系人），自动批量获取昵称。

```bash
sprr list
```

**输出字段：** 序号 / 昵称 / UID / 未读数 / 会话 ID

**示例：**

```bash
npx tsx src/index.ts list
npx tsx src/index.ts --json list
```

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

**示例：**

```bash
npx tsx src/index.ts rename --uid [ID_REDACTED] --name "张三"
```

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

**示例：**

```bash
# 默认拉取 TwT 最近 30 条
npx tsx src/index.ts history

# 拉取 100 条
npx tsx src/index.ts history --to TwT --limit 100

# 指定会话 ID 拉取 500 条
npx tsx src/index.ts history --cid "0:1:[ID_REDACTED]:[ID_REDACTED]" --limit 500

# JSON 输出（便于程序处理）
npx tsx src/index.ts --json history --to TwT --limit 50
```

---

### `send` - 发送文本消息

向指定用户发送文本消息。

```bash
sprr send -t <text> [--to <target>]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `-t, --text` | 是 | 消息内容 |
| `--to` | 否 | 目标用户 UID 或昵称，默认 `TwT` |

**示例：**

```bash
npx tsx src/index.ts send --to TwT --text "你好"
npx tsx src/index.ts send --to [ID_REDACTED] --text "在吗"
npx tsx src/index.ts send -t "测试消息" --to 张三
```

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

**示例：**

```bash
npx tsx src/index.ts send-image --to TwT --image ./pic.jpg
npx tsx src/index.ts send-image -i ./photos/cat.png --to 张三
```

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

**示例：**

```bash
# 撤回最近一条自己发的消息
npx tsx src/index.ts recall --to TwT

# 撤回指定消息
npx tsx src/index.ts recall --to TwT --msg-id [ID_REDACTED]
```

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

**示例：**

```bash
npx tsx src/index.ts reply --to TwT --text "同意" --ref [ID_REDACTED]
npx tsx src/index.ts reply -t "好的" -r [ID_REDACTED] --to 张三
```

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

**JSON 文件格式**（支持 camelCase 和 snake_case）：

```json
{
  "imageId": "[ID_REDACTED]",
  "packageId": [ID_REDACTED],
  "width": 300,
  "height": 300,
  "imageType": "webp",
  "uri": "ies.fe.effect/xxx",
  "url": {
    "uri": "ies.fe.effect/xxx",
    "url_list": ["https://..."]
  },
  "displayName": ""
}
```

**示例：**

```bash
# 从历史消息提取并发送
npx tsx src/index.ts send-sticker --to TwT --from-msg [ID_REDACTED]

# 从 JSON 文件发送
npx tsx src/index.ts send-sticker --to TwT --sticker ./sticker.json
```

---

### `watch` - 实时监控推送

通过 WebSocket 实时监控新消息推送。

```bash
sprr watch [--access-key <key>] [--device-id <uid>] [--to <target>] [--raw]
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `--access-key` | 否 | 手动指定 access_key，不指定则自动从浏览器提取后关闭 |
| `--device-id` | 否 | 设备 ID（即用户 UID），默认自动检测 |
| `--to` | 否 | 仅监控指定会话，默认监控所有会话 |
| `--raw` | 否 | 显示原始帧，便于调试 |

**示例：**

```bash
# 监控所有会话
npx tsx src/index.ts watch

# 仅监控指定会话
npx tsx src/index.ts watch --to TwT

# 手动指定 access_key
npx tsx src/index.ts watch --access-key xxx --device-id [ID_REDACTED]

# 调试模式
npx tsx src/index.ts --verbose watch --raw
```

---

## 资料与互动

### `profile` - 查看主页

获取当前账号主页信息。

```bash
sprr profile
```

**输出字段：** 昵称 / 抖音号 / UID / sec_uid / 简介 / 关注 / 粉丝 / 获赞 / 作品 / 地区 / 绑定手机 / 头像

**示例：**

```bash
npx tsx src/index.ts profile
npx tsx src/index.ts --json profile
```

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

**示例：**

```bash
# 修改昵称
npx tsx src/index.ts edit-profile --nickname "新昵称"

# 修改简介
npx tsx src/index.ts edit-profile --signature "这是新简介"

# 修改头像
npx tsx src/index.ts edit-profile --avatar ./avatar.jpg

# 同时修改昵称和简介
npx tsx src/index.ts edit-profile --nickname "新昵称" --signature "新简介"
```

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

**示例：**

```bash
npx tsx src/index.ts notices
npx tsx src/index.ts notices --count 10 --max 100
npx tsx src/index.ts --json notices --max 20
```

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

**示例：**

```bash
# 查看通知详情
npx tsx src/index.ts noticedetail --nid [ID_REDACTED]

# JSON 输出（便于提取 aweme_id 和 comment_id）
npx tsx src/index.ts --json noticedetail --nid [ID_REDACTED]
```

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

**示例：**

```bash
# 直接指定 aweme_id
npx tsx src/index.ts video --to TwT --aweme-id [ID_REDACTED]

# 从历史视频分享消息提取
npx tsx src/index.ts video --to TwT --msg-id [ID_REDACTED]

# JSON 输出
npx tsx src/index.ts --json video --to TwT --aweme-id [ID_REDACTED]
```

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

**示例：**

```bash
# 收藏表情
npx tsx src/index.ts collect-sticker --to TwT --msg-id [ID_REDACTED]

# 取消收藏
npx tsx src/index.ts collect-sticker --to TwT --msg-id [ID_REDACTED] --action 0
```

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

**输出字段：** 标题 / 作者 / 时长 / 点赞 / 评论 / 分享 / 封面 / 播放地址 / 鉴权 token

**示例：**

```bash
# 基本查询
npx tsx src/index.ts awemedetail --aweme-id [ID_REDACTED]

# JSON 输出
npx tsx src/index.ts --json awemedetail --aweme-id [ID_REDACTED]

# 风控触发时附带 ticket-guard 头
npx tsx src/index.ts awemedetail --aweme-id [ID_REDACTED] \
  --ticket-guard-client-data "xxxx" \
  --ticket-guard-ree-public-key "yyyy"
```

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

**输出字段（每条评论）：** 时间 / 昵称 / IP 归属 / 回复目标 / 是否热门 / 内容 / cid / uid / 点赞数 / 回复数

**示例：**

```bash
# 拉取前 30 条评论
npx tsx src/index.ts comments --aweme-id [ID_REDACTED]

# 拉取 100 条
npx tsx src/index.ts comments --aweme-id [ID_REDACTED] --max 100

# 翻页（用上一次返回的 cursor）
npx tsx src/index.ts comments --aweme-id [ID_REDACTED] --cursor 1700000000

# JSON 输出（便于提取 cid 用于回复）
npx tsx src/index.ts --json comments --aweme-id [ID_REDACTED] --max 50
```

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

**示例：**

```bash
# 正常使用：login 已自动获取三头，直接发布评论即可
npx tsx src/index.ts comment --aweme-id [ID_REDACTED] --text "这个视频很棒"

# 回复指定评论（cid 从 comments 命令获取）
npx tsx src/index.ts comment --aweme-id [ID_REDACTED] --text "同意你的观点" --reply-id [ID_REDACTED]

# @用户（text 中用 @1、@2 占位，按顺序对应 at-uid/at-sec-uid）
npx tsx src/index.ts comment --aweme-id [ID_REDACTED] --text "@1 你看看这个" \
  --at-uid [ID_REDACTED] --at-sec-uid [SEC_UID_REDACTED]

# 手动覆盖三头（调试或临时切换账号时使用）
npx tsx src/index.ts comment --aweme-id [ID_REDACTED] --text "测试" \
  --ticket-guard-client-data "xxxx" \
  --ticket-guard-ree-public-key "yyyy" \
  --tt-session-dtrait "zzzz"
```

> 若 comment 命令报「缺少 ticket-guard 三头」，请先运行 `npx tsx src/index.ts ticket-guard --auto` 自动获取，或参照 [`ticket-guard` 命令](#ticket-guard---管理浏览器加密签名头) 使用其他方式。

---

### `ticket-guard` - 刷新浏览器加密签名头

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

**示例：**

```bash
# 1. 刷新三头（三头过期或登录时获取失败时使用）
npx tsx src/index.ts ticket-guard --auto
# 输出：
#   ticket-guard 三头自动获取成功:
#     来源: auto:playwright
#     获取时间: 2026-07-26 10:30:00
#     clientData: 252 chars
#     reePublicKey: 88 chars
#     sessionDtrait: 820 chars

# 2. 查看当前配置（含过期检查）
npx tsx src/index.ts ticket-guard --show
# 输出：
#   来源: auto:playwright
#   获取时间: 2026-07-26 10:30:00
#   状态: 有效

# 3. 从抓包数据提取（开发者模式，需要先抓包）
npx tsx src/index.ts ticket-guard --from-capture

# 4. 手动导入三头（从浏览器 DevTools 复制后粘贴）
npx tsx src/index.ts ticket-guard \
  --client-data "eyJ0c19zaWdu..." \
  --ree-public-key "BHmVOc8Zj1..." \
  --session-dtrait "d0_jSbZQNXVp..."

# 5. JSON 格式输出（便于脚本处理）
npx tsx src/index.ts --json ticket-guard --show
```

**何时需要重新获取三头：**

- `ticket-guard --show` 提示「可能已过期」（默认 24 小时有效期）
- `comment` 命令返回风控码或空响应
- 重新登录账号后（cookie 变化导致会话失效）
- 切换到不同账号时

**`--auto` 失败的排查：**

1. 检查是否已登录：`npx tsx src/index.ts whoami`，若无账号则 `npx tsx src/index.ts login <name>`
2. 检查 playwright 是否安装：`npm install -D playwright`
3. 开启详细日志：`npx tsx src/index.ts --verbose ticket-guard --auto`
4. 降级到 `--from-capture`（需要抓包数据）或手动导入

> `comment` 命令在缺失三头时会自动触发浏览器获取流程，无需用户手动运行 `ticket-guard --auto`。

---

## 常见问题

### 1. Cookie 过期

**症状：** 所有命令都返回错误，`list` 命令返回空或 401。

**解决：** 重新登录

```bash
npx tsx src/index.ts login myaccount
```

### 2. 找不到目标用户

**症状：** `找不到目标用户: xxx`

**解决：**

```bash
# 查看所有会话和对应的 UID/昵称
npx tsx src/index.ts list

# 用 UID 而不是昵称
npx tsx src/index.ts send --to [ID_REDACTED] --text "你好"

# 或为 UID 设置备注名后用备注名
npx tsx src/index.ts rename --uid [ID_REDACTED] --name "张三"
npx tsx src/index.ts send --to 张三 --text "你好"
```

### 3. 签名失败

**症状：** `video`、`collect-sticker`、`edit-profile` 返回 status_code 非 0 或签名校验失败。

**排查：**

```bash
# 1. 用 notices 命令验证 cookie 是否有效（此接口无需签名）
npx tsx src/index.ts notices --count 5

# 2. 开启详细日志查看签名生成情况
npx tsx src/index.ts --verbose video --to TwT --aweme-id [ID_REDACTED]
# 日志中应看到: aBogus=192chars（表示签名生成正常）

# 3. 检查 cookie 是否包含 msToken 和 s_v_web_id
# 若缺失，需重新登录获取完整 cookie
```

### 4. aweme_id 精度问题

aweme_id 超过 JavaScript 的 `Number.MAX_SAFE_INTEGER`，处理时必须用字符串：

- 正确：`--aweme-id [ID_REDACTED]`
- 错误：在代码中用 `Number(aweme_id)` 转换

### 5. 速率限制

**症状：** 出现 `status=409 desc=too many requests`

**解决：** 命令执行间隔不要太短，频繁调用会触发风控。

### 6. 评论发布失败（ticket-guard 头无效或缺失）

**症状：** `comment` 命令报「缺少 ticket-guard 三头」，或返回 HTTP 200 但 status_code 非 0、空 body。

**排查：**

```bash
# 1. 查看当前 ticket-guard 配置状态
npx tsx src/index.ts ticket-guard --show
# 若提示「当前无已保存的配置」或「可能已过期」，执行下面任一步骤

# 2. 方式 A：无头浏览器自动获取（推荐，仅需已登录的 cookie）
npx tsx src/index.ts ticket-guard --auto

# 3. 方式 B：从已有抓包数据提取（开发者模式，需要抓包样本）
npx tsx src/index.ts ticket-guard --from-capture

# 4. 方式 C：手动从浏览器 DevTools 复制三头后导入
#    在浏览器中发布一条评论 → F12 Network → 找到 comment/publish 请求
#    复制 bd-ticket-guard-client-data / bd-ticket-guard-ree-public-key / x-tt-session-dtrait 三个头
npx tsx src/index.ts ticket-guard \
  --client-data "xxxx" \
  --ree-public-key "yyyy" \
  --session-dtrait "zzzz"

# 5. 验证 comment 是否恢复正常
npx tsx src/index.ts --verbose comment --aweme-id [ID_REDACTED] --text "测试"

# 6. 若 awemedetail/comments 接口也返回风控码，可能 cookie 已过期
npx tsx src/index.ts notices --count 5  # 验证 cookie
```

### 7. 输出格式

- 默认：人类可读的表格/列表格式
- `--json`：JSON 格式，便于程序处理
- `--verbose`：DEBUG 级别日志，排查问题时使用

```bash
# 推荐排查问题时的组合
npx tsx src/index.ts --verbose --json <命令> [选项] 2>&1 | tee debug.log
```

---

## 完整工作流示例

### 场景 1：首次使用

```bash
# 1. 登录
npx tsx src/index.ts login myaccount

# 2. 查看当前账号
npx tsx src/index.ts whoami

# 3. 列出会话
npx tsx src/index.ts list

# 4. 给指定用户发消息
npx tsx src/index.ts send --to TwT --text "你好"
```

### 场景 2：拉取并处理历史消息

```bash
# 1. 拉取最近 100 条消息（JSON 格式）
npx tsx src/index.ts --json history --to TwT --limit 100 > history.json

# 2. 查看视频分享详情
npx tsx src/index.ts video --to TwT --aweme-id [ID_REDACTED]
```

### 场景 3：实时监控消息

```bash
# 1. 监控指定会话
npx tsx src/index.ts watch --to TwT

# 2. 收到表情贴纸后收藏
npx tsx src/index.ts collect-sticker --to TwT --msg-id [ID_REDACTED]
```

### 场景 4：修改个人资料

```bash
# 1. 查看当前资料
npx tsx src/index.ts profile

# 2. 修改简介
npx tsx src/index.ts edit-profile --signature "新简介"

# 3. 修改头像
npx tsx src/index.ts edit-profile --avatar ./new_avatar.jpg
```

### 场景 5：通知→评论互动（@提及回复）

```bash
# 1. 拉取互动通知，找有人 @ 我的通知
npx tsx src/index.ts notices --count 20
# 输出中找到 type=45（@提及）的 nid

# 2. 查看通知详情，获取 aweme_id 和 comment_id
npx tsx src/index.ts --json noticedetail --nid [ID_REDACTED] > notice.json
# 从 JSON 中提取 awemeId 和 commentId

# 3. 查看通知来源视频详情
npx tsx src/index.ts awemedetail --aweme-id [ID_REDACTED]

# 4. 拉取视频评论列表，定位被 @ 的评论
npx tsx src/index.ts --json comments --aweme-id [ID_REDACTED] --max 50 > comments.json
# 从 JSON 中找到 cid == [ID_REDACTED] 的评论

# 5. 首次发布评论前，确保 ticket-guard 三头已就绪（已配置过可跳过）
npx tsx src/index.ts ticket-guard --show
# 若无配置或已过期，自动获取（仅需已登录的 cookie）：
npx tsx src/index.ts ticket-guard --auto

# 6. 回复该评论（三头自动从 data/ticket-guard.json 加载；首次缺失时会自动触发 --auto）
npx tsx src/index.ts comment \
  --aweme-id [ID_REDACTED] \
  --text "感谢提及" \
  --reply-id [ID_REDACTED]
