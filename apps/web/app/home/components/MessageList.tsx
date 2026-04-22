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

function getMessageParts(message: ChatMessage): ChatMessage["parts"] {
  if (Array.isArray((message as { parts?: ChatMessage["parts"] }).parts)) {
    return (message as { parts: ChatMessage["parts"] }).parts;
  }

  // Backward compatibility for cached legacy messages that only contain `content`.
  const legacyContent = (message as { content?: unknown }).content;
  if (typeof legacyContent === "string" && legacyContent.trim().length > 0) {
    return [{ type: "text", text: legacyContent }] as ChatMessage["parts"];
  }

  return [] as ChatMessage["parts"];
}

function findLastTextPartIndex(parts: ChatMessage["parts"]): number {
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i].type === "text") {
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

      {messages.map((message, messageIndex) => {
        const parts = getMessageParts(message);
        const messageKeyBase = message.id?.trim()
          ? `${message.id}-${messageIndex}`
          : `message-${messageIndex}`;
        const roleClass =
          message.role === "user" ? styles.user : styles.assistant;
        const lastTextPartIndex = findLastTextPartIndex(parts);
        const isLastAssistantMessage =
          isStreaming &&
          message.role === "assistant" &&
          message.id === lastAssistantId;

        return (
          <div key={messageKeyBase} className={`${styles.msgRow} ${roleClass}`}>
            <div className={styles.bubble}>
              {parts.map((part, index) => (
                <MessagePart
                  key={`${messageKeyBase}-part-${index}`}
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
