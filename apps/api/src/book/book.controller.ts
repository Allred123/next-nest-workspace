import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Sse,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Express } from 'express';
import { from, map, Observable } from 'rxjs';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
      throw new BadRequestException('Please upload book file in multipart field "file".');
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
}
