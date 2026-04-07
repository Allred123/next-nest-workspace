import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MailerService } from "@nestjs-modules/mailer";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

@Injectable()
export class SendMailToolService {
  readonly tool;

  constructor(
    private readonly mailerService: MailerService,
    private readonly configService: ConfigService,
  ) {
    const sendMailArgsSchema = z.object({
      to: z.string().email().describe("收件人邮箱地址，例如 someone@example.com"),
      subject: z.string().describe("邮件主题"),
      text: z.string().optional().describe("纯文本内容，可选"),
      html: z.string().optional().describe("HTML 内容，可选"),
    });

    this.tool = tool(
      async ({
        to,
        subject,
        text,
        html,
      }: {
        to: string;
        subject: string;
        text?: string;
        html?: string;
      }) => {
        const fallbackFrom = this.configService.get<string>("MAIL_FROM");

        await this.mailerService.sendMail({
          to,
          subject,
          text: text ?? "（无文本内容）",
          html: html ?? `<p>${text ?? "（无 HTML 内容）"}</p>`,
          from: fallbackFrom,
        });

        return `邮件已发送到 ${to}，主题为「${subject}」。`;
      },
      {
        name: "send_mail",
        description:
          "发送电子邮件。需要提供收件人邮箱和主题，可选提供 text 或 html 内容。",
        schema: sendMailArgsSchema,
      },
    );
  }
}
