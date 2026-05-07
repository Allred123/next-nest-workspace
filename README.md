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

请参考并填写：
- `apps/api/.env.local`
- `apps/api/.env.deploy.example`

重点变量：
- LLM：`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`MODEL_NAME`
- Embedding：`EMBEDDINGS_MODEL_NAME`、`EMBEDDINGS_DIM`
- DB：`DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASS`、`DB_NAME`
- Milvus：`MILVUS_ADDRESS`、`MILVUS_TOKEN`（可选）
- Hybrid：`ES_NODE`、`ES_INDEX`、`RERANK_API_KEY`、`RERANK_MODEL`、`RERANK_BASE_URL`
- 语音：`SECRET_ID`、`SECRET_KEY`、`APP_ID`、`TTS_VOICE_TYPE`

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


