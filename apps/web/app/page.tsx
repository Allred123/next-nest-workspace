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
    title: "通用 AI 对话",
    desc: "基于 AI SDK Data Stream 协议的流式回复，支持多轮上下文与工具调用渲染。",
  },
  {
    title: "语音问答链路",
    desc: "前端录音上传 ASR，回答可通过 WebSocket 中继进行 TTS 流式播放。",
  },
  {
    title: "书籍知识库问答",
    desc: "支持 TXT/EPUB/PDF/DOCX 上传、切分、向量化入库，并基于书籍内容进行检索增强回答。",
  },
  {
    title: "Hybrid RAG",
    desc: "复杂问题走多 query 扩展，ES + Milvus 并行召回，合并去重、Rerank 后再生成答案。",
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
        <h1 className={styles.title}>AI 对话与书籍检索问答平台</h1>
        <p className={styles.subtitle}>
          一个前后端分离的 Monorepo
          项目，覆盖文本对话、语音交互、书籍知识库检索与混合召回问答。
        </p>
        <div className={styles.actions}>
          <Link className={styles.primaryBtn} href="/home">
            进入聊天
          </Link>
          <Link className={styles.ghostBtn} href="/book">
            进入书籍问答
          </Link>
        </div>
      </section>

      <section className={styles.grid}>
        <article className={styles.card}>
          <h2 className={styles.cardTitle}>项目定位</h2>
          <p className={styles.cardText}>
            `apps/web` 提供交互式前端，`apps/api` 提供
            AI、语音和知识库能力。项目重点是把“可用的 AI
            功能链路”做成一体化工程，而不是单点 Demo。
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
      </section>
    </main>
  );
}
