import { Module } from "@nestjs/common";
import { MailerModule } from "@nestjs-modules/mailer";
import { ConfigService } from "@nestjs/config";
import { LlmService } from "./llm.service";
import { SendMailToolService } from "./send-mail-tool.service";
import { WebSearchToolService } from "./web-search-tool.service";
import { TimeNowToolService } from "./time-now-tool.service";

@Module({
  imports: [
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        transport: {
          host: configService.get<string>("MAIL_HOST"),
          port: Number(configService.get<string>("MAIL_PORT")),
          secure: configService.get<string>("MAIL_SECURE") === "true",
          auth: {
            user: configService.get<string>("MAIL_USER"),
            pass: configService.get<string>("MAIL_PASS"),
          },
        },
        defaults: {
          from: configService.get<string>("MAIL_FROM"),
        },
      }),
    }),
  ],
  providers: [
    LlmService,
    SendMailToolService,
    WebSearchToolService,
    TimeNowToolService,
    {
      provide: "CHAT_MODEL",
      useFactory: (llmService: LlmService) => llmService.getModel(),
      inject: [LlmService],
    },
    {
      provide: "SEND_MAIL_TOOL",
      useFactory: (svc: SendMailToolService) => svc.tool,
      inject: [SendMailToolService],
    },
    {
      provide: "WEB_SEARCH_TOOL",
      useFactory: (svc: WebSearchToolService) => svc.tool,
      inject: [WebSearchToolService],
    },
    {
      provide: "TIME_NOW_TOOL",
      useFactory: (svc: TimeNowToolService) => svc.tool,
      inject: [TimeNowToolService],
    },
  ],
  exports: ["CHAT_MODEL", "SEND_MAIL_TOOL", "WEB_SEARCH_TOOL", "TIME_NOW_TOOL"],
})
export class ToolModule {}
