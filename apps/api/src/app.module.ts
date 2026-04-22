import { Module } from "@nestjs/common";
import { join } from "node:path";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AiModule } from "./ai/ai.module";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ControllerService } from "./controller/controller.service";
import { SpeechModule } from "./speech/speech.module";
import { ServeStaticModule } from "@nestjs/serve-static";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BookModule } from "./book/book.module";
import { Book } from "./book/entities/book.entities";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env"],
    }),
    AiModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: "mysql" as const,
        host: configService.get<string>("DB_HOST") ?? "localhost",
        port: Number(configService.get<string>("DB_PORT") ?? 3306),
        username: configService.get<string>("DB_USER") ?? "root",
        password: configService.get<string>("DB_PASS") ?? "admin",
        database: configService.get<string>("DB_NAME") ?? "hello",
        synchronize:
          (configService.get<string>("DB_SYNCHRONIZE") ?? "true") === "true",
        logging: (configService.get<string>("DB_LOGGING") ?? "true") === "true",
        connectorPackage: "mysql2",
        entities: [Book],
        extra: {
          // Prevent requests from waiting forever when DB or pool is unhealthy.
          connectTimeout: Number(
            configService.get<string>("DB_CONNECT_TIMEOUT_MS") ?? 10000,
          ),
          acquireTimeout: Number(
            configService.get<string>("DB_ACQUIRE_TIMEOUT_MS") ?? 10000,
          ),
          enableKeepAlive: true,
          keepAliveInitialDelay: 10000,
        },
      }),
    }),
    EventEmitterModule.forRoot({
      maxListeners: 200,
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), "public"),
    }),
    SpeechModule,
    BookModule,
  ],
  controllers: [AppController],
  providers: [AppService, ControllerService],
})
export class AppModule {}
