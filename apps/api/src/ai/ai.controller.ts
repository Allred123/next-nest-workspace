import { Body, Controller, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import type { UIMessage } from "ai";
import { pipeUIMessageStreamToResponse } from "ai";
import { AiService } from "./ai.service";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { AI_TTS_STREAM_EVENT, type AiTtsStreamEvent } from "../common/stream-events";

type ChatRequestBody = {
  messages?: UIMessage[];
  ttsSessionId?: string;
};

@Controller("ai")
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Post("chat")
  async chat(
    @Body() body: ChatRequestBody,
    @Res() response: Response,
  ): Promise<void> {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sessionId = body.ttsSessionId?.trim();

    if (sessionId) {
      const startEvent: AiTtsStreamEvent = {
        type: "start",
        sessionId,
        query: this.aiService.extractLastUserText(messages),
      };
      this.eventEmitter.emit(AI_TTS_STREAM_EVENT, startEvent);
    }

    const stream = await this.aiService.createUIMessageStream(messages, sessionId);

    pipeUIMessageStreamToResponse({
      response,
      stream,
    });
  }
}
