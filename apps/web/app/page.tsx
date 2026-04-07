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
    desc: "基于 SSE 的实时流式回复，支持多轮连续提问和状态反馈。",
  },
  {
    title: "语音问答链路",
    desc: "语音输入接入 ASR，AI 输出可实时 TTS 播放，并支持一键开关语音能力。",
  },
  {
    title: "书籍知识库问答",
    desc: "上传 EPUB/TXT 后分块向量化，按检索结果进行 RAG 回答。",
  },
  {
    title: "本地会话记忆",
    desc: "无登录场景下使用 localStorage 保存会话，并自动注入 recent window。",
  },
];

const stackList = [
  "Next.js 15 + React 19 + TypeScript",
  "NestJS 11 + SSE + WebSocket",
  "LangChain + OpenAI 模型调用",
  "MySQL + TypeORM（结构化数据）",
  "Milvus（向量检索）",
  "Tencent Cloud ASR/TTS（语音能力）",
  "pnpm workspace Monorepo",
];

export default function HomePage() {
  return (
    <main className={`${styles.page} ${spaceGrotesk.className} ${notoSansSc.className}`}>
      <div className={styles.bgGlowOne} />
      <div className={styles.bgGlowTwo} />

      <section className={styles.hero}>
        <p className={styles.kicker}>AI Full-Stack Workspace</p>
        <h1 className={styles.title}>Next.js + NestJS 智能问答平台</h1>
        <p className={styles.subtitle}>
          一个支持文本、语音、书籍知识库检索问答的全栈项目，前后端分离并通过 pnpm workspace 管理。
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
          <h2 className={styles.cardTitle}>项目介绍</h2>
          <p className={styles.cardText}>
            项目采用 Monorepo 架构，`apps/web` 提供交互式前端界面，`apps/api` 提供
            AI、语音和知识库服务。整体目标是实现可扩展、低耦合的 AI 应用基础设施。
          </p>
        </article>

        <article className={styles.card}>
          <h2 className={styles.cardTitle}>功能描述</h2>
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
