import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "../home.module.css";
import type { ChatMessage } from "./types";

type MessageListProps = {
  messages: ChatMessage[];
};

export function MessageList({ messages }: MessageListProps) {
  return (
    <section className={styles.messages} id="messages">
      {messages.length === 0 ? (
        <div className={styles.empty}>点击下方开始录音，体验语音问答。</div>
      ) : null}

      {messages.map((message) => (
        <div
          key={message.id}
          className={`${styles.msgRow} ${styles[message.role]}`}
        >
          <div className={styles.bubble}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
            <div className={styles.meta}>{message.meta}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
