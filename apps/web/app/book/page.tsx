"use client";

import { useEffect, useMemo, useState } from "react";
import { ChatPage } from "../home/components/ChatPage";
import styles from "./page.module.css";

type BookItem = {
  id: number;
  bookName: string;
  bookNamePinyin: string;
  milvusCollection: string;
  originalFileName: string;
  createdAt: string;
};

type SaveBookResponse = {
  ok: boolean;
  bookId: number;
};

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001").replace(
  /\/$/,
  "",
);

export default function BookPage() {
  const [books, setBooks] = useState<BookItem[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState("");

  async function loadBooks(preferredBookId?: string) {
    setLoading(true);
    setError("");
    const response = await fetch(`${API_BASE_URL}/book/list`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Failed to load books: ${response.status}`);
    }
    const data = (await response.json()) as BookItem[];
    setBooks(data);

    if (data.length === 0) {
      setSelectedBookId("");
      return;
    }

    if (preferredBookId && data.some((item) => String(item.id) === preferredBookId)) {
      setSelectedBookId(preferredBookId);
      return;
    }

    if (selectedBookId && data.some((item) => String(item.id) === selectedBookId)) {
      return;
    }

    setSelectedBookId(String(data[0].id));
  }

  useEffect(() => {
    let cancelled = false;
    loadBooks().catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshBooks(preferredBookId?: string) {
    try {
      await loadBooks(preferredBookId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function resetUploadModal() {
    setUploadFile(null);
    setUploadError("");
    setUploadProgress(0);
    setUploading(false);
  }

  function openUploadModal() {
    resetUploadModal();
    setShowUploadModal(true);
  }

  function closeUploadModal() {
    if (uploading) return;
    setShowUploadModal(false);
    resetUploadModal();
  }

  async function handleConfirmUpload() {
    if (!uploadFile) {
      setUploadError("请选择一个书籍文件。");
      return;
    }

    setUploading(true);
    setUploadError("");
    setUploadProgress(0);

    const formData = new FormData();
    formData.append("file", uploadFile);

    try {
      setUploadProgress(20);
      const response = await fetch(`${API_BASE_URL}/book/save`, {
        method: "POST",
        body: formData,
      });
      setUploadProgress(80);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `上传失败，状态码 ${response.status}`);
      }

      let result: SaveBookResponse;
      try {
        result = (await response.json()) as SaveBookResponse;
      } catch {
        throw new Error("上传成功但响应解析失败。");
      }

      setUploadProgress(100);
      await refreshBooks(String(result.bookId));
      setShowUploadModal(false);
      resetUploadModal();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  const selectedBook = useMemo(
    () => books.find((item) => String(item.id) === selectedBookId),
    [books, selectedBookId],
  );

  return (
    <main className={styles.page}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>已保存书籍</div>
        {loading ? <div className={styles.tip}>加载中...</div> : null}
        {error ? <div className={styles.error}>{error}</div> : null}
        {!loading && !error && books.length === 0 ? (
          <div className={styles.tip}>当前没有书籍，请先上传。</div>
        ) : null}

        <div className={styles.bookList}>
          {books.map((book) => {
            const active = String(book.id) === selectedBookId;
            return (
              <button
                key={book.id}
                className={`${styles.bookItem} ${active ? styles.bookItemActive : ""}`}
                onClick={() => setSelectedBookId(String(book.id))}
                type="button"
              >
                <div className={styles.bookTitle}>{book.bookName}</div>
                <div className={styles.bookMeta}>{book.bookNamePinyin}</div>
              </button>
            );
          })}
        </div>

        <div className={styles.sidebarFooter}>
          <button type="button" className={styles.uploadBtn} onClick={openUploadModal}>
            上传书籍
          </button>
        </div>
      </aside>

      <section className={styles.chatArea}>
        <ChatPage
          embedded
          title={selectedBook ? `书籍问答：${selectedBook.bookName}` : "书籍问答"}
          subtitle={selectedBook ? `当前书籍：${selectedBook.bookNamePinyin}` : "请先在左侧选择一本书"}
          streamPath="/book/read"
          memoryScope={selectedBookId ? `book-${selectedBookId}` : "book-default"}
          hintText="文本直问：/book/read（Data Stream Protocol）；语音链路：/speech/asr + /speech/tts/ws"
          getExtraStreamParams={() => ({ bookId: selectedBookId })}
          validateBeforeAsk={() => (selectedBookId ? null : "请先选择左侧书籍")}
        />
      </section>

      {showUploadModal ? (
        <div className={styles.modalMask} role="presentation" onClick={closeUploadModal}>
          <section
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-label="上传书籍"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className={styles.modalTitle}>上传书籍</h2>
            <input
              className={styles.fileInput}
              type="file"
              accept=".epub,application/epub+zip,.txt,text/plain,.pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
              disabled={uploading}
            />
            {uploadFile ? <div className={styles.fileName}>已选择：{uploadFile.name}</div> : null}

            {uploading ? (
              <div className={styles.progressWrap}>
                <div className={styles.progressBar}>
                  <div className={styles.progressValue} style={{ width: `${uploadProgress}%` }} />
                </div>
                <div className={styles.progressText}>保存中 {uploadProgress}%</div>
              </div>
            ) : null}

            {uploadError ? <div className={styles.error}>{uploadError}</div> : null}

            <div className={styles.modalActions}>
              <button type="button" className={styles.btnGhost} onClick={closeUploadModal} disabled={uploading}>
                取消
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={handleConfirmUpload}
                disabled={uploading || !uploadFile}
              >
                确定保存
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
