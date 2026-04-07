# AI Q&A Monorepo

基于 `pnpm workspace` 的前后端分离 AI 问答项目，支持文本对话、语音问答、书籍知识库问答（RAG）。

项目已升级为 AI SDK 协议化流式架构：
- 后端通过 Data Stream Protocol 输出 `UIMessage` SSE
- 前端使用 `@ai-sdk/react` 的 `useChat` 消费流
- 消息按 `message.parts` 渲染文本与工具调用（`web_search`、`send_mail`）

## 技术栈

- 前端：`Next.js 15`、`React 19`、`TypeScript`
- 后端：`NestJS 11`、`TypeORM`、`MySQL`
- AI：`LangChain(createAgent)`、`@ai-sdk/langchain`、`ai`、`@ai-sdk/react`
- RAG：`Milvus` 向量检索、`.epub/.txt` 分块向量化入库
- 流式通信：`SSE`（Data Stream Protocol）+ `WebSocket`（TTS 音频中继）
- 语音：腾讯云 `ASR/TTS`
- 渲染：`streamdown`（Markdown/表格/Mermaid/代码块）

## 项目特性

1. 工程架构
- `apps/web`（Next.js）+ `apps/api`（NestJS）分离部署
- `pnpm workspace` 管理 Monorepo 与依赖

2. 通用 AI 对话
- 基于 `LangChain createAgent` + tools（`web_search`、`send_mail`、`time_now`）
- 后端流式输出 Data Stream Protocol，前端 `useChat` 实时消费

3. 工具调用可视化
- 文本部分使用 `StreamdownText` 流式渲染
- 工具调用按 `message.parts` 渲染为独立组件（检索面板、邮件面板）

4. 语音全链路
- 录音上传 `ASR` 转写
- `WebSocket` 中继 `TTS` 音频，支持边生成边播与语音开关

5. 书籍知识库问答（RAG）
- 支持 `.epub/.txt` 上传
- 服务端分块、向量化并写入 Milvus
- 按 `bookId` 检索上下文并生成答案

6. 本地会话记忆
- `localStorage` 持久化 `sessionId` 与消息记录
- 无登录即可恢复会话

## 目录结构

```text
.
├─ apps
│  ├─ web                 # Next.js 前端
│  │  └─ app
│  │     ├─ home/components
│  │     ├─ book
│  │     └─ components    # StreamdownText / ToolPanels
│  └─ api                 # NestJS 后端
│     └─ src
│        ├─ ai
│        ├─ speech
│        ├─ book
│        └─ tool
├─ packages
├─ package.json
└─ pnpm-workspace.yaml
```

## 快速开始

### 1. 环境要求

- `Node.js >= 18`
- `pnpm >= 10`
- 可用的 `MySQL` 与 `Milvus`

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境变量

在 `apps/api/.env` 中配置（示例）：

```env
# 基础
PORT=3001

# LLM / Embedding
OPENAI_API_KEY=
OPENAI_BASE_URL=
MODEL_NAME=
EMBEDDINGS_MODEL_NAME=
EMBEDDINGS_DIM=1024

# Milvus
MILVUS_ADDRESS=localhost:19530

# MySQL（当前代码默认在 app.module.ts 中写死了 localhost/root/admin/hello，可按需改为环境变量）

# 腾讯云语音
SECRET_ID=
SECRET_KEY=
APP_ID=
TTS_VOICE_TYPE=101001

# 搜索工具
BOCHA_API_KEY=

# 邮件工具
MAIL_HOST=
MAIL_PORT=
MAIL_SECURE=false
MAIL_USER=
MAIL_PASS=
MAIL_FROM=
```

前端可选环境变量 `apps/web/.env.local`：

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
NEXT_PUBLIC_API_WS_BASE_URL=ws://localhost:3001
```

### 4. 启动开发环境

```bash
pnpm dev
```

默认端口：
- Web: `http://localhost:3000`
- API: `http://localhost:3001`

## 关键接口

- 通用聊天（Data Stream Protocol）：`POST /ai/chat`
- 书籍问答（Data Stream Protocol）：`POST /book/read`
- 书籍问答（旧 SSE 文本流，保留）：`GET /book/read/stream`
- 语音识别：`POST /speech/asr`
- 语音合成中继：`WS /speech/tts/ws`
- 书籍上传：`POST /book/save`
- 书籍列表：`GET /book/list`

## 脚本命令

根目录：

```bash
pnpm dev
pnpm build
pnpm start
```

子应用：

```bash
pnpm --filter web dev
pnpm --filter web build
pnpm --filter api dev
pnpm --filter api build
```

## 当前实现说明

- 前端主聊天页与书籍问答页均已接入 `useChat`
- 消息渲染统一走 `UIMessage.parts`
- 文本使用 Streamdown 流式渲染
- `web_search` / `send_mail` 工具输出使用独立 UI 面板

## License

仅供学习与交流使用。
