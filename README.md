# AI Q&A Monorepo

一个基于 `pnpm workspace` 的全栈 AI 项目，包含：
- 通用 AI 对话（流式）
- 语音问答（ASR + TTS）
- 书籍知识库问答（TXT/EPUB/PDF/DOCX）
- Hybrid RAG（多 query 扩展 + ES/Milvus 混合召回 + Rerank + 生成）

## 项目结构

```text
.
├─ apps
│  ├─ web               # Next.js 前端
│  └─ api               # NestJS 后端
├─ packages
├─ package.json
└─ pnpm-workspace.yaml
```

## 技术栈

- 前端：Next.js 15、React 19、TypeScript
- 后端：NestJS 11、TypeORM、MySQL
- AI：AI SDK、LangChain、OpenAI Compatible API
- 检索：Milvus、Elasticsearch、Kibana
- 语音：腾讯云 ASR/TTS
- 通信：SSE（UIMessage Data Stream）+ WebSocket（TTS 流）

## 核心能力

1. 通用 AI 对话
- 前端使用 `@ai-sdk/react` 的 `useChat`
- 后端按 Data Stream Protocol 输出 `UIMessage`

2. 书籍知识库问答
- 上传 `.txt/.epub`
- 自动切分、向量化并写入 Milvus
- 元信息写入 MySQL
- 文本分片写入 Elasticsearch（用于关键词召回）

3. Hybrid RAG（复杂问题）
- LLM 进行多 query 扩展（1-3 条）
- ES 与 Milvus 并行召回
- 合并去重后做 Rerank
- 基于重排后的片段生成回答

4. 语音链路
- 录音上传 ASR
- TTS 通过 WebSocket 推流到前端
- 前端使用 `MediaSource + SourceBuffer` 边收边播

## 本地启动

### 1) 安装依赖

```bash
pnpm install
```

### 2) 启动基础服务（ES/MySQL/Milvus/Kibana）

```bash
docker compose -f apps/api/docker-compose.yml up -d
```

### 3) 配置环境变量

在以下两个位置创建 `.env.local` 文件：

#### `apps/api/.env.local`（后端）

```bash
# OpenAI API config
OPENAI_API_KEY=your_openai_api_key
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=qwen-plus

EMBEDDINGS_MODEL_NAME=text-embedding-v3

# 腾讯云语音 (ASR + TTS)
SECRET_ID=your_tencent_secret_id
SECRET_KEY=your_tencent_secret_key
APP_ID=your_tencent_app_id
TTS_VOICE_TYPE=502001

# Hybrid retrieval (ES + Milvus + Rerank)
ES_NODE=http://localhost:9200
ES_INDEX=book                            # 可选，为空则使用当前书籍 collection 名
RERANK_API_KEY=your_rerank_api_key
RERANK_MODEL=qwen3-rerank
RERANK_BASE_URL=https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank

# MySQL
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASS=admin
DB_NAME=book
DB_SYNCHRONIZE=true
DB_LOGGING=true

# 文件存储 (local | s3)
STORAGE_DRIVER=local

# S3 配置（STORAGE_DRIVER=s3 时需要）
S3_REGION=
S3_BUCKET=
S3_ENDPOINT=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=false
S3_KEY_PREFIX=books
S3_PUBLIC_BASE_URL=

# 联网搜索
BOCHA_API_KEY=your_bocha_api_key

# 邮件服务
MAIL_HOST=smtp.qq.com
MAIL_PORT=587
MAIL_SECURE=false
MAIL_USER=your_mail_user
MAIL_PASS=your_mail_password
MAIL_FROM="No Reply" <your_mail_user>

# 服务端口（默认 4000）
PORT=4000
```

#### `apps/web/.env.local`（前端）

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
NEXT_PUBLIC_API_WS_BASE_URL=ws://localhost:4000
```

> 部署时参考 `apps/api/.env.deploy.example`，其中包含了 Milvus、CORS 等额外的部署环境变量。

### 4) 启动应用

```bash
pnpm --filter api dev
pnpm --filter web dev
```

默认地址：
- Web: `http://localhost:3000`
- API: `http://localhost:4000`
- ES: `http://localhost:9200`
- Kibana: `http://localhost:5601`

## 常用命令

```bash
pnpm dev
pnpm build
pnpm --filter api build
pnpm --filter web build
```

## 主要接口

- 通用对话：`POST /ai/chat`
- 书籍上传：`POST /book/save`
- 书籍问答：`POST /book/read`
- 语音识别：`POST /speech/asr`
- 语音合成中继：`WS /speech/tts/ws`

## 说明

- 这是一个工程化实践项目，重点是“链路完整可运行”。


