# DYCC: Douyin IM Automation Toolkit

基于 TypeScript 实现的抖音 Web API 逆向与自动化工具集，供学习交流与技术研究使用。

---

## 声明

本项目仅供学习参考、思路研究与技术交流使用。

- 不得用于任何商业用途或违反服务条款的场景。
- 如涉及侵权，请联系邮箱 [islont@proton.me] 进行下架处理。
- 项目开发初衷为打造「虚拟恋人」聊天机器人，为 AI 能力提供自动化指令集。

---

## 项目状态（2026 年 8 月）

### API 变化追踪

抖音于 2026 年 8 月对 IM 相关 API 进行了较大调整，当前追踪进度如下：

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 消息推送架构 | 已适配 | 已由 WebSocket 迁移至 HTTP 轮询，新增 `cmd=2048` 接口 `/v1/message/get_user_message`，`watch` 默认轮询模式 |
| 新增 cmd 编号 | 部分解析 | `2043`（init 同步）、`2048`（轮询）已解析并接入；`2010`（client ack）结构已知、未强依赖 |
| 仅读一次消息 | 已识别 | `msgType=104`, `aweType=10400`, 扩展字段 `s:once_view_count = "1"` |
| 签名参数 | 已识别 | `device_platform`, `msToken`, `a_bogus`, `verifyFp`, `fp` |
| 新增签名头 | 已识别 | `bd-ticket-guard-*` 系列 + `x-tt-session-dtrait` |

### 技术路线调整

面对频繁的 API 变更与持续增强的 VM 混淆，项目调整实现策略：

> 由纯算逆向 VM 字节码，转向「浏览器伪环境 + 请求拦截」方案。

优势：
- 降低维护成本，无需跟随每一次混淆更新进行底层逆向
- 缩短初始化耗时，提升启动性能
- 天然兼容浏览器侧新增的签名机制（secsdk / ticket-guard）

代码重构进行中，后续将逐步恢复以下能力：
- ~~实时消息监控（watch）的 HTTP 轮询适配~~（已完成：`watch` 默认轮询模式，无需浏览器）
- 直播间自动评论
- 已读/未读状态自定义
- 其他自动化场景

---

## 功能概览

- **私信管理**：扫码登录 / 多账号切换 / 会话列表 / 聊天记录拉取 / 文本图片贴纸发送 / 撤回 / 引用回复 / 实时推送监控
- **资料与互动**：个人资料查询修改 / 互动通知（点赞、评论、粉丝、@提及）/ 通知详情解析
- **视频与评论**：视频详情 / 评论分页拉取 / 评论发布与回复 / @提及 / 表情贴纸收藏
- **AI 自动回复**：基于 ai-server 的人格化回复、白名单控制、会话存档
- **开发工具**：HTTP + WebSocket 全流量抓包脚本 / ticket-guard 签名头自动获取 / a_bogus 签名纯算

---

## 快速开始

### 环境要求

- Node.js >= 18
- pnpm 或 npm
- Playwright Chromium（首次运行时自动下载）

### 依赖安装

```bash
cd SPRR
pnpm install
```

### 启动交互模式（推荐）

```bash
npx tsx src/indexv2.ts
```

进入 `◆ sprr> ` 提示符后，依次执行：

```
◆ sprr> login myaccount
◆ sprr> list
◆ sprr> send --to <目标> --text "消息内容"
◆ sprr> exit
```

完整命令参考（含所有参数、AI 自动回复配置、常见问题）见 [clu.md](./clu.md)。

---

## 项目结构

```
DYCC/
├── SPRR/                          # 核心自动化工具（TypeScript）
│   ├── src/
│   │   ├── api/                   # API 客户端封装
│   │   ├── auth/                  # 账号与会话管理
│   │   ├── cli/                   # CLI 框架层
│   │   ├── commands/              # 子命令实现（账号/消息/媒体/资料/签名头/监控）
│   │   ├── crypto/                # 加密与签名（a_bogus / protobuf / ticket-guard）
│   │   ├── im/                    # IM 桥接层
│   │   ├── types/                 # 类型定义
│   │   ├── utils/                 # 工具函数集
│   │   ├── ai-reply.ts            # AI 自动回复逻辑
│   │   └── indexv2.ts             # CLI 入口（V2 REPL）
│   ├── scripts/
│   │   └── debug-capture.ts       # 抓包工具：HTTP + WebSocket 全流量捕获
│   └── data/                      # 运行时数据（不纳入版本控制）
└── ai-server/                     # AI 聊天服务（Node.js）
    ├── src/
    │   ├── chat.js                # 聊天核心逻辑
    │   ├── http-server.js         # HTTP API 服务
    │   ├── schedule.js            # 定时任务调度
    │   ├── session.js             # 对话会话管理
    │   ├── persona.js             # 人格设定加载
    │   └── deepseek.js / reasoning.js  # LLM 接入
    └── personas/                  # 人格配置文件
```

---

## 贡献

项目的持续演进依赖社区参与，欢迎以多种形式贡献。贡献类型：

1. **Bug 报告**：通过 Issue 提交，附 `--verbose --json` 完整日志与复现步骤
2. **API 逆向发现分享**：使用 `scripts/debug-capture.ts` 抓包后，将 `summary.json` 关键信息整理至 Issue
3. **代码 Pull Request**：可认领方向包括 cmd 解析、轮询 watch 适配、secsdk 研究、类型补全、新命令扩展
4. **文档改进**：修正错误、补充说明、多语言翻译

完整的贡献流程、代码规范与可认领方向清单详见 [clu.md 贡献章节](./clu.md#贡献指南)。

---

完整命令参考、AI 配置、常见问题排查、抓包工具使用说明：
**请阅读 [clu.md](./clu.md)**

如本项目对您有所帮助，欢迎通过 Star 表示支持。
