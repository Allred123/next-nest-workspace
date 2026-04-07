import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

@Injectable()
export class WebSearchToolService {
  readonly tool;

  constructor(private readonly configService: ConfigService) {
    const webSearchArgsSchema = z.object({
      query: z.string().min(1).describe('搜索关键词，例如公司年报、新闻事件'),
      count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('返回结果数量，默认为 10'),
    });

    this.tool = tool(
      async ({ query, count }: { query: string; count?: number }) => {
        const apiKey = this.configService.get<string>('BOCHA_API_KEY');
        if (!apiKey) {
          return '未配置 BOCHA_API_KEY，无法调用 Bocha Web Search API。';
        }

        const response = await fetch('https://api.bochaai.com/v1/web-search', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query,
            freshness: 'noLimit',
            summary: true,
            count: count ?? 10,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return `搜索 API 请求失败，状态码: ${response.status}，错误信息: ${errorText}`;
        }

        let json: any;
        try {
          json = await response.json();
        } catch (e) {
          return `搜索 API 响应解析失败: ${(e as Error).message}`;
        }

        if (json.code !== 200 || !json.data) {
          return `搜索 API 请求失败: ${json.msg ?? '未知错误'}`;
        }

        const webpages = json.data.webPages?.value ?? [];
        if (!webpages.length) {
          return '未找到相关结果。';
        }

        return webpages
          .map(
            (page: any, idx: number) =>
              [
                `引用: ${idx + 1}`,
                `标题: ${page.name ?? ''}`,
                `URL: ${page.url ?? ''}`,
                `摘要: ${page.summary ?? ''}`,
                `网站名称: ${page.siteName ?? ''}`,
                `网站图标: ${page.siteIcon ?? ''}`,
                `发布时间: ${page.dateLastCrawled ?? ''}`,
              ].join('\n'),
          )
          .join('\n\n');
      },
      {
        name: 'web_search',
        description:
          '使用 Bocha Web Search API 搜索互联网网页，返回标题、URL、摘要、网站信息和时间。',
        schema: webSearchArgsSchema,
      },
    );
  }
}
