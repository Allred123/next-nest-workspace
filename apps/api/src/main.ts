import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { WebSocketServer } from "ws";
import { lookup } from "node:dns/promises";
import { TtsRelayService } from "./speech/tts-relay.service";

function extractHostFromMilvusAddress(raw?: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  // Accept both "host:port" and "https://host:port" styles.
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).hostname;
    } catch {
      return undefined;
    }
  }
  return value.split(":")[0]?.trim() || undefined;
}

async function bootstrap() {
  const milvusHost = extractHostFromMilvusAddress(process.env.MILVUS_ADDRESS);
  if (milvusHost) {
    try {
      const dnsResult = await lookup(milvusHost);
      console.log("[DNS_CHECK_OK]", milvusHost, dnsResult.address);
    } catch (error) {
      console.error("[DNS_CHECK_FAIL]", milvusHost, error);
    }
  } else {
    console.warn("[DNS_CHECK_SKIP] MILVUS_ADDRESS is empty or invalid");
  }

  const app = await NestFactory.create(AppModule);

  const ttsRelayService = app.get(TtsRelayService);
  const server = app.getHttpServer();

  const ttsWss = new WebSocketServer({
    server,
    path: "/speech/tts/ws",
  });

  ttsWss.on("connection", (socket, request) => {
    const reqUrl = new URL(request.url ?? "", "http://localhost");
    const wantedSessionId = reqUrl.searchParams.get("sessionId") ?? undefined;
    const sessionId = ttsRelayService.registerClient(socket, wantedSessionId);

    socket.on("close", () => {
      ttsRelayService.unregisterClient(sessionId);
    });
  });

  const allowedOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowAllOrigins = allowedOrigins.includes("*");

  app.enableCors({
    credentials: true,
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || allowAllOrigins || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`), false);
    },
  });

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`Nest API listening on http://localhost:${port}`);
}

bootstrap();
