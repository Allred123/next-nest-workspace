import styles from "../home.module.css";

type ChatHeaderProps = {
  statusText: string;
  isTyping: boolean;
  title?: string;
  subtitle?: string;
};

export function ChatHeader({
  statusText,
  isTyping,
  title = "AI 助手",
  subtitle = "录音后自动识别，再调用 AI 流式回复",
}: ChatHeaderProps) {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      <div className={styles.subtitle}>{subtitle}</div>
      <div className={`${styles.statusPill} ${isTyping ? styles.typing : ""}`}>
        状态：{statusText}
      </div>
    </header>
  );
}
