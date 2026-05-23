import Link from "next/link";
import { Noto_Sans_SC, Space_Grotesk } from "next/font/google";
import styles from "./page.module.css";

const notoSansSc = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const featureList = [
  {
    title: "AI 对话",
    desc: "流式回复、多轮上下文、工具调用渲染，基于 AI SDK Data Stream 协议。",
  },
  {
    title: "语音交互",
    desc: "前端录音上传 ASR 识别，回答通过 WebSocket 中继 TTS 流式播放。",
  },
  {
    title: "文档知识库",
    desc: "支持 TXT / EPUB / PDF / DOCX 上传，自动切分、向量化入库，基于文档内容检索增强回答。",
  },
  {
    title: "Hybrid RAG",
    desc: "多 query 扩展，ES + Milvus 并行召回，合并去重 + Rerank 后生成最终答案。",
  },
];

const dockerServices = [
  {
    name: "Elasticsearch",
    port: "9200",
    desc: "全文搜索引擎，配合 IK 中文分词，承担 BM25 关键词召回。",
  },
  {
    name: "MySQL",
    port: "3306",
    desc: "关系型数据库，存储书籍元信息、对话记录等业务数据。",
  },
  {
    name: "Milvus",
    port: "19530",
    desc: "向量数据库，存储文档 embedding，承担语义向量召回。",
  },
];

const stackList = [
  "Next.js 15 + React 19 + TypeScript",
  "NestJS 11 + SSE + WebSocket",
  "AI SDK + LangChain + OpenAI Compatible API",
  "MySQL + TypeORM",
  "Milvus + Elasticsearch + Kibana",
  "Tencent Cloud ASR/TTS",
  "pnpm workspace Monorepo",
];

export default function HomePage() {
  return (
    <main
      className={`${styles.page} ${spaceGrotesk.className} ${notoSansSc.className}`}
    >
      <div className={styles.bgGlowOne} />
      <div className={styles.bgGlowTwo} />

      <section className={styles.hero}>
        <p className={styles.kicker}>AI Full-Stack Workspace</p>
        <h1 className={styles.title}>智阅 AI</h1>
        <p className={styles.subtitle}>
          上传文档，智能问答。支持 AI 对话、语音交互、文档知识库检索与混合召回。
        </p>
        <div className={styles.actions}>
          <Link className={styles.primaryBtn} href="/home">
            开始对话
          </Link>
          <Link className={styles.ghostBtn} href="/book">
            文档问答
          </Link>
        </div>
      </section>

      <section className={styles.grid}>
        <article className={styles.card}>
          <h2 className={styles.cardTitle}>项目简介</h2>
          <p className={styles.cardText}>
            前后端分离的 Monorepo 工程，将 AI
            对话、语音交互、文档知识库检索整合为一体化应用，而非单点 Demo。
          </p>
        </article>

        <article className={styles.card}>
          <h2 className={styles.cardTitle}>核心能力</h2>
          <ul className={styles.list}>
            {featureList.map((item) => (
              <li key={item.title} className={styles.listItem}>
                <strong>{item.title}</strong>
                <span>{item.desc}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className={`${styles.card} ${styles.cardWide}`}>
          <h2 className={styles.cardTitle}>技术栈</h2>
          <div className={styles.techWrap}>
            {stackList.map((item) => (
              <span key={item} className={styles.techPill}>
                {item}
              </span>
            ))}
          </div>
        </article>

        <article className={`${styles.card} ${styles.cardWide}`}>
          <h2 className={styles.cardTitle}>Docker 服务</h2>
          <div className={styles.dockerGrid}>
            {dockerServices.map((svc) => (
              <div key={svc.name} className={styles.dockerItem}>
                <div className={styles.dockerHeader}>
                  <strong className={styles.dockerName}>{svc.name}</strong>
                  <span className={styles.dockerPort}>:{svc.port}</span>
                </div>
                <span className={styles.dockerDesc}>{svc.desc}</span>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}
