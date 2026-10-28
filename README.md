# DYCC: Douyin IM Automation Toolkit

基于 TypeScript 实现的抖音 Web API 逆向与自动化工具集，供学习交流与技术研究使用。

---

## 声明
目前安全不封号 by:2026-10-28
---
## 项目状态（2026 年 10 月）
## 功能概览

- **私信管理**：扫码登录 / 多账号切换 / 会话列表 / 聊天记录拉取 / 文本图片贴纸发送 / 撤回 / 引用回复 / 实时推送监控
- **资料与互动**：个人资料查询修改 / 互动通知（点赞、评论、粉丝、@提及）/ 通知详情解析
- **视频与评论**：视频详情 / 评论分页拉取 / 评论发布与回复 / @提及 / 表情贴纸收藏
- **AI 自动回复**：基于 ai-server 的人格化回复、白名单控制、会话存档
- **开发工具**：HTTP + WebSocket 全流量抓包脚本 / 评论发布专用抓包脚本（有头窗口，人工配合过验证）/ ticket-guard 签名头自动获取 / a_bogus 签名纯算

---

## 快速开始

### 环境要求

- Node.js >= 24
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
◆ sprr> history --to #1
◆ sprr> send --text "消息内容"
◆ sprr> exit
```

`history --to <UID/昵称/#序号>` 成功后选定当前会话，提示符显示会话名；后续消息命令可省略 `--to`。尚未选择会话时必须指定目标，重名时请使用 UID 或列表序号。

V2 中 `list` 刷新常规会话及未读状态，同时复用昵称和陌生人查询缓存；限流会保留可用结果并提示查询未完成。引用回复优先复用已加载消息。`history` 默认仅展示消息，下载普通图片需加 `--download-images`，读取一次性图片需加 `--read-once`（会消费查看机会）。默认日志级别为 INFO，排查时使用 `--verbose`。

完整命令参考（含所有参数、AI 自动回复配置、常见问题）见 [clu.md](./clu.md)。

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
