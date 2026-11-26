import type { FlashcardReviewState } from "./flashcards.ts";
import type { NoteViewKey, TemplateId } from "./note-structures.ts";
import type { QuizRecordState } from "./quiz.ts";

export type { TemplateId };
export type ModelCapability = "text" | "image" | "video_silent" | "video_audio";
export type DiscussionMode = "qa" | "feynman" | "revise";
export type ReviewMark = "" | "star" | "question" | "mastered";

export interface ModelPreset {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  modelCapability: ModelCapability;
  apiKey: string;
}

export interface KejiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  modelCapability: ModelCapability;
  modelPresets?: ModelPreset[];
  activePresetId?: string;
  transcriptionEndpoint: string;
  transcriptionModel: string;
  transcriptionPrompt: string;
  transcriptionApiKey: string;
  generationConcurrency: number | string;
  remoteBackupUrl: string;
  remoteBackupUsername: string;
  remoteBackupPassword: string;
  remoteBackupAutoSync: boolean;
  temperature: number | string;
  customPrompt: string;
}

export interface VideoTarget {
  lessonKey?: string;
  bvid?: string;
  url?: string;
  page?: number;
  pageCount?: number;
  cid?: number;
  title?: string;
  part?: string;
  duration?: number;
  cover?: string;
}

export interface VideoPart {
  page: number;
  cid?: number;
  part: string;
  duration?: number;
  url: string;
}

export interface CaptionTrack {
  key: string;
  label: string;
  language?: string;
  url?: string;
  automatic?: boolean;
}

export interface TranscriptSegment {
  time: number;
  end?: number;
  text: string;
  language?: string;
}

export interface KeyFrameItem {
  timestamp: string;
  seconds: number;
  caption: string;
  dataUrl: string;
  raw?: string;
  marker?: string;
}

export interface ConversationItem {
  role: "user" | "assistant" | string;
  mode?: DiscussionMode;
  content: string;
  createdAt?: string;
  requestId?: string;
}

export interface GenerationProgress {
  completedChunks: number;
  totalChunks: number;
  chunkMaxChars?: number;
}

export interface NoteSummary {
  id: string;
  title?: string;
  courseTitle?: string;
  part?: string;
  url?: string;
  page?: number;
  pageCount?: number;
  duration?: number;
  cover?: string;
  template?: TemplateId | string;
  reviewMark?: ReviewMark;
  personalNote?: string;
  viewKeys?: NoteViewKey[];
  quizSummary?: { total: number; answered: number; correct: number } | null;
  flashcardSummary?: { total: number; due: number } | null;
  summaryPreview?: string;
  createdAt?: string;
  updatedAt?: string;
  complete?: boolean;
  visualAnalysis?: boolean;
  visualAnalysisMode?: string;
  generationProgress?: GenerationProgress | null;
  generationStatus?: string;
  generationStartedAt?: string;
  generationError?: string;
  generationModel?: string;
  generationModels?: string[];
  hasContent?: boolean;
  excerpt?: string;
}

export interface NoteRecord extends NoteSummary {
  lessonKey?: string;
  customPrompt?: string;
  modelMarkdown?: string;
  transcript?: string;
  transcriptSegments?: TranscriptSegment[];
  detectedLanguages?: string[];
  views?: Partial<Record<NoteViewKey, string>>;
  flashcardMarkdown?: string;
  flashcardReview?: FlashcardReviewState[];
  quizState?: QuizRecordState;
  conversation?: ConversationItem[];
  markdown: string;
}

export interface LessonCacheStatus {
  lessonKey: string;
  hasAudio: boolean;
  audioBytes: number;
  hasVideo: boolean;
  videoBytes: number;
  hasMuxedVideo: boolean;
  muxedVideoBytes: number;
  hasTranscript: boolean;
  transcriptBytes: number;
  metaBytes: number;
  opfsBytes: number;
  meta: Record<string, any> | null;
  noteIntermediateBytes?: number;
  totalBytes?: number;
}

export interface CacheOverview {
  audioBytes: number;
  videoBytes: number;
  muxedVideoBytes: number;
  transcriptBytes: number;
  noteIntermediateBytes: number;
  totalBytes: number;
  lessonCount: number;
}

const DEFAULT_SETTINGS: KejiSettings = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
  modelCapability: "text",
  modelPresets: [],
  activePresetId: "",
  transcriptionEndpoint: "http://127.0.0.1:11434/api/chat",
  transcriptionModel: "frozenlab/qwen3-asr:1.7b",
  transcriptionPrompt: "",
  transcriptionApiKey: "",
  generationConcurrency: 2,
  remoteBackupUrl: "",
  remoteBackupUsername: "",
  remoteBackupPassword: "",
  remoteBackupAutoSync: false,
  temperature: 0.3,
  customPrompt: ""
};

function normalizeOverlapText(input: string): { text: string; ends: number[] } {
  let text = "";
  const ends: number[] = [];
  for (let i = 0; i < input.length; ) {
    const cp = input.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const nextIndex = i + ch.length;
    if (/[\p{L}\p{N}]/u.test(ch)) {
      for (const unit of ch.toLowerCase()) {
        text += unit;
        ends.push(nextIndex);
      }
    }
    i = nextIndex;
  }
  return { text, ends };
}

export const Keji = {
  defaultSettings: DEFAULT_SETTINGS,

  parseTime(value: string): number | null {
    const parts = String(value || "").trim().replace(",", ".").split(":");
    if (parts.length < 2 || parts.length > 3) return null;
    const nums = parts.map(Number);
    if (nums.some((part) => !Number.isFinite(part) || part < 0)) return null;
    const seconds = nums.pop()!;
    const minutes = nums.pop()!;
    const hours = nums.length ? nums.pop()! : 0;
    return Math.max(0, hours * 3600 + minutes * 60 + seconds);
  },

  formatTime(seconds: number): string {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return hours > 0
      ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  },

  resolveAsrEndpoint(raw: unknown): string {
    const trimmed = String(raw || "").trim().replace(/\/+$/, "");
    if (!trimmed) return DEFAULT_SETTINGS.transcriptionEndpoint;
    if (/\/(?:api\/chat|chat\/completions)$/i.test(trimmed)) return trimmed;
    try {
      const url = new URL(trimmed);
      if (!url.pathname || url.pathname === "/") return `${trimmed}/api/chat`;
    } catch {
      return trimmed;
    }
    return `${trimmed}/chat/completions`;
  },

  parseAsrText(raw: unknown): { text: string; language: string } {
    const cleaned = String(raw || "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<\|im_end\|>/g, "")
      .trim();
    const match = cleaned.match(/^(?:language\s+([^\n<]+?)\s*)?<asr_text>([\s\S]*)$/i);
    if (!match) return { text: cleaned, language: "" };
    const rawLang = String(match[1] || "").trim();
    const language = /^none$/i.test(rawLang) ? "" : rawLang;
    return { text: String(match[2] || "").trim(), language };
  },

  dedupeTranscriptOverlap(prevText: string, nextText: string): string {
    const rawNext = String(nextText || "").trim();
    const prevNorm = normalizeOverlapText(String(prevText || ""));
    const nextNorm = normalizeOverlapText(rawNext);
    if (!prevNorm.text || !nextNorm.text) return rawNext;

    const prevTail = prevNorm.text.slice(-36);
    const nextHead = nextNorm.text.slice(0, 36);
    const minOverlapFor = (candidate: string, strict: boolean) =>
      (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(candidate) ? (strict ? 3 : 2) : (strict ? 6 : 5));

    let bestMatchLen = 0;
    let bestCutLen = 0;
    for (let nextOffset = 0; nextOffset <= Math.min(3, nextHead.length); nextOffset += 1) {
      const maxLen = Math.min(prevTail.length, nextHead.length - nextOffset);
      for (let len = maxLen; len >= 2; len -= 1) {
        const candidate = nextHead.slice(nextOffset, nextOffset + len);
        if (len < minOverlapFor(candidate, nextOffset > 0)) continue;
        if (prevTail.endsWith(candidate) && len > bestMatchLen) {
          bestMatchLen = len;
          bestCutLen = nextOffset + len;
          break;
        }
      }
    }

    if (bestCutLen === 0) {
      for (let prevGap = 1; prevGap <= Math.min(2, Math.max(0, prevTail.length - 2)); prevGap += 1) {
        const trimmedPrev = prevTail.slice(0, prevTail.length - prevGap);
        const maxLen = Math.min(trimmedPrev.length, nextHead.length);
        for (let len = maxLen; len >= 3; len -= 1) {
          const candidate = nextHead.slice(0, len);
          if (len < minOverlapFor(candidate, true)) continue;
          if (trimmedPrev.endsWith(candidate) && len > bestMatchLen) {
            bestMatchLen = len;
            bestCutLen = len;
            break;
          }
        }
      }
    }

    if (bestCutLen === 0) return rawNext;
    if (bestCutLen >= nextNorm.text.length) return "";
    return rawNext
      .slice(nextNorm.ends[bestCutLen - 1]!)
      .replace(/^[\s，,。\.、；;：:！？!?\-—·]+/u, "")
      .trim();
  },

  normalizeTranscriptionPrompt(value: unknown): string {
    return String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .join(", ")
      .slice(0, 200)
      .replace(/[\s,]+$/, "");
  },

  normalizeCapability(capability: unknown, legacyVideoMode?: unknown): ModelCapability {
    if (capability === "text" || capability === "image" || capability === "video_silent" || capability === "video_audio") {
      return capability;
    }
    if (legacyVideoMode === "try") return "video_silent";
    if (legacyVideoMode === "frames") return "image";
    return "text";
  },

  requiresTranscript(capability?: ModelCapability | null): boolean {
    return capability !== "video_audio";
  },

  supportsImage(capability?: ModelCapability | null): boolean {
    return capability === "image" || capability === "video_silent" || capability === "video_audio";
  },

  supportsVideo(capability?: ModelCapability | null): boolean {
    return capability === "video_silent" || capability === "video_audio";
  },

  bvidFromUrl(value?: string | null): string {
    try {
      return new URL(value || "").pathname.match(/\/video\/(BV[\w]+)/i)?.[1]?.toUpperCase() || "";
    } catch {
      return "";
    }
  },

  lessonKey(target?: VideoTarget | null): string {
    const bvid = String(target?.bvid || this.bvidFromUrl(target?.url || "")).trim().toUpperCase();
    if (!/^BV[\w]+$/i.test(bvid)) return "";
    let pageNum = Number(target?.page) || 0;
    if (!pageNum && target?.url) {
      try {
        pageNum = Number(new URL(target.url).searchParams.get("p")) || 0;
      } catch {
        pageNum = 0;
      }
    }
    const page = Math.max(1, Math.floor(pageNum || 1));
    return `${bvid}:${page}`;
  },

  cleanPartTitle(part?: string | null, page?: number | null): string {
    let text = String(part || "").trim();
    if (!text) return "";
    if (/^(?:P\s*\d+|第\s*\d+\s*[讲节集课]?)$/i.test(text)) return "";
    const pageNum = Math.max(0, Math.floor(Number(page) || 0));
    for (let pass = 0; pass < 3; pass += 1) {
      const stripP = text.replace(/^P\s*\d+\s*(?:[·•:：\-—|、._]+\s*|\s+(?=\S))/i, "").trim();
      const stripSec = stripP.replace(/^第\s*\d+\s*[讲节集课篇话]\s*[·•:：\-—|、._\s]*/i, "").trim();
      const numMatch = stripSec.match(/^0*(\d{1,3})\s*(?:[.、:：_\-—)\]]+\s*|\s+(?=[^\d\s]))(.*)$/);
      let next = stripSec;
      if (numMatch && numMatch[2]!.trim()) {
        const prefixNum = Number(numMatch[1]);
        if (!pageNum || prefixNum === pageNum || prefixNum <= 999) {
          next = numMatch[2]!.trim();
        }
      }
      if (!next || next === text) break;
      text = next;
    }
    return text;
  },

  formatEpisodeHeading(target?: {
    title?: string;
    courseTitle?: string;
    part?: string;
    page?: number;
    pageCount?: number;
  } | null): {
    mainTitle: string;
    courseTitle: string;
    courseLabel: string;
    isMultiPart: boolean;
  } {
    const rawTitle = String(target?.title || "").trim();
    const rawCourse = String(target?.courseTitle || "").trim();
    const page = Math.max(1, Math.floor(Number(target?.page) || 1));
    const pageCount = Math.max(1, Math.floor(Number(target?.pageCount) || 1));
    const cleanPart = this.cleanPartTitle(target?.part, page);
    const courseTitle = rawCourse || rawTitle || "未命名课程";
    const isMultiPart = pageCount > 1 || Boolean(cleanPart && courseTitle && cleanPart !== courseTitle);
    if (!isMultiPart) {
      return {
        mainTitle: rawTitle || cleanPart || "课程笔记",
        courseTitle,
        courseLabel: ""
        ,
        isMultiPart: false
      };
    }
    const defaultEpisodeTitle = cleanPart
      ? `P${page} · ${cleanPart}`
      : `第 ${page} 讲 · ${courseTitle}`;
    const hasCustomEpisodeTitle = Boolean(rawCourse && rawTitle && rawTitle !== rawCourse);
    const mainTitle = hasCustomEpisodeTitle ? rawTitle : defaultEpisodeTitle;
    const progressPart = pageCount > 1 ? `第 ${page}/${pageCount} 讲` : `第 ${page} 讲`;
    const courseLabel = [courseTitle, progressPart].filter(Boolean).join(" · ");
    return { mainTitle, courseTitle, courseLabel, isMultiPart: true };
  },

  generationBatches(totalChunks: number, concurrency = 2, startAt = 0): number[][] {
    const total = Math.max(0, Math.floor(Number(totalChunks) || 0));
    const limit = Math.max(1, Math.min(4, Math.floor(Number(concurrency) || 2)));
    let cursor = Math.max(0, Math.min(total, Math.floor(Number(startAt) || 0)));
    const batches: number[][] = [];
    while (cursor < total) {
      const size = cursor === 0 ? 1 : Math.min(limit, total - cursor);
      batches.push(Array.from({ length: size }, (_, offset) => cursor + offset));
      cursor += size;
    }
    return batches;
  },

  async runGenerationBatch<T extends { ok?: boolean; error?: string; markdown?: string }>(
    indexes: number[],
    initialMarkdown: string,
    generateChunk: (index: number, seedMarkdown: string) => Promise<T>,
    mergeMarkdown: (previousMarkdown: string, chunkMarkdown: string, value: T) => string,
    onCommit: (info: { index: number; markdown: string; committed: number; value: T }) => Promise<void> = async () => {}
  ) {
    const orderedIndexes = Array.isArray(indexes) ? indexes : [];
    const seedMarkdown = String(initialMarkdown || "");
    const results: Array<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown } | null> = Array(orderedIndexes.length).fill(null);
    let committed = 0;
    let markdown = seedMarkdown;
    let commitQueue = Promise.resolve();
    const tasks = orderedIndexes.map(async (index, offset) => {
      try {
        const value = await generateChunk(index, seedMarkdown);
        if (!value?.ok) throw new Error(value?.error || `第 ${index + 1} 段生成失败。`);
        if (typeof value.markdown !== "string" || !value.markdown.trim()) {
          throw new Error(`第 ${index + 1} 段没有返回笔记内容。`);
        }
        results[offset] = { status: "fulfilled", value };
      } catch (reason) {
        results[offset] = { status: "rejected", reason };
      }
      commitQueue = commitQueue.then(async () => {
        while (committed < results.length) {
          const item = results[committed];
          if (!item || item.status !== "fulfilled") return;
          const nextMarkdown = mergeMarkdown(markdown, item.value.markdown!, item.value);
          const nextCommitted = committed + 1;
          await onCommit({
            index: orderedIndexes[committed]!,
            markdown: nextMarkdown,
            committed: nextCommitted,
            value: item.value
          });
          markdown = nextMarkdown;
          committed = nextCommitted;
        }
      });
      await commitQueue;
    });
    const settled = await Promise.allSettled(tasks);
    const commitError = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (commitError) throw commitError.reason;
    const failureOffset = results.findIndex((item) => item?.status !== "fulfilled");
    return {
      markdown,
      committed,
      results,
      failureOffset,
      failedIndex: failureOffset >= 0 ? orderedIndexes[failureOffset]! : null
    };
  },

  splitTranscript(text: string, maxCharacters = 12000): string[] {
    const source = String(text || "");
    const limit = Math.max(1000, Number(maxCharacters) || 12000);
    const lines = source.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || [];
    const chunks: string[] = [];
    let current = "";
    const append = (value: string) => {
      if (current && current.length + value.length > limit) {
        chunks.push(current);
        current = "";
      }
      current += value;
    };
    for (let line of lines) {
      while (line.length > limit) {
        if (current) {
          chunks.push(current);
          current = "";
        }
        let boundary = limit;
        const punctuation = Math.max(
          line.lastIndexOf("。", limit - 1), line.lastIndexOf("！", limit - 1), line.lastIndexOf("？", limit - 1),
          line.lastIndexOf("；", limit - 1), line.lastIndexOf(".", limit - 1), line.lastIndexOf("!", limit - 1),
          line.lastIndexOf("?", limit - 1), line.lastIndexOf(";", limit - 1), line.lastIndexOf("\n", limit - 1)
        );
        if (punctuation >= Math.floor(limit * 0.6)) boundary = punctuation + 1;
        chunks.push(line.slice(0, boundary));
        line = line.slice(boundary);
      }
      append(line);
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [source];
  },

  parseContextOverflowError(message: unknown): {
    isOverflow: boolean;
    requestTokens: number | null;
    contextLimit: number | null;
  } {
    const text = String(message || "");
    const llamaMatch = text.match(/request\s*\(\s*(\d+)\s*tokens?\s*\)\s*exceeds[\s\S]*?context\s+size\s*\(\s*(\d+)\s*tokens?\s*\)/i);
    if (llamaMatch) {
      return {
        isOverflow: true,
        requestTokens: Number(llamaMatch[1]) || null,
        contextLimit: Number(llamaMatch[2]) || null,
      };
    }
    const openaiMatch = text.match(/maximum\s+context\s+length\s+is\s+(\d+)\s*tokens?[\s\S]*?(?:resulted\s+in|requested)\s+(\d+)\s*tokens?/i);
    if (openaiMatch) {
      return {
        isOverflow: true,
        requestTokens: Number(openaiMatch[2]) || null,
        contextLimit: Number(openaiMatch[1]) || null,
      };
    }
    const isOverflow = /context_length_exceeded|exceeds?\s+(?:the\s+)?(?:available\s+)?context|maximum\s+context\s+length|context\s+window|too\s+many\s+tokens|prompt\s+is\s+too\s+long|input\s+is\s+too\s+long/i.test(text);
    return { isOverflow, requestTokens: null, contextLimit: null };
  },

  computeAdaptiveChunkChars(
    currentChunkChars: number,
    overflow: { requestTokens: number | null; contextLimit: number | null }
  ): number | null {
    const current = Math.max(1000, Math.floor(Number(currentChunkChars) || 12000));
    if (current <= 1000) return null;
    if (overflow.requestTokens && overflow.contextLimit && overflow.requestTokens > 0 && overflow.contextLimit > 0) {
      const outputReserve = Math.min(2400, Math.max(800, Math.floor(overflow.contextLimit * 0.35)));
      const promptOverhead = Math.min(650, Math.floor(overflow.contextLimit * 0.2));
      const budgetTokens = overflow.contextLimit - outputReserve - promptOverhead;
      if (budgetTokens < 350) return null;
      const tokensPerChar = Math.max(0.25, overflow.requestTokens / current);
      const estimated = Math.floor((budgetTokens / tokensPerChar) * 0.88);
      const next = Math.max(1000, Math.min(current - 1000, estimated));
      return next >= current ? null : next;
    }
    const next = Math.max(1000, Math.floor(current * 0.5));
    return next < current ? next : null;
  },

  audioChunkRanges(durationSeconds: number, maxChunkSeconds = 600): Array<{ index: number; start: number; end: number }> {
    const duration = Number(durationSeconds) || 0;
    if (duration <= 0) return [{ index: 0, start: 0, end: 0 }];
    const step = Math.max(30, Math.floor(Number(maxChunkSeconds) || 600));
    const chunks: Array<{ index: number; start: number; end: number }> = [];
    for (let start = 0, index = 0; start < duration; start += step, index += 1) {
      if (chunks.length && duration - start < 5) {
        chunks[chunks.length - 1]!.end = duration;
        break;
      }
      chunks.push({ index, start, end: Math.min(duration, start + step) });
    }
    return chunks.length ? chunks : [{ index: 0, start: 0, end: duration }];
  },

  bytesToBase64(bytes: Uint8Array): string {
    const parts: string[] = [];
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
    }
    return btoa(parts.join(""));
  }
};
