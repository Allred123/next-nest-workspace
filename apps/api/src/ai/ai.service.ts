import { Inject, Injectable } from "@nestjs/common";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import type { UIMessage, UIMessageChunk } from "ai";
import { toBaseMessages, toUIMessageStream } from "@ai-sdk/langchain";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  AI_TTS_STREAM_EVENT,
  type AiTtsStreamEvent,
} from "../common/stream-events";

@Injectable()
export class AiService {
  private readonly agent;

  constructor(
    @Inject("CHAT_MODEL") model: ChatOpenAI,
    @Inject("SEND_MAIL_TOOL") private readonly sendMailTool: any,
    @Inject("WEB_SEARCH_TOOL") private readonly webSearchTool: any,
    @Inject("TIME_NOW_TOOL") private readonly timeNowTool: any,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.agent = createAgent({
      model,
      tools: [this.sendMailTool, this.webSearchTool, this.timeNowTool],
      systemPrompt:
        "你是 AI 助手。需要获取当前时间时调用 time_now；需要联网搜索时调用 web_search；用户明确要求发邮件时调用 send_mail。",
    });
  }

  async createUIMessageStream(
    messages: UIMessage[],
    ttsSessionId?: string,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const langchainMessages = await toBaseMessages(messages);

    const stream = await this.agent.stream(
      { messages: langchainMessages },
      { streamMode: ["values", "messages"] },
    );

    return toUIMessageStream(stream, {
      onText: async (text) => {
        if (!ttsSessionId || !text) return;
        const event: AiTtsStreamEvent = {
          type: "chunk",
          sessionId: ttsSessionId,
          chunk: text,
        };
        this.eventEmitter.emit(AI_TTS_STREAM_EVENT, event);
      },
      onFinish: async () => {
        if (!ttsSessionId) return;
        const endEvent: AiTtsStreamEvent = {
          type: "end",
          sessionId: ttsSessionId,
        };
        this.eventEmitter.emit(AI_TTS_STREAM_EVENT, endEvent);
      },
      onError: async (error) => {
        if (!ttsSessionId) return;
        const errorEvent: AiTtsStreamEvent = {
          type: "error",
          sessionId: ttsSessionId,
          error: error instanceof Error ? error.message : String(error),
        };
        this.eventEmitter.emit(AI_TTS_STREAM_EVENT, errorEvent);
      },
    });
  }

  extractLastUserText(messages: UIMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== "user") continue;

      const text = message.parts
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();

      if (text) return text;
    }
    return "";
  }
}
