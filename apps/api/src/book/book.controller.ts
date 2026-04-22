import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Res,
  Sse,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Express, Response } from 'express';
import { from, map, Observable } from 'rxjs';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createUIMessageStream, pipeUIMessageStreamToResponse } from 'ai';
import type { UIMessage } from 'ai';
import { AI_TTS_STREAM_EVENT, type AiTtsStreamEvent } from '../common/stream-events';
import { BookService } from './book.service';

@Controller('book')
export class BookController {
  constructor(
    private readonly bookService: BookService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Get('list')
  async listBooks() {
    return this.bookService.listBooks();
  }

  @Post('save')
  @UseInterceptors(FileInterceptor('file'))
  async saveBook(
    @UploadedFile() file?: Express.Multer.File,
    @Body('bookName') bookName?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('请通过 multipart 字段 "file" 上传书籍文件。');
    }
    return this.bookService.saveBook({
      file,
      bookName,
    });
  }

  @Sse('read/stream')
  readStream(
    @Query('query') query: string,
    @Query('bookId') bookId?: string,
    @Query('bookName') bookName?: string,
    @Query('k') k?: string,
    @Query('ttsSessionId') ttsSessionId?: string,
  ): Observable<{ data: string }> {
    const sessionId = ttsSessionId?.trim();
    if (sessionId) {
      const startEvent: AiTtsStreamEvent = { type: 'start', sessionId, query };
      this.eventEmitter.emit(AI_TTS_STREAM_EVENT, startEvent);
    }

    const topK = Number(k ?? 5);
    return from(
      this.bookService.streamRead({
        query,
        bookId,
        bookName,
        k: Number.isFinite(topK) && topK > 0 ? topK : 5,
        ttsSessionId: sessionId,
      }),
    ).pipe(map((chunk) => ({ data: chunk })));
  }

  @Post('read')
  async read(
    @Body()
    body: {
      messages?: UIMessage[];
      bookId?: string;
      bookName?: string;
      k?: number | string;
      ttsSessionId?: string;
    },
    @Res() response: Response,
  ): Promise<void> {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sessionId = body.ttsSessionId?.trim();
    const query = this.extractLastUserText(messages);

    if (sessionId) {
      const startEvent: AiTtsStreamEvent = { type: 'start', sessionId, query };
      this.eventEmitter.emit(AI_TTS_STREAM_EVENT, startEvent);
    }

    const topK = Number(body.k ?? 5);
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: 'start-step' });
        writer.write({ type: 'text-start', id: 'text-1' });

        for await (const chunk of this.bookService.streamRead({
          query,
          bookId: body.bookId,
          bookName: body.bookName,
          k: Number.isFinite(topK) && topK > 0 ? topK : 5,
          ttsSessionId: sessionId,
        })) {
          writer.write({ type: 'text-delta', id: 'text-1', delta: chunk });
        }

        writer.write({ type: 'text-end', id: 'text-1' });
        writer.write({ type: 'finish-step' });
      },
    });

    pipeUIMessageStreamToResponse({ response, stream });
  }

  private extractLastUserText(messages: UIMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'user') continue;
      const text = message.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim();
      if (text) return text;
    }
    return '';
  }
}
