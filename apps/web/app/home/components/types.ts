export type MessageRole = "user" | "assistant";

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  meta: string;
};
