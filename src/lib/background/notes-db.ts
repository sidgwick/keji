import { mergeFlashcardReviewState, type FlashcardReviewState } from "../flashcards.ts";
import { Keji, type NoteRecord, type NoteSummary } from "../keji.ts";
import { clearLessonOpfsCache } from "../lesson-cache.ts";
import { noteExcerpt } from "../markdown.ts";
import type { QuizRecordState } from "../quiz.ts";

interface DeletedNoteTombstone {
  id: string;
  deletedAt: string;
}

const utf8Encoder = new TextEncoder();
let notesDatabasePromise: Promise<IDBDatabase> | null = null;

function openNotesDatabase(): Promise<IDBDatabase> {
  if (notesDatabasePromise) return notesDatabasePromise;
  notesDatabasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("keji-notes", 3);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("notes")) {
        const store = database.createObjectStore("notes", { keyPath: "id" });
        store.createIndex("createdAt", "createdAt", { unique: false });
        store.createIndex("url", "url", { unique: false });
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
  mutate: (existing: NoteRecord, store: IDBObjectStore) => T
): Promise<T> {
  try {
    const database = await openNotesDatabase();
    const transaction = database.transaction("notes", "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore("notes");
    const request = store.get(id);
    let outcome: T | undefined;
    let found = false;
    request.onsuccess = () => {
      if (!request.result) {
        transaction.abort();
        return;
      }
      found = true;
      outcome = mutate(request.result as NoteRecord, store);
    };
    await completed;
    if (!found) throw new Error(notFoundMsg);
    return outcome!;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw new Error(notFoundMsg);
    throw normalizeNoteDatabaseError(error);
  }
}

export function summarizeNote(note: NoteRecord): NoteSummary {
  return {
    id: note.id, title: note.title, part: note.part, url: note.url, page: note.page, pageCount: note.pageCount,
    duration: note.duration, cover: note.cover, template: note.template,
    createdAt: note.createdAt, updatedAt: note.updatedAt, complete: note.complete,
    visualAnalysis: note.visualAnalysis, visualAnalysisMode: note.visualAnalysisMode,
    generationProgress: note.generationProgress, generationStatus: note.generationStatus,
    generationStartedAt: note.generationStartedAt, generationError: note.generationError,
    generationModel: note.generationModel, generationModels: note.generationModels
  };
}

export async function listNotes({ query = "", previewLimit = 0 } = {}) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  const allRecords = await getAllNotes();
  const allNotes = allRecords.map(summarizeNote);
  const matched = needle
    ? allRecords.filter((note) => {
      const body = String(note.markdown || "").replace(/!\[([^\]]*)\]\(data:image\/[^;]+;base64,[^)]+\)/g, "$1");
      const conv = Array.isArray(note.conversation) ? note.conversation.map((item) => item.content) : [];
      return [note.title, note.part, note.url, note.transcript, body, ...conv]
        .some((field) => String(field || "").toLocaleLowerCase().includes(needle));
    }).map(summarizeNote)
    : allNotes;
  const limit = Math.max(0, Math.floor(Number(previewLimit) || 0));
  if (limit > 0) {
    const notes = allRecords.slice(0, limit).map((note) => ({ ...summarizeNote(note), excerpt: noteExcerpt(note.markdown) }));
    return { notes, allNotes };
  }
  return { notes: matched };
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
    const transaction = database.transaction("notes", "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore("notes");
    const createNew = () => {
      saved = { id: crypto.randomUUID(), createdAt: now, markdown: "", ...note } as NoteRecord;
      store.add(saved);
    };
    if (lessonKey) {
      const request = store.getAll();
      request.onsuccess = () => {
        const matches = ((request.result || []) as NoteRecord[])
          .filter((item) => Keji.lessonKey(item) === lessonKey)
          .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt || "") || 0) - (Date.parse(a.updatedAt || a.createdAt || "") || 0));
        if (matches.length) {
          const [primary, ...duplicates] = matches;
          saved = { ...primary!, ...note, id: primary!.id, createdAt: primary!.createdAt || now, updatedAt: now };
          store.put(saved);
          for (const duplicate of duplicates) {
            store.delete(duplicate.id);
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
    }
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
    const transaction = database.transaction("notes", "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore("notes");
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
          store.delete(id);
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
            const merged: NoteRecord = { ...previous, ...item, id: previous.id, createdAt: previous.createdAt || createdAt };
            store.put(merged);
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
        const merged: NoteRecord = { ...item, id, title: String(item.title || "未命名视频"), createdAt };
        store.put(merged);
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

function transcriptPayloadBytes(record: {
  transcript?: unknown;
  transcriptSegments?: unknown;
  detectedLanguages?: unknown;
} | null | undefined): number {
  if (!record) return 0;
  let bytes = utf8Bytes(record.transcript);
  if (Array.isArray(record.transcriptSegments) && record.transcriptSegments.length) {
    bytes += utf8Bytes(JSON.stringify(record.transcriptSegments));
  }
  if (Array.isArray(record.detectedLanguages) && record.detectedLanguages.length) {
    bytes += utf8Bytes(JSON.stringify(record.detectedLanguages));
  }
  return bytes;
}

export function noteIntermediateBytes(note?: NoteRecord | null): number {
  if (!note || note.generationStatus === "running") return 0;
  return transcriptPayloadBytes(note) + utf8Bytes(note.modelMarkdown);
}

function stripNoteIntermediateFields(note: NoteRecord): NoteRecord {
  const hasMarkdown = Boolean(String(note?.markdown || "").trim());
  return {
    ...note,
    transcript: "",
    transcriptSegments: [],
    detectedLanguages: [],
    modelMarkdown: "",
    generationProgress: null,
    complete: hasMarkdown ? true : note.complete
  };
}

export async function findMatchingNotes({ lessonKey = "", noteId = "" } = {}): Promise<NoteRecord[]> {
  const allNotes = await getAllNotes();
  return allNotes.filter((note) => (noteId && note.id === noteId) || (lessonKey && Keji.lessonKey(note) === lessonKey));
}

export async function stripIntermediateFromNotes(notesToClean: NoteRecord[], requirePositiveBytes = false) {
  const database = await openNotesDatabase();
  const transaction = database.transaction("notes", "readwrite");
  const completed = transactionCompletion(transaction);
  const store = transaction.objectStore("notes");
  let freedBytes = 0;
  let cleanedNotes = 0;
  for (const note of notesToClean) {
    if (note.generationStatus === "running") continue;
    const strippedBytes = noteIntermediateBytes(note);
    if (requirePositiveBytes && strippedBytes <= 0) continue;
    freedBytes += strippedBytes;
    cleanedNotes += 1;
    store.put(stripNoteIntermediateFields(note));
  }
  await completed;
  return { freedBytes, cleanedNotes };
}

export async function clearLegacyTranscriptDraftsStore(): Promise<void> {
  const database = await openNotesDatabase();
  if (database.objectStoreNames.contains("transcriptDrafts")) {
    const tx = database.transaction("transcriptDrafts", "readwrite");
    tx.objectStore("transcriptDrafts").clear();
    await transactionCompletion(tx);
  }
}
