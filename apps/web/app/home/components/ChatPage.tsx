"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import styles from "../home.module.css";
import type { ChatMessage } from "./types";

const MEMORY_WINDOW_SIZE = 10;
const MEMORY_ITEM_MAX_CHARS = 300;
const MEMORY_TOTAL_MAX_CHARS = 2000;

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(
  /\/$/,
  "",
);
const API_WS_BASE_URL = (
  process.env.NEXT_PUBLIC_API_WS_BASE_URL ?? API_BASE_URL.replace(/^http/i, "ws")
).replace(/\/$/, ""); 

function nowTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type StoredMessage = Pick<ChatMessage, "role" | "content" | "meta">;

type StoredMemoryPayload = {
  sessionId: string;
  messages: StoredMessage[];
};

type ChatPageProps = {
  embedded?: boolean;
  title?: string;
  subtitle?: string;
  streamPath?: string;
  memoryScope?: string;
  hintText?: string;
  getExtraStreamParams?: () => Record<string, string | undefined>;
  validateBeforeAsk?: () => string | null;
};

export function ChatPage({
  embedded = false,
  title,
  subtitle,
  streamPath = "/ai/chat/stream",
  memoryScope = "home",
  hintText,
  getExtraStreamParams,
  validateBeforeAsk,
}: ChatPageProps = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [statusText, setStatusText] = useState("未开始");
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [sendDisabled, setSendDisabled] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const memorySessionIdRef = useRef<string>(uid());

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const activeStreamRef = useRef<EventSource | null>(null);

  const ttsWsRef = useRef<WebSocket | null>(null);
  const ttsSessionIdRef = useRef<string | null>(null);
  const ttsMediaSourceRef = useRef<MediaSource | null>(null);
  const ttsSourceBufferRef = useRef<SourceBuffer | null>(null);
  const ttsPendingBuffersRef = useRef<ArrayBuffer[]>([]);
  const ttsStreamFinalRef = useRef(false);
  const ttsObjectUrlRef = useRef<string | null>(null);
  const ttsUserPausedRef = useRef(false);

  const status = useMemo(
    () => ({
      set: (text: string, typing = false) => {
        setStatusText(text);
        setIsTyping(typing);
      },
    }),
    [],
  );

  useEffect(() => {
    const el = document.getElementById("messages");
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    return () => {
      closeActiveStream();
      closeTtsWs();
      stopRecordingTracks();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const storageKey = `chat-memory:${memoryScope}`;
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      memorySessionIdRef.current = uid();
      setMessages([]);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as StoredMemoryPayload;
      memorySessionIdRef.current = parsed.sessionId?.trim() || uid();
      const restored = (parsed.messages ?? []).map((item) => ({
        id: uid(),
        role: item.role,
        content: item.content,
        meta: item.meta,
      }));
      setMessages(restored);
    } catch {
      memorySessionIdRef.current = uid();
      setMessages([]);
    }
  }, [memoryScope]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storageKey = `chat-memory:${memoryScope}`;
    const payload: StoredMemoryPayload = {
      sessionId: memorySessionIdRef.current,
      messages: messages.map((item) => ({
        role: item.role,
        content: item.content,
        meta: item.meta,
      })),
    };
    window.localStorage.setItem(storageKey, JSON.stringify(payload));
  }, [messages, memoryScope]);

  function appendMessage(role: "user" | "assistant", content: string, meta: string) {
    const message: ChatMessage = {
      id: uid(),
      role,
      content,
      meta,
    };
    setMessages((prev) => [...prev, message]);
    return message.id;
  }

  function updateMessage(id: string, updates: Partial<ChatMessage>) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...updates } : m)));
  }

  function buildPromptWithRecentWindow(query: string) {
    const recent = messages.slice(-MEMORY_WINDOW_SIZE);
    if (recent.length === 0) {
      return query;
    }

    const lines: string[] = [];
    let totalChars = 0;

    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const item = recent[i];
      const content = item.content.replace(/\s+/g, " ").trim();
      if (!content) continue;
      const clipped = content.slice(0, MEMORY_ITEM_MAX_CHARS);
      const line = `${item.role === "user" ? "用户" : "助手"}: ${clipped}`;
      if (totalChars + line.length > MEMORY_TOTAL_MAX_CHARS) {
        break;
      }
      lines.push(line);
      totalChars += line.length;
    }

    if (lines.length === 0) {
      return query;
    }

    const orderedLines = lines.reverse().join("\n");
    return [
      "请基于以下最近对话继续回答：",
      orderedLines,
      "",
      `当前问题：${query}`,
      "请直接回答当前问题。",
    ].join("\n");
  }

  function closeActiveStream() {
    if (activeStreamRef.current) {
      activeStreamRef.current.close();
      activeStreamRef.current = null;
    }
  }

  function stopRecordingTracks() {
    if (recordingStreamRef.current) {
      recordingStreamRef.current.getTracks().forEach((track) => track.stop());
      recordingStreamRef.current = null;
    }
  }

  function resetTtsPlayer() {
    ttsPendingBuffersRef.current = [];
    ttsStreamFinalRef.current = false;
    ttsSourceBufferRef.current = null;
    ttsMediaSourceRef.current = null;
    ttsUserPausedRef.current = false;

    if (ttsObjectUrlRef.current) {
      URL.revokeObjectURL(ttsObjectUrlRef.current);
      ttsObjectUrlRef.current = null;
    }

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
  }

  function closeTtsWs() {
    if (ttsWsRef.current) {
      ttsWsRef.current.close();
      ttsWsRef.current = null;
    }
    ttsSessionIdRef.current = null;
    resetTtsPlayer();
  }

  function flushTtsBufferQueue() {
    const sourceBuffer = ttsSourceBufferRef.current;
    const mediaSource = ttsMediaSourceRef.current;
    const audioEl = audioRef.current;

    if (!sourceBuffer || !mediaSource) return;
    if (sourceBuffer.updating) return;

    if (ttsPendingBuffersRef.current.length > 0) {
      const next = ttsPendingBuffersRef.current.shift();
      if (next) {
        sourceBuffer.appendBuffer(next);
        if (audioEl && !ttsUserPausedRef.current) {
          audioEl
            .play()
            .then(() => {})
            .catch(() => {
              // Browser autoplay policy may block playback.
            });
        }
      }
      return;
    }

    if (ttsStreamFinalRef.current && mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch {
        // ignore
      }
    }
  }

  function prepareStreamingAudio() {
    resetTtsPlayer();

    if (typeof window === "undefined") return;
    if (!window.MediaSource || !MediaSource.isTypeSupported("audio/mpeg")) {
      return;
    }

    const mediaSource = new MediaSource();
    ttsMediaSourceRef.current = mediaSource;

    const objectUrl = URL.createObjectURL(mediaSource);
    ttsObjectUrlRef.current = objectUrl;

    if (audioRef.current) {
      audioRef.current.src = objectUrl;
    }

    mediaSource.addEventListener("sourceopen", () => {
      if (!ttsMediaSourceRef.current) return;

      const sourceBuffer = ttsMediaSourceRef.current.addSourceBuffer("audio/mpeg");
      sourceBuffer.mode = "sequence";
      sourceBuffer.addEventListener("updateend", flushTtsBufferQueue);
      ttsSourceBufferRef.current = sourceBuffer;
      flushTtsBufferQueue();
    });
  }

  async function uploadAndRecognize(blob: Blob) {
    const formData = new FormData();
    formData.append("audio", blob, "record.ogg");

    const response = await fetch(`${API_BASE_URL}/speech/asr`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "ASR 请求失败");
    }

    const data = (await response.json()) as { text?: string };
    return data.text ?? "";
  }

  async function ensureTtsConnection() {
    if (ttsWsRef.current?.readyState === WebSocket.OPEN && ttsSessionIdRef.current) {
      return;
    }

    await new Promise<void>((resolve) => {
      const wsUrl = `${API_WS_BASE_URL}/speech/tts/ws`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      ttsWsRef.current = ws;

      const timeout = window.setTimeout(() => {
        resolve();
      }, 5000);

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as {
              type?: string;
              sessionId?: string;
            };

            if (msg.type === "session" && msg.sessionId) {
              ttsSessionIdRef.current = msg.sessionId;
              window.clearTimeout(timeout);
              resolve();
              return;
            }

            if (msg.type === "tts_started") {
              prepareStreamingAudio();
              return;
            }

            if (msg.type === "tts_final" || msg.type === "tts_closed" || msg.type === "tts_error") {
              ttsStreamFinalRef.current = true;
              flushTtsBufferQueue();
            }
          } catch {
            // ignore
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          ttsPendingBuffersRef.current.push(event.data);
          flushTtsBufferQueue();
        }
      };

      ws.onerror = () => {
        window.clearTimeout(timeout);
        closeTtsWs();
        resolve();
      };

      ws.onclose = () => {
        ttsWsRef.current = null;
      };
    });
  }

  async function streamAiReply(query: string) {
    closeActiveStream();

    const assistantMessageId = appendMessage("assistant", "", "AI 正在回答...");
    const params = new URLSearchParams();
    params.set("query", query);
    params.set("sessionId", memorySessionIdRef.current);
    if (ttsSessionIdRef.current) {
      params.set("ttsSessionId", ttsSessionIdRef.current);
    }
    const extraParams = getExtraStreamParams?.() ?? {};
    for (const [key, value] of Object.entries(extraParams)) {
      if (value) {
        params.set(key, value);
      }
    }
    const url = `${API_BASE_URL}${streamPath}?${params.toString()}`;

    await new Promise<string>((resolve) => {
      const es = new EventSource(url);
      activeStreamRef.current = es;
      let aiResult = "";

      es.onmessage = (event) => {
        aiResult += event.data || "";
        updateMessage(assistantMessageId, { content: aiResult || "(空结果)" });
      };

      es.onerror = () => {
        es.close();
        if (activeStreamRef.current === es) {
          activeStreamRef.current = null;
        }
        updateMessage(assistantMessageId, { meta: `AI 回复完成 ${nowTime()}` });
        resolve(aiResult);
      };
    });
  }

  async function askWithQuery(query: string, source: string) {
    const validationMessage = validateBeforeAsk?.();
    if (validationMessage) {
      status.set(validationMessage);
      return;
    }

    const trimmed = query.trim();
    if (!trimmed) {
      status.set("请输入问题");
      return;
    }

    appendMessage("user", trimmed, `${source} ${nowTime()}`);
    setPrompt("");
    setSendDisabled(true);
    status.set("AI 正在流式回答...", true);

    try {
      const queryWithMemory = buildPromptWithRecentWindow(trimmed);
      if (speechEnabled) {
        await ensureTtsConnection();
      } else {
        closeTtsWs();
      }
      await streamAiReply(queryWithMemory);
      status.set("对话完成");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendMessage("assistant", `处理失败：${detail}`, `异常 ${nowTime()}`);
      status.set("处理失败");
    } finally {
      setSendDisabled(false);
    }
  }

  async function handleSend() {
    await askWithQuery(prompt, "文字提问");
  }

  async function handleRecordToggle() {
    if (!speechEnabled) {
      status.set("语音已关闭，请先开启语音");
      return;
    }

    if (isRecording) {
      mediaRecorderRef.current?.stop();
      status.set("已停止录音，正在识别...");
      return;
    }

    try {
      closeActiveStream();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStreamRef.current = stream;
      chunksRef.current = [];

      const preferredMimeType = "audio/ogg;codecs=opus";
      const recorder = MediaRecorder.isTypeSupported(preferredMimeType)
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || "audio/webm",
          });

          if (!blob.size) {
            throw new Error("录音数据为空，请至少录制 1 秒再上传");
          }

          status.set("语音识别中...");
          const recognized = (await uploadAndRecognize(blob)).trim();
          setPrompt(recognized);

          if (!recognized) {
            status.set("识别为空，请重新录音");
            return;
          }

          await askWithQuery(recognized, "语音提问");
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          appendMessage("assistant", `语音处理失败：${detail}`, `异常 ${nowTime()}`);
          status.set("语音处理失败");
        } finally {
          stopRecordingTracks();
          setIsRecording(false);
        }
      };

      recorder.start(250);
      setIsRecording(true);
      status.set("录音中，点击“停止录音”完成提问");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendMessage("assistant", `无法开始录音：${detail}`, `异常 ${nowTime()}`);
      status.set("无法开始录音");
      setIsRecording(false);
      stopRecordingTracks();
    }
  }

  function handleAudioPause() {
    if (!ttsStreamFinalRef.current) {
      ttsUserPausedRef.current = true;
    }
  }

  function handleAudioPlay() {
    ttsUserPausedRef.current = false;
  }

  function handleSpeechToggle() {
    setSpeechEnabled((prev) => {
      const next = !prev;
      if (!next) {
        if (isRecording) {
          mediaRecorderRef.current?.stop();
        }
        closeTtsWs();
        status.set("语音已关闭");
      } else {
        status.set("语音已开启");
      }
      return next;
    });
  }

  const chatShell = (
    <section className={styles.chatShell}>
      <ChatHeader
        statusText={statusText}
        isTyping={isTyping}
        title={title}
        subtitle={subtitle}
      />
      <MessageList messages={messages} />
      <Composer
        prompt={prompt}
        onPromptChange={setPrompt}
        onSubmit={handleSend}
        onRecordToggle={handleRecordToggle}
        onSpeechToggle={handleSpeechToggle}
        sendDisabled={sendDisabled}
        isRecording={isRecording}
        speechEnabled={speechEnabled}
        audioRef={audioRef}
        onAudioPause={handleAudioPause}
        onAudioPlay={handleAudioPlay}
        hintText={hintText}
      />
    </section>
  );

  if (embedded) {
    return chatShell;
  }

  return (
    <main className={styles.page}>
      {chatShell}
    </main>
  );
}
