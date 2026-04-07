import styles from "../home.module.css";
import type { ChatMessage } from "./types";
import { MessagePart } from "../../components/ToolPanels";

type MessageListProps = {
  messages: ChatMessage[];
  isStreaming: boolean;
};

function findLastAssistantId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      return messages[i].id;
    }
  }
  return undefined;
}

function findLastTextPartIndex(message: ChatMessage): number {
  for (let i = message.parts.length - 1; i >= 0; i -= 1) {
    if (message.parts[i].type === "text") {
      return i;
    }
  }
  return -1;
}

export function MessageList({ messages, isStreaming }: MessageListProps) {
  const lastAssistantId = findLastAssistantId(messages);

  return (
    <section className={styles.messages} id="messages">
      {messages.length === 0 ? (
        <div className={styles.empty}>点击下方开始录音，体验语音问答。</div>
      ) : null}

      {messages.map((message) => {
        const roleClass = message.role === "user" ? styles.user : styles.assistant;
        const lastTextPartIndex = findLastTextPartIndex(message);
        const isLastAssistantMessage =
          isStreaming && message.role === "assistant" && message.id === lastAssistantId;

        return (
          <div key={message.id} className={`${styles.msgRow} ${roleClass}`}>
            <div className={styles.bubble}>
              {message.parts.map((part, index) => (
                <MessagePart
                  key={`${message.id}-${index}`}
                  part={part}
                  textStreamActive={
                    isLastAssistantMessage &&
                    part.type === "text" &&
                    index === lastTextPartIndex
                  }
                />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
