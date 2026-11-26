import { getDueFlashcards, mergeFlashcardReviewState, parseFlashcards, type FlashcardReviewState } from "../flashcards.ts";
import { Keji, type NoteRecord, type NoteSummary } from "../keji.ts";
import { clearLessonOpfsCache } from "../lesson-cache.ts";
import { extractNoteSummaryPreview, noteExcerpt } from "../markdown.ts";
import { NOTE_DOCUMENT_STRUCTURES, isNoteViewKey, type NoteViewKey } from "../note-structures.ts";
import type { TemplateId } from "../keji.ts";
import { parseQuizQuestions, scoreQuizQuestions, type QuizRecordState } from "../quiz.ts";

interface DeletedNoteTombstone {
  id: string;
  deletedAt: string;
}

interface RecoveryNote {
  id: string;
  noteId: string;
  createdAt: string;
  reason: "sync" | "edit";
  viewKey?: NoteViewKey;
  note: NoteRecord;
}

const utf8Encoder = new TextEncoder();
let notesDatabasePromise: Promise<IDBDatabase> | null = null;

function openNotesDatabase(): Promise<IDBDatabase> {
  if (notesDatabasePromise) return notesDatabasePromise;
  notesDatabasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("keji-notes", 5);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("notes")) {
        const store = database.createObjectStore("notes", { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("url", "url", { unique: false });
      }
      const notesStore = request.transaction!.objectStore('notes');
      if (!notesStore.indexNames.contains('lessonKey')) {
        notesStore.createIndex('lessonKey', 'lessonKey', { unique: false });
        notesStore.openCursor().onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const note = cursor.value as NoteRecord;
          cursor.update({ ...note, lessonKey: Keji.lessonKey(note) });
          cursor.continue();
        };
      }
      if (!database.objectStoreNames.contains("recovery")) {
        const recovery = database.createObjectStore("recovery", { keyPath: "id" });
        recovery.createIndex("noteId", "noteId", { unique: false });
      }
      if (!database.objectStoreNames.contains("summaries")) {
        database.createObjectStore("summaries", { keyPath: "id" });
        if (database.objectStoreNames.contains("notes")) {
          const notes = request.transaction!.objectStore("notes");
          const summaries = request.transaction!.objectStore("summaries");
          notes.openCursor().onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) return;
            summaries.put(summaryRecord(cursor.value as NoteRecord));
            cursor.continue();
          };
        }
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        notesDatabasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error("无法打开本机笔记数据库。"));
    request.onblocked = () => reject(new Error("本机笔记数据库升级被其他窗口阻止，请关闭其他课记窗口后重试。"));
  }).catch((error) => {
    notesDatabasePromise = null;
    throw error;
  });
  return notesDatabasePromise;
}

function saveRecoverySnapshot(store: IDBObjectStore, note: NoteRecord, reason: RecoveryNote['reason'], viewKey?: NoteViewKey): void {
  const index = store.index("noteId");
  const request = index.getAll(note.id);
  request.onsuccess = () => {
    const current = (request.result as RecoveryNote[])
      .filter((item) => item.reason === reason && item.viewKey === viewKey)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (current[0] && JSON.stringify(current[0].note) === JSON.stringify(note)) return;
    store.put({ id: crypto.randomUUID(), noteId: note.id, createdAt: new Date().toISOString(), reason, viewKey, note } satisfies RecoveryNote);
    for (const old of current.slice(2)) store.delete(old.id);
  };
}

export async function listRecoveryNotes(): Promise<Array<Omit<RecoveryNote, 'note'> & { title: string }>> {
  const database = await openNotesDatabase();
  const tx = database.transaction('recovery', 'readonly');
  const completed = transactionCompletion(tx);
  const rows = await requestValue(tx.objectStore('recovery').getAll()) as RecoveryNote[];
  await completed;
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(({ note, ...meta }) => ({ ...meta, title: note.title || note.part || note.id }));
}

export async function restoreRecoveryNote(id: string): Promise<NoteRecord> {
  const database = await openNotesDatabase();
  const tx = database.transaction(['notes', 'recovery', 'summaries'], 'readwrite');
  const completed = transactionCompletion(tx);
  const source = await requestValue(tx.objectStore('recovery').get(id)) as RecoveryNote | undefined;
  if (!source) { tx.abort(); await completed.catch(() => {}); throw new Error('恢复副本不存在。'); }
  const notes = tx.objectStore('notes');
  const current = await requestValue(notes.get(source.noteId)) as NoteRecord | undefined;
  if (current) saveRecoverySnapshot(tx.objectStore('recovery'), current, 'edit', source.viewKey);
  const restored = source.reason === 'edit' && source.viewKey && current
    ? {
        ...current,
        views: { ...current.views, [source.viewKey]: source.note.views?.[source.viewKey] || '' },
        markdown: current.template === source.viewKey ? (source.note.views?.[source.viewKey] || '') : current.markdown,
        updatedAt: new Date().toISOString()
      }
    : { ...source.note, updatedAt: new Date().toISOString() };
  notes.put(restored);
  tx.objectStore('summaries').put(summaryRecord(restored));
  await completed;
  await clearDeletedNoteTombstone(restored.id);
  return restored;
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("本机笔记数据库事务已取消。"));
    transaction.onerror = () => reject(transaction.error || new Error("本机笔记数据库写入失败。"));
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("读取本机笔记失败。"));
  });
}

function quotaError(error: any): boolean {
  return error?.name === "QuotaExceededError" || /quota|storage.*full/i.test(error?.message || "");
}

function normalizeNoteDatabaseError(error: any): Error {
  return quotaError(error)
    ? new Error("浏览器本机数据库空间不足；现有笔记没有被删，请先备份并清理不再需要的笔记或截图。")
    : error;
}

export async function getAllNotes(): Promise<NoteRecord[]> {
  const database = await openNotesDatabase();
  const transaction = database.transaction("notes", "readonly");
  const completed = transactionCompletion(transaction);
  const [notes] = await Promise.all([requestValue(transaction.objectStore("notes").getAll()), completed]);
  return (notes as NoteRecord[]).sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
}

export async function deletedNoteTombstones(): Promise<DeletedNoteTombstone[]> {
  const { remoteDeletedNotes = [] } = await chrome.storage.local.get("remoteDeletedNotes");
  return Array.isArray(remoteDeletedNotes) ? remoteDeletedNotes : [];
}

async function recordDeletedNoteTombstone(id: string): Promise<void> {
  const tombstones = new Map((await deletedNoteTombstones()).map((item) => [item.id, item]));
  tombstones.set(id, { id, deletedAt: new Date().toISOString() });
  await chrome.storage.local.set({ remoteDeletedNotes: [...tombstones.values()] });
}

async function clearDeletedNoteTombstone(id: string): Promise<void> {
  const tombstones = await deletedNoteTombstones();
  if (tombstones.some((item) => item.id === id)) {
    await chrome.storage.local.set({ remoteDeletedNotes: tombstones.filter((item) => item.id !== id) });
  }
}

async function mutateNoteRecord<T>(
  id: string,
  notFoundMsg: string,
  mutate: (existing: NoteRecord, store: IDBObjectStore, recovery: IDBObjectStore) => T,
  removeSummary = false
): Promise<T> {
  try {
    const database = await openNotesDatabase();
    const transaction = database.transaction(["notes", "recovery", "summaries"], "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore("notes");
    const request = store.get(id);
    let outcome: T | undefined;
    let found = false;
    let mutationError: unknown;
    request.onsuccess = () => {
      if (!request.result) {
        transaction.abort();
        return;
      }
      found = true;
      try {
        outcome = mutate(request.result as NoteRecord, store, transaction.objectStore("recovery"));
        if (removeSummary) transaction.objectStore('summaries').delete(id);
        else transaction.objectStore('summaries').put(summaryRecord(outcome as NoteRecord));
      } catch (error) {
        mutationError = error;
        transaction.abort();
      }
    };
    try { await completed; } catch (error) { if (mutationError) throw mutationError; throw error; }
    if (!found) throw new Error(notFoundMsg);
    return outcome!;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw new Error(notFoundMsg);
    throw normalizeNoteDatabaseError(error);
  }
}

function isPlaceholderDocText(trimmed: string): boolean {
  return !trimmed || /^#\s+[^\n]+\r?\n\r?\n>\s*(?:正在生成笔记，请稍候…|生成失败：[\s\S]*)$/.test(trimmed);
}

function hasNoteDocumentContent(note: NoteRecord): boolean {
  return noteAllDocumentTexts(note).some((text) => !isPlaceholderDocText(String(text || "").trim()));
}

export function summarizeNote(note: NoteRecord): NoteSummary {
  const viewKeys: NoteViewKey[] = [];
  for (const item of NOTE_DOCUMENT_STRUCTURES) {
    const content = String(note.views?.[item.id] || "").trim();
    if (!isPlaceholderDocText(content)) viewKeys.push(item.id);
  }
  if (!viewKeys.length) {
    const legacyMd = String(note.markdown || "").trim();
    if (!isPlaceholderDocText(legacyMd)) {
      viewKeys.push(isNoteViewKey(note.template) ? note.template : "study");
    }
  }

  const quizMd = String(note.quizState?.generatedMarkdown || (note.template === "quiz" ? note.markdown : "") || "").trim();
  const quizQuestions = !isPlaceholderDocText(quizMd) ? parseQuizQuestions(quizMd) : [];
  const quizSummary = quizQuestions.length
    ? (() => {
      const score = scoreQuizQuestions(quizQuestions, note.quizState?.answers || {});
      return { total: score.total, answered: score.answered, correct: score.correct };
    })()
    : null;

  const cardMd = String(note.flashcardMarkdown || (note.template === "flashcards" ? note.markdown : "") || "").trim();
  const cardItems = !isPlaceholderDocText(cardMd) ? parseFlashcards(cardMd) : [];
  const flashcardSummary = cardItems.length
    ? {
      total: cardItems.length,
      due: getDueFlashcards(
        cardItems.map((card) => ({ ...card })),
        Array.isArray(note.flashcardReview) ? note.flashcardReview : []
      ).length
    }
    : null;

  const previewSource = String(
    note.views?.brief
    || note.views?.study
    || noteAllDocumentTexts(note).find((text) => !isPlaceholderDocText(String(text || "").trim()))
    || ""
  );

  return {
    id: note.id, title: note.title, courseTitle: note.courseTitle || note.title,
    part: note.part, url: note.url, page: note.page, pageCount: note.pageCount,
    duration: note.duration, cover: note.cover, template: note.template,
    reviewMark: note.reviewMark || "",
    personalNote: note.personalNote ? String(note.personalNote).trim().slice(0, 160) : "",
    viewKeys,
    quizSummary,
    flashcardSummary,
    summaryPreview: extractNoteSummaryPreview(previewSource),
    createdAt: note.createdAt, updatedAt: note.updatedAt, complete: note.complete,
    visualAnalysis: note.visualAnalysis, visualAnalysisMode: note.visualAnalysisMode,
    generationProgress: note.generationProgress, generationStatus: note.generationStatus,
    generationStartedAt: note.generationStartedAt, generationError: note.generationError,
    generationModel: note.generationModel, generationModels: note.generationModels,
    hasContent: hasNoteDocumentContent(note)
  };
}

interface StoredSummary extends NoteSummary {
  searchText: string;
  intermediateBytes: number;
}

function summaryRecord(note: NoteRecord): StoredSummary {
  const docs = noteAllDocumentTexts(note).map((text) => String(text || '')
    .replace(/!\[[^\]]*\]\(data:image\/[^;]+;base64,[^)]+\)/g, ' '));
  const excerptSource = docs.find((text) => text.trim()) || '';
  return {
    ...summarizeNote(note),
    intermediateBytes: noteIntermediateBytes(note),
    excerpt: noteExcerpt(excerptSource),
    searchText: [note.title, note.courseTitle, note.part, note.url, note.personalNote,
      note.transcript, ...docs, ...(note.conversation || []).map((item) => item.content)]
      .map((value) => String(value || '')).join('\n').toLocaleLowerCase()
  };
}

function noteAllDocumentTexts(note: NoteRecord): string[] {
  const viewTexts = note.views ? Object.values(note.views) : [];
  return [
    note.markdown || "",
    ...viewTexts.map((value) => value || ""),
    note.flashcardMarkdown || "",
    note.quizState?.generatedMarkdown || ""
  ];
}

export async function listNotes({ query = "", previewLimit = 0 } = {}) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  const database = await openNotesDatabase();
  const transaction = database.transaction('summaries', 'readonly');
  const completed = transactionCompletion(transaction);
  const records = await requestValue(transaction.objectStore('summaries').getAll()) as StoredSummary[];
  await completed;
  records.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''));
  const allNotes = records.map(({ searchText, intermediateBytes, ...summary }) => summary);
  const matched = needle ? records.filter((record) => record.searchText.includes(needle))
    .map(({ searchText, intermediateBytes, ...summary }) => summary) : allNotes;
  const limit = Math.max(0, Math.floor(Number(previewLimit) || 0));
  if (limit > 0) {
    return { notes: allNotes.slice(0, limit), allNotes };
  }
  return { notes: matched };
}

export async function getNoteIntermediateOverview() {
  const database = await openNotesDatabase();
  const tx = database.transaction('summaries', 'readonly');
  const completed = transactionCompletion(tx);
  const rows = await requestValue(tx.objectStore('summaries').getAll()) as StoredSummary[];
  await completed;
  return rows.filter((item) => item.intermediateBytes > 0)
    .map((item) => ({ lessonKey: Keji.lessonKey(item) || item.id, bytes: item.intermediateBytes }));
}

export async function getNote(id?: string): Promise<NoteRecord> {
  if (!id) throw new Error("笔记 ID 缺失。");
  const database = await openNotesDatabase();
  const transaction = database.transaction("notes", "readonly");
  const completed = transactionCompletion(transaction);
  const [note] = await Promise.all([requestValue<NoteRecord | undefined>(transaction.objectStore("notes").get(id)), completed]);
  if (!note) throw new Error("本机找不到这份笔记。");
  return note;
}

export async function saveNote(note: Partial<NoteRecord>): Promise<NoteRecord> {
  const lessonKey = Keji.lessonKey(note);
  const now = new Date().toISOString();
  let saved: NoteRecord | null = null;
  const removedDuplicateIds: string[] = [];
  try {
    const database = await openNotesDatabase();
    const transaction = database.transaction(["notes", "summaries"], "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore("notes");
    const createNew = () => {
      saved = { id: crypto.randomUUID(), createdAt: now, markdown: "", ...note, lessonKey } as NoteRecord;
      store.add(saved);
      transaction.objectStore('summaries').put(summaryRecord(saved));
    };
    if (lessonKey) {
      const request = store.index('lessonKey').getAll(lessonKey);
      request.onsuccess = () => {
        const matches = ((request.result || []) as NoteRecord[])
          .filter((item) => Keji.lessonKey(item) === lessonKey)
          .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt || "") || 0) - (Date.parse(a.updatedAt || a.createdAt || "") || 0));
        if (matches.length) {
          const [primary, ...duplicates] = matches;
          saved = { ...primary!, ...note, lessonKey, id: primary!.id, createdAt: primary!.createdAt || now, updatedAt: now };
          store.put(saved);
          transaction.objectStore('summaries').put(summaryRecord(saved));
          for (const duplicate of duplicates) {
            store.delete(duplicate.id);
            transaction.objectStore('summaries').delete(duplicate.id);
            removedDuplicateIds.push(duplicate.id);
          }
        } else {
          createNew();
        }
      };
    } else {
      createNew();
    }
    await completed;
    await clearDeletedNoteTombstone(saved!.id);
    for (const duplicateId of removedDuplicateIds) await recordDeletedNoteTombstone(duplicateId);
    return saved!;
  } catch (error) {
    throw normalizeNoteDatabaseError(error);
  }
}

export async function updateNote(note: Partial<NoteRecord>): Promise<NoteRecord> {
  if (!note?.id) throw new Error("笔记 ID 缺失，无法保存会话。");
  const updated = await mutateNoteRecord<NoteRecord>(
    note.id,
    "本机找不到这份笔记，请重新生成后再讨论。",
    (existing, store) => {
      const next: NoteRecord = { ...existing, ...note, updatedAt: new Date().toISOString() };
      store.put(next);
      return next;
    }
  );
  await clearDeletedNoteTombstone(updated.id);
  return updated;
}

export async function reviseNoteView(input: {
  id: string;
  viewKey: NoteViewKey;
  expectedMarkdown: string;
  markdown: string;
  messages?: NoteRecord['conversation'];
  requestId?: string;
}): Promise<NoteRecord> {
  const updated = await mutateNoteRecord<NoteRecord>(input.id, "本机找不到这份笔记。", (existing, store, recovery) => {
    const current = existing.views?.[input.viewKey] ||
      (existing.template === input.viewKey ? existing.markdown : "");
    if (current !== input.expectedMarkdown) throw new Error("笔记正文已改变，修订结果未覆盖新内容。");
    saveRecoverySnapshot(recovery, existing, 'edit', input.viewKey);
    const conversation = [...(existing.conversation || [])];
    if (input.requestId && !conversation.some((item) => item.requestId === input.requestId)) {
      conversation.push(...(input.messages || []).map((item) => ({ ...item, requestId: input.requestId })));
    }
    const next: NoteRecord = {
      ...existing,
      views: { ...existing.views, [input.viewKey]: input.markdown },
      markdown: existing.template === input.viewKey || !existing.markdown ? input.markdown : existing.markdown,
      conversation,
      updatedAt: new Date().toISOString()
    };
    store.put(next);
    return next;
  });
  await clearDeletedNoteTombstone(updated.id);
  return updated;
}

export async function updateGenerationNote(input: {
  id: string;
  targetTemplate: TemplateId;
  expectedMarkdown: string;
  saveSnapshot?: boolean;
  note: Partial<NoteRecord>;
}): Promise<NoteRecord> {
  return mutateNoteRecord<NoteRecord>(input.id, '本机找不到生成中的笔记。', (existing, store, recovery) => {
    const target = input.targetTemplate;
    const current = isNoteViewKey(target)
      ? (existing.views?.[target] || (existing.template === target ? existing.markdown : ''))
      : target === 'flashcards'
        ? (existing.flashcardMarkdown || (existing.template === target ? existing.markdown : ''))
        : (existing.quizState?.generatedMarkdown || (existing.template === target ? existing.markdown : ''));
    if (current !== input.expectedMarkdown) throw new Error('生成期间目标内容已改变，结果未覆盖新内容。');
    const targetMarkdown = isNoteViewKey(target)
      ? input.note.views?.[target]
      : target === 'flashcards' ? input.note.flashcardMarkdown : input.note.quizState?.generatedMarkdown;
    if (input.saveSnapshot && targetMarkdown && current && targetMarkdown !== current) {
      saveRecoverySnapshot(recovery, existing, 'edit', isNoteViewKey(target) ? target : undefined);
    }
    const views = { ...existing.views };
    if (isNoteViewKey(target) && targetMarkdown) views[target] = targetMarkdown;
    const next: NoteRecord = {
      ...existing,
      template: target,
      modelMarkdown: input.note.modelMarkdown,
      generationModel: input.note.generationModel,
      generationModels: input.note.generationModels,
      generationProgress: input.note.generationProgress,
      generationStatus: input.note.generationStatus,
      generationStartedAt: input.note.generationStartedAt,
      generationError: input.note.generationError,
      complete: input.note.complete,
      visualAnalysis: input.note.visualAnalysis,
      visualAnalysisMode: input.note.visualAnalysisMode,
      transcript: input.note.transcript,
      transcriptSegments: input.note.transcriptSegments,
      detectedLanguages: input.note.detectedLanguages,
      views,
      ...(target === 'flashcards' ? { flashcardMarkdown: input.note.flashcardMarkdown, flashcardReview: input.note.flashcardReview } : {}),
      ...(target === 'quiz' ? { quizState: input.note.quizState } : {}),
      markdown: targetMarkdown || existing.markdown,
      updatedAt: new Date().toISOString()
    };
    store.put(next);
    return next;
  });
}

export async function updateVisualNote(input: {
  id: string;
  viewKey: NoteViewKey;
  expectedMarkdown: string;
  markdown: string;
  visualAnalysis: boolean;
  visualAnalysisMode: string;
  complete: boolean;
}): Promise<NoteRecord> {
  return mutateNoteRecord<NoteRecord>(input.id, '本机找不到待分析的笔记。', (existing, store, recovery) => {
    const current = existing.views?.[input.viewKey] || (existing.template === input.viewKey ? existing.markdown : '');
    if (current !== input.expectedMarkdown) throw new Error('画面分析期间正文已改变，结果未覆盖新内容。');
    if (input.markdown !== current) saveRecoverySnapshot(recovery, existing, 'edit', input.viewKey);
    const next: NoteRecord = {
      ...existing,
      views: { ...existing.views, [input.viewKey]: input.markdown },
      markdown: existing.template === input.viewKey ? input.markdown : existing.markdown,
      visualAnalysis: input.visualAnalysis,
      visualAnalysisMode: input.visualAnalysisMode,
      complete: input.complete,
      updatedAt: new Date().toISOString()
    };
    store.put(next);
    return next;
  });
}

export async function updateFlashcardReviewItem(id: string, state: FlashcardReviewState): Promise<FlashcardReviewState[]> {
  if (!id || !state?.id) throw new Error("闪卡复习记录无效，无法保存进度。");
  const updated = await mutateNoteRecord<NoteRecord>(
    id,
    "本机找不到这份笔记，无法保存闪卡复习进度。",
    (existing, store) => {
      const next: NoteRecord = {
        ...existing,
        flashcardReview: mergeFlashcardReviewState(existing.flashcardReview, state),
        updatedAt: new Date().toISOString()
      };
      store.put(next);
      return next;
    }
  );
  await clearDeletedNoteTombstone(updated.id);
  return updated.flashcardReview || [];
}

export async function updateNoteFlashcardState(
  id: string,
  flashcardMarkdown: string,
  flashcardReview?: FlashcardReviewState[]
): Promise<{ flashcardMarkdown: string; flashcardReview: FlashcardReviewState[] }> {
  if (!id) throw new Error("闪卡记录无效，无法保存。");
  const updated = await mutateNoteRecord<NoteRecord>(
    id,
    "本机找不到这份笔记，无法保存记忆闪卡。",
    (existing, store) => {
      const next: NoteRecord = {
        ...existing,
        flashcardMarkdown: String(flashcardMarkdown || ""),
        flashcardReview: Array.isArray(flashcardReview) ? flashcardReview : (existing.flashcardReview || []),
        updatedAt: new Date().toISOString()
      };
      store.put(next);
      return next;
    }
  );
  await clearDeletedNoteTombstone(updated.id);
  return {
    flashcardMarkdown: updated.flashcardMarkdown || "",
    flashcardReview: updated.flashcardReview || []
  };
}

export async function updateNoteQuizState(id: string, quizState: QuizRecordState): Promise<QuizRecordState> {
  if (!id || !quizState || typeof quizState !== "object") {
    throw new Error("随堂自测状态无效，无法保存进度。");
  }
  const updated = await mutateNoteRecord<NoteRecord>(
    id,
    "本机找不到这份笔记，无法保存随堂自测进度。",
    (existing, store) => {
      const nextQuiz: QuizRecordState = {
        answers: { ...(quizState.answers || {}) },
        ...(quizState.generatedMarkdown ? { generatedMarkdown: quizState.generatedMarkdown } : {}),
        updatedAt: quizState.updatedAt || new Date().toISOString()
      };
      const next: NoteRecord = {
        ...existing,
        quizState: nextQuiz,
        updatedAt: new Date().toISOString()
      };
      store.put(next);
      return next;
    }
  );
  await clearDeletedNoteTombstone(updated.id);
  return updated.quizState!;
}

export async function deleteNote(id?: string): Promise<boolean> {
  if (!id) throw new Error("笔记 ID 缺失，无法删除。");
  const deletedNote = await mutateNoteRecord<NoteRecord>(
    id,
    "本机找不到这份笔记。",
    (existing, store) => {
      store.delete(id);
      return existing;
    },
    true
  );
  await recordDeletedNoteTombstone(id);
  const deletedLessonKey = Keji.lessonKey(deletedNote);
  if (deletedLessonKey) await clearLessonOpfsCache(deletedLessonKey).catch(() => {});
  return true;
}

export async function importNotes(incoming: unknown, incomingDeleted: unknown = []) {
  if (!Array.isArray(incoming)) throw new Error("备份文件格式无效：notes 必须是数组。");
  if (!Array.isArray(incomingDeleted)) throw new Error("备份文件格式无效：deletedNotes 必须是数组。");
  try {
    const tombstones = new Map<string, DeletedNoteTombstone>();
    for (const item of [...await deletedNoteTombstones(), ...incomingDeleted]) {
      if (!item || typeof item.id !== "string" || !item.id) continue;
      const deletedAt = Date.parse(item.deletedAt || "");
      if (!Number.isFinite(deletedAt)) continue;
      const previous = tombstones.get(item.id);
      if (!previous || deletedAt > Date.parse(previous.deletedAt)) {
        tombstones.set(item.id, { id: item.id, deletedAt: new Date(deletedAt).toISOString() });
      }
    }
    const database = await openNotesDatabase();
    const transaction = database.transaction(["notes", "recovery", "summaries"], "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore("notes");
    const summaries = transaction.objectStore("summaries");
    const recovery = transaction.objectStore("recovery");
    const request = store.getAll();
    let imported = { added: 0, updated: 0, removed: 0, retained: 0, trimmed: 0 };
    request.onsuccess = () => {
      const existing = (request.result || []) as NoteRecord[];
      const existingById = new Map(existing.map((note) => [note.id, note]));
      const existingByLesson = new Map<string, NoteRecord>();
      for (const note of existing) {
        const key = Keji.lessonKey(note);
        if (!key) continue;
        const prev = existingByLesson.get(key);
        const prevTime = prev ? (Date.parse(prev.updatedAt || prev.createdAt || "") || 0) : -1;
        const curTime = Date.parse(note.updatedAt || note.createdAt || "") || 0;
        if (!prev || curTime > prevTime) existingByLesson.set(key, note);
      }
      const identities = new Set(existingById.keys());
      const sourceKeyOf = (note: Partial<NoteRecord>) => `${note.url || ""}|${note.page || ""}|${note.createdAt || ""}`;
      const sourceKeys = new Set(existing.map(sourceKeyOf));
      let added = 0;
      let updated = 0;
      let removed = 0;

      for (const [id, tombstone] of tombstones) {
        const previous = existingById.get(id);
        if (!previous) continue;
        const previousTime = Date.parse(previous.updatedAt || previous.createdAt || "") || 0;
        const deletedTime = Date.parse(tombstone.deletedAt) || 0;
        if (deletedTime >= previousTime) {
          saveRecoverySnapshot(recovery, previous, 'sync');
          store.delete(id);
          summaries.delete(id);
          existingById.delete(id);
          identities.delete(id);
          sourceKeys.delete(sourceKeyOf(previous));
          const lessonKey = Keji.lessonKey(previous);
          if (lessonKey && existingByLesson.get(lessonKey)?.id === id) existingByLesson.delete(lessonKey);
          removed += 1;
        } else {
          tombstones.delete(id);
        }
      }

      for (const item of incoming) {
        if (!item || typeof item !== "object" || typeof item.markdown !== "string") continue;
        const createdAt = item.createdAt || new Date().toISOString();
        const sourceKey = sourceKeyOf({ ...item, createdAt });
        const tombstone = item.id ? tombstones.get(item.id) : null;
        const incomingTime = Date.parse(item.updatedAt || item.createdAt || "") || 0;
        if (tombstone && incomingTime <= (Date.parse(tombstone.deletedAt) || 0)) continue;
        if (tombstone) tombstones.delete(item.id);
        const itemLessonKey = Keji.lessonKey(item);
        const previous = (item.id ? existingById.get(item.id) : null)
          || (itemLessonKey ? existingByLesson.get(itemLessonKey) : null);
        if (previous) {
          const previousTime = Date.parse(previous.updatedAt || previous.createdAt || "") || 0;
          if (incomingTime > previousTime) {
            if (JSON.stringify(previous) !== JSON.stringify(item)) saveRecoverySnapshot(recovery, previous, 'sync');
            const mergedViews = (previous.views || item.views)
              ? { ...(previous.views || {}), ...(item.views || {}) }
              : undefined;
            const merged: NoteRecord = {
              ...previous,
              ...item,
              id: previous.id,
              lessonKey: itemLessonKey || previous.lessonKey,
              courseTitle: item.courseTitle || previous.courseTitle,
              reviewMark: item.reviewMark !== undefined ? item.reviewMark : (previous.reviewMark || ""),
              personalNote: item.personalNote !== undefined ? item.personalNote : (previous.personalNote || ""),
              createdAt: previous.createdAt || createdAt,
              ...(mergedViews ? { views: mergedViews } : {}),
              flashcardMarkdown: item.flashcardMarkdown ?? previous.flashcardMarkdown ?? ""
            };
            store.put(merged);
            summaries.put(summaryRecord(merged));
            existingById.set(merged.id, merged);
            if (itemLessonKey) existingByLesson.set(itemLessonKey, merged);
            updated += 1;
          }
          continue;
        }
        if (sourceKeys.has(sourceKey)) continue;
        let id = item.id || crypto.randomUUID();
        while (identities.has(id)) id = crypto.randomUUID();
        identities.add(id);
        sourceKeys.add(sourceKey);
        const merged: NoteRecord = { ...item, id, lessonKey: itemLessonKey, title: String(item.title || "未命名视频"), createdAt };
        store.put(merged);
        summaries.put(summaryRecord(merged));
        existingById.set(id, merged);
        if (itemLessonKey) existingByLesson.set(itemLessonKey, merged);
        added += 1;
      }
      imported = { added, updated, removed, retained: existing.length + added - removed, trimmed: 0 };
    };
    await completed;
    await chrome.storage.local.set({ remoteDeletedNotes: [...tombstones.values()] });
    return imported;
  } catch (error) {
    if (quotaError(error)) throw new Error("备份超出浏览器本机数据库可用空间；没有导入部分笔记，请先备份并清理旧数据后重试。");
    throw error;
  }
}

function utf8Bytes(value: unknown): number {
  return value ? utf8Encoder.encode(String(value)).byteLength : 0;
}

export function noteIntermediateBytes(note?: NoteRecord | null): number {
  if (!note || note.generationStatus === "running" || !note.complete) return 0;
  return utf8Bytes(note.modelMarkdown);
}

function stripNoteIntermediateFields(note: NoteRecord): NoteRecord {
  return {
    ...note,
    // The origin of legacy transcripts is unknown; keep them as user data.
    ...(note.complete ? { modelMarkdown: "" } : {})
  };
}

export async function findMatchingNotes({ lessonKey = "", noteId = "" } = {}): Promise<NoteRecord[]> {
  const allNotes = await getAllNotes();
  return allNotes.filter((note) => (noteId && note.id === noteId) || (lessonKey && Keji.lessonKey(note) === lessonKey));
}

export async function stripIntermediateFromNotes(notesToClean: NoteRecord[], requirePositiveBytes = false) {
  const database = await openNotesDatabase();
  const transaction = database.transaction(["notes", "summaries"], "readwrite");
  const completed = transactionCompletion(transaction);
  const store = transaction.objectStore("notes");
  let freedBytes = 0;
  let cleanedNotes = 0;
  for (const note of notesToClean) {
    if (note.generationStatus === "running") continue;
    const strippedBytes = noteIntermediateBytes(note);
    if (requirePositiveBytes && strippedBytes <= 0) continue;
    const request = store.get(note.id);
    request.onsuccess = () => {
      const current = request.result as NoteRecord | undefined;
      if (!current || current.generationStatus === "running") return;
      const next = stripNoteIntermediateFields(current);
      freedBytes += utf8Bytes(current.modelMarkdown) - utf8Bytes(next.modelMarkdown);
      if (next.modelMarkdown !== current.modelMarkdown) {
        cleanedNotes += 1;
        store.put(next);
        transaction.objectStore('summaries').put(summaryRecord(next));
      }
    };
  }
  await completed;
  return { freedBytes, cleanedNotes };
}
