import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BookController } from './book.controller';
import { BookService } from './book.service';
import { Book } from './entities/book.entities';

@Module({
  imports: [TypeOrmModule.forFeature([Book])],
  controllers: [BookController],
  providers: [
    BookService,
    {
      provide: 'BOOK_CHAT_MODEL',
      useFactory: (configService: ConfigService) => {
        return new ChatOpenAI({
          model: configService.get<string>('MODEL_NAME'),
          apiKey: configService.get<string>('OPENAI_API_KEY'),
          configuration: {
            baseURL: configService.get<string>('OPENAI_BASE_URL'),
          },
        });
      },
      inject: [ConfigService],
    },
    {
      provide: 'BOOK_EMBEDDINGS_MODEL',
      useFactory: (configService: ConfigService) => {
        return new OpenAIEmbeddings({
          model: configService.get<string>('EMBEDDINGS_MODEL_NAME'),
          apiKey: configService.get<string>('OPENAI_API_KEY'),
          configuration: {
            baseURL: configService.get<string>('OPENAI_BASE_URL'),
          },
          dimensions: Number(configService.get<string>('EMBEDDINGS_DIM') ?? 1024),
        });
      },
      inject: [ConfigService],
    },
  ],
})
export class BookModule {}
