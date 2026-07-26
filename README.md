# SPRR 技术文档

抖音私信聊天自动化工具（纯 API 逆向版）—— 协议、签名、字段、CLI 用法完整说明。

---

## 目录

1. [架构概览](#1-架构概览)
2. [认证与签名机制](#2-认证与签名机制)
3. [Protobuf 消息结构](#3-protobuf-消息结构)
4. [消息类型详解](#4-消息类型详解)
5. [Web API 接口](#5-web-api-接口)
6. [CLI 命令参考](#6-cli-命令参考)
7. [完整工作流示范](#7-完整工作流示范)
8. [抓包资源索引](#8-抓包资源索引)
9. [常见问题排查](#9-常见问题排查)

---

## 1. 架构概览

### 1.1 整体分层

```
┌─────────────────────────────────────────────────────────┐
│                    CLI (src/index.ts)                    │
│  list / send / send-image / send-sticker / reply /       │
│  recall / history / collect-sticker / video /            │
│  login / accounts / use / logout / whoami / rename       │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│              API 操作层 (src/api/operations.ts)            │
│   sendMessage / sendSticker / sendQuoteReply /            │
│   sendImage / recallMessage / listContacts / getHistory   │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│              底层客户端 (src/api/imapi.ts)                │
│   protobuf 编解码 + HTTP 请求 + 序列号管理                │
└──────────┬───────────────────────────┬──────────────────┘
           │                           │
           ▼                           ▼
┌─────────────────────┐     ┌─────────────────────────┐
│  imapi.douyin.com   │     │   www.douyin.com        │
│  (私信服务器)        │     │   (Web API)             │
│  protobuf 协议      │     │   JSON 协议             │
│  仅需 Cookie        │     │   部分需 a_bogus 签名    │
└─────────────────────┘     └─────────────────────────┘
```

### 1.2 两个服务器域

| 域名 | 协议 | 用途 | 签名要求 |
|------|------|------|---------|
| `imapi.douyin.com` | protobuf | 私信收发（send/history/recall/list） | 仅 Cookie |
| `www.douyin.com` | JSON | Web API（用户信息/表情收藏/视频详情/图片签名） | 部分需 a_bogus + msToken |

**关键发现**：私信服务器（imapi）的 `send_message` 接口虽然代码中预留了 `aBogus/msToken/bdTicketGuard*` 字段，但实测**仅传 Cookie 即可发送成功**。这些签名字段是可选的，未设置时服务器不会拒绝。

### 1.3 账号与存储

- 账号存储：`data/accounts/<name>.json`（Playwright storageState 格式）
- 当前账号指针：`data/accounts/current`（纯文本文件）
- 本地备注：`data/aliases.json`（uid -> nickname 映射）
- 解密图片：`data/decoded/`（AES-256-GCM 解密后的图片）

---

## 2. 认证与签名机制

### 2.1 签名体系总览

抖音 Web 端共有 4 套签名机制：

| 签名 | 适用接口 | 算法来源 | 当前实现状态 |
|------|---------|---------|-------------|
| Cookie | 所有接口 | 服务器下发（sessionid 等） |  已实现 |
| `a_bogus` + `msToken` | www.douyin.com 写接口 | `webmssdk.es5.js` |  stub（未实现） |
| `bd-ticket-guard-*`（5 个头） | imapi 写接口（可选） | 浏览器 fetch 拦截器 |  stub（未实现） |
| `identity_security_token` | imapi 写接口（可选） | 独立接口换取 |  stub（未实现） |

### 2.2 imapi 接口的签名实情

代码中 `SendSignContext` 接口预留了所有签名字段：

```typescript
export interface SendSignContext {
  identitySecurityToken?: string;      // identity_security_token
  identitySecurityDeviceId?: string;  // identity_security_device_id
  aBogus?: string;                     // URL query 参数
  msToken?: string;                    // URL query 参数
  bdTicketGuardClientData?: string;    // HTTP 头
  bdTicketGuardReePublicKey?: string;  // HTTP 头
  bdTicketGuardVersion?: string;       // HTTP 头（默认 "2"）
  bdTicketGuardWebSignType?: string;  // HTTP 头（默认 "1"）
  bdTicketGuardWebVersion?: string;   // HTTP 头（默认 "2"）
  conversationShortId: number | string | bigint;  // 必填
  conversationType?: number;           // 默认 1=私聊
  ticket?: string;                    // 会话级凭证
}
```

**但实测验证**：所有签名字段都是**可选的**。仅传 `conversationShortId` + `conversationType` + `ticket`（ticket 也可为空）即可成功调用：
- `sendMessage`（发送文本）
- `sendSticker`（发送表情）
- `sendQuoteReply`（引用回复）
- `recallMessage`（撤回消息）

**原因推测**：imapi.douyin.com 服务器只校验 Cookie 中的 `sessionid`，签名字段主要用于风控而非鉴权。私信服务器的风控策略比 Web API 宽松。

### 2.3 Web API 的签名要求

`www.douyin.com/aweme/v1/web/...` 下的接口签名要求分两类：

**仅需 Cookie（无需签名）：**
- `POST /aweme/v1/web/im/user/info/` — 批量获取用户信息
- `GET /aweme/v1/web/im/read_once/detail` — 加密图片详情
- `POST /aweme/v1/web/privacy/batch_build_image/` — 刷新图片签名 URL

**需要 a_bogus + msToken 签名：**
- `POST /aweme/v1/web/im/resource/sticker/collect/` — 表情收藏
- `POST /aweme/v1/web/multi/aweme/detail/` — 视频详情

签名缺失时，需要签名的接口会返回 `status_code != 0` 的错误。

### 2.4 a_bogus 签名算法

#### 2.4.1 算法来源

签名 SDK 文件：`data/capture/js/b4ffe03f6783_webmssdk.es5.js`（387KB）

原始 URL：`https://lf-c-flwb.bytetos.com/obj/rc-client-security/c-webmssdk/1.0.0.20/webmssdk.es5.js`

#### 2.4.2 算法原理

`a_bogus` 是基于以下输入生成的签名参数：

```
a_bogus = f(
  请求参数(query string),
  请求体(body),
  User-Agent,
  当前时间戳,
  设备指纹(来自 cookie 中的 s_v_web_id 等)
)
```

算法特征：
- 基于 `webmssdk.es5.js` 中的混淆 JS 代码
- 输入为请求参数 + UA + 时间戳
- 输出为 Base64 编码的签名字符串
- 有多个版本（1.0.0.20 是当前版本）
- 依赖浏览器环境（navigator、document 等）

#### 2.4.3 msToken 机制

`msToken` 是风控 token，由服务器下发：

1. 首次访问 `https://www.douyin.com/` 时，服务器通过 `Set-Cookie` 下发初始 `msToken`
2. 浏览器端的 `webmssdk` 会定期调用 `https://mssdk.bytedance.com/web/report` 刷新 `msToken`
3. `msToken` 有时效性，过期后需重新获取
4. 依赖浏览器环境指纹（canvas、webgl、字体等）

#### 2.4.4 verifyFp 和 fp

`verifyFp` 和 `fp` 来自 Cookie 中的 `s_v_web_id`：

```
verifyFp = fp = cookie['s_v_web_id']
```

`s_v_web_id` 是设备标识，首次访问抖音时由服务器下发。

#### 2.4.5 bd-ticket-guard 签名

5 个 HTTP 头组成的签名组：

| 头名 | 含义 |
|------|------|
| `bd-ticket-guard-client-data` | 客户端数据（加密） |
| `bd-ticket-guard-ree-public-key` | 公钥 |
| `bd-ticket-guard-version` | 版本（默认 "2"） |
| `bd-ticket-guard-web-sign-type` | 签名类型（默认 "1"） |
| `bd-ticket-guard-web-version` | Web 版本（默认 "2"） |

由浏览器 fetch 拦截器自动注入，算法未逆向。

### 2.5 签名实现方案

#### 方案 A：纯 Node.js 执行 webmssdk（未实现）

在 Node.js 中加载并执行 `webmssdk.es5.js`，需要补全浏览器环境：

```javascript
// 伪代码
const { JSDOM } = require('jsdom');
const dom = new JSDOM('', { url: 'https://www.douyin.com/' });
// 补全 navigator、document、window 等
global.navigator = dom.window.navigator;
global.document = dom.window.document;
global.window = dom.window;
// 加载 SDK
require('./webmssdk.es5.js');
// 调用签名函数
const sign = window.$_sign(params, ua, timestamp);
```

**难点**：
- webmssdk 会检测浏览器环境真实性（navigator.webdriver、canvas 指纹等）
- 需要补全大量 DOM API
- 算法混淆严重，直接调用可能失败

#### 方案 B：Playwright 页面内执行（已验证可行）

利用已登录的浏览器页面，通过 `window.fetch` 发送请求，让抖音的 fetch 拦截器自动注入签名：

```typescript
// 参考实现：scripts/test-send-via-page-fetch.ts
const page = await context.newPage();
await page.goto('https://www.douyin.com/chat?isPopup=1');
await page.waitForTimeout(15000); // 等待 SDK 加载

// 页面内 fetch 会自动注入 a_bogus/msToken/bd-ticket-guard
const result = await page.evaluate(async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return { status: res.status, data: await res.json() };
}, apiUrl, requestBody);
```

**优势**：签名 100% 正确，无需逆向算法。
**劣势**：需要浏览器常驻，性能较低。

#### 方案 C：手动注入签名（临时方案）

从浏览器 devtools 中抓取 `a_bogus` 和 `msToken`，通过 CLI 参数注入：

```bash
# 伪命令（当前未实现）
npx tsx src/index.ts collect-sticker --to TwT --msg-id [ID_REDACTED] \
  --a-bogus "DRk4NAAHABEm..." --ms-token "abcd1234..."
```

**限制**：`a_bogus` 与请求参数绑定，不同请求需不同签名，无法复用。

### 2.6 当前签名实现状态

```typescript
// src/crypto/signature.ts
export function sign(_input: SignInput): SignResult {
  throw new Error('NOT_IMPLEMENTED: 签名算法等待逆向完成后实现');
}
```

**实际影响**：
- `send` / `send-sticker` / `reply` / `recall`： 可用（imapi 不强制签名）
- `collect-sticker` / `video`： 不可用（web API 强制签名）
- `list` / `history` / `whoami`： 可用（无需签名）

---

## 3. Protobuf 消息结构

### 3.1 外层 Request 结构

所有 imapi 请求都包裹在外层 Request 中：

```protobuf
message Request {
  int32  cmd          = 1;  // 命令字（如 100=SEND_MESSAGE, 2006=GET_USER_CONVERSATION_LIST）
  int64  sequence_id  = 2;  // 序列号（递增）
  int32  inbox_type   = 3;  // 通常为 0
  bytes  body         = 4;  // 内层 payload（嵌套 message）
  // ... 其他字段
}
```

### 3.2 SEND_MESSAGE (cmd=100) body 结构

`send` / `sendSticker` / `sendQuoteReply` 共用 cmd=100，body 结构：

```protobuf
message SendMessageBody {  // bodyType=100 包装
  string conversation_id           = 1;  // 如 "c2:uid1:uid2"
  int32  conversation_type        = 2;  // 1=私聊
  int64  conversation_short_id    = 3;  // int64，必须用 BigInt 编码
  string content                   = 4;  // content JSON（见 4.x 节）
  repeated ExtEntry ext           = 5;  // 扩展条目
  int32  message_type             = 6;  // 7=文本, 5=贴纸
  string ticket                    = 7;  // 会话凭证
  string client_message_id        = 8;  // UUID
  // field 11 仅引用回复消息使用
  RefmsgMetadata refmsg           = 11; // 引用元数据（仅 quote-reply）
}

message ExtEntry {
  string key   = 1;  // 如 "s:client_message_id"
  string value = 2;
}

message RefmsgMetadata {  // field 11 的结构
  int64  server_message_id    = 1;  // 被引用消息 ID
  string refmsg_meta_json     = 2;  // refmsg 元数据 JSON
  int64  server_message_id_2  = 3;  // 同 field 1
  int64  timestamp            = 4;  // 被引用消息时间戳（可选）
  repeated ExtEntry ext      = 5;  // s:ref_content, s:ref_is_edited
}
```

### 3.3 关键编码注意事项

#### conversation_short_id 精度问题

```typescript
//  错误：number 类型会丢失精度
const shortId = [ID_REDACTED];  // 超过 2^53，精度丢失
encodeVarintField(3, shortId);

//  正确：使用 BigInt
const shortIdBig = BigInt(sign.conversationShortId);
encodeVarintField(3, shortIdBig);
```

**精度丢失后果**：消息发送返回 `status=3`，或撤回时返回 `redis: nil`。

#### serverMsgId 读取精度

```typescript
//  错误：readVarint 返回 number，超过 2^53 丢失精度
const serverMsgId = readVarint(field);

//  正确：readVarintBigint 返回 bigint
const serverMsgId = readVarintBigint(field);
```

**精度丢失后果**：撤回消息时返回 `RPCError redis:nil`（server_message_id not found）。

### 3.4 ext 条目说明

所有发送消息都包含以下 ext 条目（顺序固定）：

| key | value | 说明 |
|-----|-------|------|
| `s:mentioned_users` | `""` | @的用户（私聊为空） |
| `s:client_message_id` | UUID | 客户端消息 ID（与 field 8 一致） |
| `a:chat_bubble` | `{"bubble_id":"[ID_REDACTED]","bubble_source":"1"}` | 气泡样式 |
| `s:stime` | `"1700000000000.5"` | 发送时间戳（毫秒+`.5`） |

引用回复消息额外包含（在 field 11 内）：

| key | value | 说明 |
|-----|-------|------|
| `s:ref_content` | 被引用消息的 content JSON | 字符串化 |
| `s:ref_is_edited` | `"false"` | 被引用消息是否被编辑过 |

---

## 4. 消息类型详解

### 4.1 文本消息 (aweType=700)

```json
{
  "aweType": 700,
  "type": 0,
  "richTextInfos": [],
  "text": "你好"
}
```

- `message_type` = 7
- `cmd` = 100

### 4.2 表情贴纸消息 (aweType=501)

```json
{
  "display_name": "",
  "height": 300,
  "width": 300,
  "image_id": [ID_REDACTED],
  "image_type": "webp",
  "package_id": [ID_REDACTED],
  "show_notice": false,
  "resource_type": 0,
  "updateConversationTime": true,
  "createdAt": 0,
  "is_card": false,
  "msgHint": "",
  "aweType": 501,
  "url": {
    "height": 0,
    "data_size": 0,
    "uri": "ies.fe.effect/xxx",
    "url_list": ["https://...", "https://..."],
    "width": 0
  }
}
```

- `message_type` = 5（与文本的 7 不同）
- `cmd` = 100
- `image_id` 和 `package_id` 可能是 number 或 string（抓包两种类型都出现过）
- `url_list` 通常有 2 个 URL（主备）

### 4.3 引用回复消息 (aweType=703)

content JSON：
```json
{
  "aweType": 703,
  "type": 0,
  "richTextInfos": [],
  "text": "回复内容"
}
```

body 中的 field 11（refmsg 元数据）：
```protobuf
RefmsgMetadata {
  server_message_id = [ID_REDACTED]     // field 1
  refmsg_meta_json = "{                        // field 2
    \"refmsg_type\": 7,
    \"content\": \"被引用消息的短文本\",
    \"refmsg_uid\": \"[ID_REDACTED]\",
    \"refmsg_sec_uid\": \"\",
    \"nickname\": \"对方昵称\",
    \"refmsg_content\": \"{被引用消息的完整content JSON}\",
    \"version\": 1,
    \"itemId\": \"\",
    \"scene_type\": 1
  }"
  server_message_id_2 = [ID_REDACTED]    // field 3（同 field 1）
  ext = [                                       // field 5
    { key: "s:ref_content", value: "{被引用消息的完整content JSON}" },
    { key: "s:ref_is_edited", value: "false" }
  ]
}
```

- `message_type` = 7（与文本一致，不是 703）
- `cmd` = 100
- field 4 (timestamp) 服务端未严格校验，可不设

### 4.4 图片消息 (aweType=2702)

#### 普通图片 (msgType=27)

content JSON 中的 `resource_url` 包含 `skey`：
```json
{
  "aweType": 2702,
  "resource_url": {
    "oid": "tos-cn-o-00061/uploadv2_xxx",
    "skey": "32字节hex字符串",
    "large_url_list": ["https://...~tplv-x-get:large.image"],
    "medium_url_list": ["..."],
    "thumb_url_list": ["..."]
  }
}
```

#### 加密图片 (msgType=91, aweType=0)

需要额外调用 `read_once/detail` 获取 `skey` 和 `large_url`：
- 每条消息只能查看一次
- 首次调用返回 `show_once_info`，之后返回空

### 4.5 图片加密算法（AES-256-GCM）

所有 `~tplv-x-get:*` 模板返回的图片都是 AES-256-GCM 加密的：

```
key    = skey（32 字节 hex 字符串，来自 read_once/detail 或 content.resource_url.skey）
nonce  = 密文前 12 字节
tag    = 密文末 16 字节
密文   = 中间部分（从 large_url_list[0] 下载）
明文   = WebP/JPEG/PNG 标准图片
```

解密示例：
```typescript
const ciphertext = Buffer.from(await cipherRes.arrayBuffer());
const key = Buffer.from(skey, 'hex');
const nonce = ciphertext.subarray(0, 12);
const tag = ciphertext.subarray(ciphertext.length - 16);
const data = ciphertext.subarray(12, ciphertext.length - 16);
const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
decipher.setAuthTag(tag);
const plain = Buffer.concat([decipher.update(data), decipher.final()]);
```

### 4.6 视频分享消息

content JSON 包含 `aweme_id`，通过 `getVideoDetail` 接口获取详情：
```json
{
  "aweType": xxx,
  "aweme_id": "[ID_REDACTED]"
}
```

### 4.7 撤回消息 (cmd=702)

```protobuf
message RecallMessageBody {  // bodyType=702
  string conversation_id        = 1;
  int64  conversation_short_id  = 2;  // 注意：这里是 short_id
  int32  message_type           = 3;  // 1=私聊
  int64  server_message_id     = 4;  // 要撤回的消息 ID
}
```

**字段映射陷阱**：field 2 是 `conversation_short_id`，field 4 是 `server_message_id`（最初被反向映射，已通过 send log 交叉验证修正）。

---

## 5. Web API 接口

### 5.1 表情贴纸收藏

```
POST https://www.douyin.com/aweme/v1/web/im/resource/sticker/collect/
```

**认证**：Cookie + a_bogus + msToken + verifyFp/fp

**请求参数**（query string）：
| 参数 | 示例 | 说明 |
|------|------|------|
| `aid` | `1128` | 注意：不是 6383 |
| `app_id` | `1128` | |
| `action` | `1` | 1=收藏, 0=取消 |
| `sticker_ids` | `[[ID_REDACTED]]` | JSON 数组 |
| `sticker_uri` | `ies.fe.effect/xxx` | |
| `sticker_url` | `https://...` | 签名 URL |
| `resource_id` | `[ID_REDACTED]` | 可能是负数 |
| `sticker_type` | `1` | |
| `verifyFp` | `s_v_web_id 的值` | 来自 cookie |
| `fp` | `s_v_web_id 的值` | 同 verifyFp |
| `a_bogus` | `DRk4NAAH...` | 签名 |
| `msToken` | `abcd1234...` | 风控 token |

**请求体**：固定 `"{}"`（空 JSON）

**响应**：
```json
{
  "status_code": 0,
  "success_items": [{
    "sticker_id": "[ID_REDACTED]",
    "animate_url": "...",
    "static_url": "...",
    "sticker_type": 2
  }]
}
```

### 5.2 视频详情查询

```
POST https://www.douyin.com/aweme/v1/web/multi/aweme/detail/
```

**认证**：Cookie + a_bogus + msToken

**请求参数**：
| 参数 | 示例 | 说明 |
|------|------|------|
| `aid` | `6383` | |
| `aweme_ids` | `["[ID_REDACTED]"]` | URL-encoded JSON 数组 |
| `origin_type` | `chat` | |
| `request_source` | `3` | |
| `conversation_short_id` | `[ID_REDACTED]` | |
| `a_bogus` | `...` | 签名 |
| `msToken` | `...` | |

**请求体**：固定 `"{}"`

### 5.3 用户信息批量查询（无需签名）

```
POST https://www.douyin.com/aweme/v1/web/im/user/info/
Content-Type: application/x-www-form-urlencoded

sec_user_ids=<URL编码的JSON数组，最多50个>
```

**响应**：
```json
{
  "data": [{
    "nickname": "用户昵称",
    "sec_uid": "[SEC_UID_REDACTED]",
    "uid": "[ID_REDACTED]",
    "avatar_thumb": {...}
  }],
  "status_code": 0
}
```

### 5.4 加密图片详情（无需签名）

```
GET https://www.douyin.com/aweme/v1/web/im/read_once/detail?msg_id=xxx&conversation_short_id=xxx
```

**响应**：`show_once_info` 是字符串化的 JSON，需二次 `JSON.parse`：
```javascript
const info = JSON.parse(j.show_once_info);
const oid = info.resource_url.oid;
const skey = info.resource_url.skey;
const largeUrl = info.resource_url.large_url_list[0];
```

---

## 6. CLI 命令参考

### 6.1 账号管理

| 命令 | 用法 | 说明 |
|------|------|------|
| `login` | `sprr login <name>` | 启动浏览器扫码登录 |
| `accounts` | `sprr accounts` | 列出所有账号 |
| `use` | `sprr use <name>` | 切换当前账号 |
| `logout` | `sprr logout <name> -f` | 删除账号 |
| `whoami` | `sprr whoami` | 显示当前账号 |

**全局选项**：
- `--account <name>`：临时使用指定账号
- `--state <path>`：指定 storageState 文件
- `--verbose`：详细日志
- `--json`：JSON 输出

### 6.2 会话与消息

#### list — 列出会话
```bash
npx tsx src/index.ts list
npx tsx src/index.ts list --json
```

#### history — 拉取聊天记录
```bash
npx tsx src/index.ts history --to TwT --limit 30
npx tsx src/index.ts history --to TwT --limit 500  # 自动分页
npx tsx src/index.ts history --to TwT --json
```

**输出格式**（改进后）：
```
  [2026-07-24 16:21:19] [文本] 对方: 你好 [id:[ID_REDACTED]]
  [2026-07-24 16:22:03] [表情] 对方: [表情] https://... [id:[ID_REDACTED]]
```

每条消息末尾的 `[id:xxx]` 是 `serverMsgId`，可直接用于 `reply`/`recall`/`collect-sticker` 等命令。

#### send — 发送文本
```bash
npx tsx src/index.ts send --to TwT --text "你好"
```

#### send-image — 发送图片
```bash
npx tsx src/index.ts send-image --to TwT --image ./pic.jpg
```

#### recall — 撤回消息
```bash
npx tsx src/index.ts recall --to TwT                    # 撤回最近一条自己发的
npx tsx src/index.ts recall --to TwT --msg-id [ID_REDACTED]
```

### 6.3 表情相关

#### send-sticker — 发送表情贴纸

**模式 A：从历史消息提取（转发对方表情）**
```bash
npx tsx src/index.ts send-sticker --to TwT --from-msg [ID_REDACTED]
```

**模式 B：从 JSON 文件读取**
```bash
npx tsx src/index.ts send-sticker --to TwT --sticker ./my-sticker.json
```

sticker.json 格式（支持 camelCase 和 snake_case）：
```json
{
  "image_id": [ID_REDACTED],
  "package_id": [ID_REDACTED],
  "width": 300,
  "height": 300,
  "image_type": "webp",
  "url": {
    "uri": "ies.fe.effect/xxx",
    "url_list": ["https://...", "https://..."]
  }
}
```

#### collect-sticker — 收藏表情贴纸
```bash
npx tsx src/index.ts collect-sticker --to TwT --msg-id [ID_REDACTED]
npx tsx src/index.ts collect-sticker --to TwT --msg-id [ID_REDACTED] --action 0  # 取消
```

**注意**：需要 a_bogus + msToken 签名，当前未实现，会失败。

### 6.4 引用回复

#### reply — 引用某条消息回复
```bash
npx tsx src/index.ts reply --to TwT --text "收到表情" --ref [ID_REDACTED]
```

`--ref` 是被引用消息的 `serverMsgId`，命令会自动从历史消息中拉取被引用消息的完整信息构造 `QuoteReplyRef`。

### 6.5 视频详情

#### video — 查看视频详情
```bash
# 直接指定 aweme_id
npx tsx src/index.ts video --to TwT --aweme-id [ID_REDACTED]

# 从历史视频分享消息中提取 aweme_id
npx tsx src/index.ts video --to TwT --msg-id [ID_REDACTED]
```

**注意**：需要 a_bogus + msToken 签名，当前未实现，会失败。

### 6.6 本地备注

```bash
npx tsx src/index.ts rename --uid [ID_REDACTED] --name "小明"
```

---

## 7. 完整工作流示范

### 7.1 场景一：转发对方发的表情包

```bash
# 1. 拉取历史消息
npx tsx src/index.ts history --to TwT --limit 30

# 输出：
#   [2026-07-24 16:22:03] [表情] 对方: [表情] https://... [id:[ID_REDACTED]]

# 2. 转发该表情
npx tsx src/index.ts send-sticker --to TwT --from-msg [ID_REDACTED]

# 3. 验证发送结果
npx tsx src/index.ts history --to TwT --limit 5
```

### 7.2 场景二：引用回复对方消息

```bash
# 1. 拉取历史消息
npx tsx src/index.ts history --to TwT --limit 30

# 输出：
#   [2026-07-24 16:21:19] [文本] 对方: 你好 [id:[ID_REDACTED]]

# 2. 引用回复
npx tsx src/index.ts reply --to TwT --text "你好，收到" --ref [ID_REDACTED]

# 3. 撤回刚发的回复
npx tsx src/index.ts recall --to TwT
```

### 7.3 场景三：引用回复对方表情包

```bash
# 1. 拉取历史
npx tsx src/index.ts history --to TwT --limit 30

# 输出：
#   [2026-07-24 16:22:03] [表情] 对方: [表情] https://... [id:[ID_REDACTED]]

# 2. 引用表情包回复文字
npx tsx src/index.ts reply --to TwT --text "这个表情好可爱" --ref [ID_REDACTED]
```

### 7.4 场景四：多账号管理

```bash
# 1. 登录小号
npx tsx src/index.ts login alice

# 2. 登录另一个号
npx tsx src/index.ts login bob

# 3. 列出账号
npx tsx src/index.ts accounts

# 4. 切换到 alice
npx tsx src/index.ts use alice

# 5. 临时使用 bob 操作（不切换当前账号）
npx tsx src/index.ts --account bob list
```

### 7.5 场景五：解密查看图片

```bash
# history 命令会自动解密图片到 data/decoded/
npx tsx src/index.ts history --to TwT --limit 30

# 输出：
#   检测到 2 条普通图片，解密下载...
#     已保存: data/decoded/tos-cn-o-00061_uploadv2_xxx.webp (12345 字节, WEBP)
#   加密图片解密完成: 成功 1 | 已被查看过 0 | 已保存 1 到 data/decoded
```

---

## 8. 抓包资源索引

### 8.1 JS 文件

| 文件 | 说明 |
|------|------|
| `data/capture/js/b4ffe03f6783_webmssdk.es5.js` | 签名 SDK（387KB） |
| `data/capture/js/7fa8a9ddf961_routes-Chat-route.0c639fb6.js` | 聊天页面路由代码 |

### 8.2 API 抓包样本

| 抓包文件 | 接口 | 用途 |
|---------|------|------|
| `0374_POST_9ee5ebfcf25e.json` | `/aweme/v1/web/im/resource/sticker/collect/` | 表情收藏 |
| `0328_POST_879932445c2c.json` | `/aweme/v1/web/multi/aweme/detail/` | 视频详情 |
| `categorized/send_message/*` | `/v1/message/send` | 发送消息 |

### 8.3 签名 SDK 元数据

```json
{
  "url": "https://lf-c-flwb.bytetos.com/obj/rc-client-security/c-webmssdk/1.0.0.20/webmssdk.es5.js",
  "hash": "b4ffe03f6783",
  "savedAt": "2026-07-24T08:20:47.544Z",
  "size": 387196
}
```

---

## 9. 常见问题排查

### 9.1 发送消息返回 status=3

**原因**：`conversation_short_id` 精度丢失

**解决**：确保使用 `BigInt` 编码：
```typescript
const shortIdBig = BigInt(sign.conversationShortId);
encodeVarintField(3, shortIdBig);
```

### 9.2 撤回返回 `RPCError redis:nil`

**原因**：`server_message_id` 精度丢失

**解决**：确保响应解析使用 `readVarintBigint`：
```typescript
const serverMsgId = readVarintBigint(field);  // 不是 readVarint
```

**验证方法**：serverMsgId 结尾为 `000` 通常是精度丢失的标志。

### 9.3 collect-sticker / video 命令失败

**原因**：缺少 a_bogus + msToken 签名

**临时方案**：在浏览器中手动操作（浏览器会自动注入签名）

**长期方案**：实现 playwright 页面内执行方案（见 2.5 节方案 B）

### 9.4 加密图片解密失败

**可能原因**：
1. `skey` 错误（32 字节 hex，不是 base64）
2. nonce/tag 偏移错误
3. URL 已过期（`large_url` 有 expires）

**验证方法**：
```bash
node scripts/decode-image.ts --url <url> --skey <skey> --oid <oid>
```

### 9.5 history 命令未显示 sticker 完整信息

当前 `formatMessageLine` 只显示 `[表情]` + URL。如需查看完整 content JSON（含 image_id/package_id 等），使用 `--json` 输出：

```bash
npx tsx src/index.ts history --to TwT --limit 5 --json | jq '.[] | select(.category=="sticker")'
```

### 9.6 sec_uid 提取问题

`sec_uid` 必须从原始字节中用正则提取（`MS4wLjAB...` 格式），因为 field 5 的类型可能不一致：

```typescript
const secUidMatch = rawBytes.match(/MS4wLjAB[A-Za-z0-9_-]+/);
```

### 9.7 read_once 消息只能查看一次

加密图片（msgType=91）每条消息只能查看一次：
- 首次调用 `read_once/detail` 返回 `show_once_info`
- 之后调用返回空（`status_code=0` 但无内容）

**注意**：在浏览器中查看过的加密图片，CLI 无法再次获取 URL（但可以重新下载已解密的图片，前提是 URL 未过期）。

---

## 附录 A：字段速查表

### aweType 与 message_type 对照

| 消息类型 | aweType | message_type | cmd | category |
|---------|---------|-------------|-----|----------|
| 文本 | 700 | 7 | 100 | text |
| 引用回复 | 703 | 7 | 100 | text |
| 表情贴纸 | 501 | 5 | 100 | sticker |
| 商店表情 | 508 | 5 | 100 | sticker |
| 普通图片 | 2702 | 27 | 100 | image |
| 加密图片 | 0 | 91 | 100 | image |
| 视频分享 | - | - | 100 | video_share |
| AI 回复 | - | - | 100 | ai_text |
| 系统提示 | - | - | 100 | system_tip |
| 撤回 | - | - | 702 | recall |

### 会话相关字段

| 字段 | 位置 | 类型 | 说明 |
|------|------|------|------|
| `conversationId` | list 响应 field 1 | string | 如 `c2:uid1:uid2` |
| `conversationShortId` | list 响应 field 2 | int64 | 必须用 string/bigint 传参 |
| `conversationType` | list 响应 field 3 | int32 | 1=私聊 |
| `ticket` | ext field 4 | string | 会话级凭证 |
| `unreadCount` | list 响应 field 10 | int32 | 未读数（非总数） |
| `read_index` | field 51.14 | int64 | 已读位置 |
| `max_seq` | read_index + unreadCount | int64 | 最大消息序号 |

---

## 附录 B：文件结构

```
SPRR/
├── src/
│   ├── index.ts              # CLI 入口（所有命令）
│   ├── api/
│   │   ├── operations.ts     # API 操作（send/history/recall/sticker/quote-reply）
│   │   ├── imapi.ts          # imapi 底层客户端（protobuf 编解码）
│   │   ├── webapi.ts         # web API 客户端（JSON 接口）
│   │   ├── tos.ts            # 图片上传（TOS）
│   │   └── client.ts         # HTTP 客户端基础
│   ├── auth/
│   │   ├── session.ts        # 会话管理
│   │   └── accounts.ts       # 多账号管理
│   ├── crypto/
│   │   └── signature.ts      # 签名算法（stub，待实现）
│   ├── commands/
│   │   └── login.ts          # playwright 登录流程
│   ├── config/
│   │   └── paths.ts          # 路径常量
│   └── utils/
│       └── logger.ts         # 日志工具
├── data/
│   ├── accounts/             # 账号 storageState
│   ├── capture/              # 抓包数据
│   │   ├── api/              # API 请求/响应
│   │   ├── js/               # JS 文件（含 webmssdk）
│   │   └── categorized/      # 分类后的抓包
│   ├── decoded/              # 解密后的图片
│   ├── aliases.json          # 本地备注
│   └── accounts/current      # 当前账号指针
├── scripts/
│   ├── decode-image.ts       # 图片解密工具
│   ├── test-send-via-page-fetch.ts  # playwright 签名注入验证
│   └── capture.ts            # 抓包脚本
├── TECHNICAL.md              # 本文档
├── package.json
└── tsconfig.json
