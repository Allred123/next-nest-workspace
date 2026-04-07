import type { RefObject } from "react";
import styles from "../home.module.css";

type ComposerProps = {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  onRecordToggle: () => Promise<void>;
  onSpeechToggle: () => void;
  sendDisabled: boolean;
  isRecording: boolean;
  speechEnabled: boolean;
  audioRef: RefObject<HTMLAudioElement | null>;
  onAudioPause: () => void;
  onAudioPlay: () => void;
  hintText?: string;
};

export function Composer({
  prompt,
  onPromptChange,
  onSubmit,
  onRecordToggle,
  onSpeechToggle,
  sendDisabled,
  isRecording,
  speechEnabled,
  audioRef,
  onAudioPause,
  onAudioPlay,
  hintText = "文本直问：/ai/chat/stream；语音链路：/speech/asr -> /ai/chat/stream；语音合成：/speech/tts/ws",
}: ComposerProps) {
  return (
    <footer className={styles.composer}>
      <div className={styles.toolbar}>
        <div className={styles.inputWrap}>
          <textarea
            className={styles.promptInput}
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder="输入问题，回车发送（Shift+Enter 换行）；也可以用语音按钮说话"
            onKeyDown={async (event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                await onSubmit();
              }
            }}
          />
        </div>
        <button
          className={`${styles.btn} ${styles.btnVoice} ${isRecording ? styles.btnPrimary : ""}`}
          onClick={onRecordToggle}
          disabled={!speechEnabled}
        >
          {isRecording ? "停止录音" : "语音输入"}
        </button>
        <button className={`${styles.btn} ${speechEnabled ? styles.btnPrimary : ""}`} onClick={onSpeechToggle}>
          {speechEnabled ? "语音已开" : "语音已关"}
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={sendDisabled} onClick={onSubmit}>
          发送
        </button>
      </div>
      <div className={styles.hint}>{hintText}</div>
      <div className={styles.audioBar}>
        <span>AI 语音播放</span>
        <audio ref={audioRef} controls preload="none" onPause={onAudioPause} onPlay={onAudioPlay} />
      </div>
    </footer>
  );
}
