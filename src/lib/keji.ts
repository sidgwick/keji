import type { FlashcardReviewState } from "./flashcards.ts";
import type { TemplateId } from "./note-structures.ts";
import type { QuizRecordState } from "./quiz.ts";

export type { TemplateId };
export type ApiProtocol = "openai" | "mimo";
export type ModelCapability = "text" | "image" | "video_silent" | "video_audio";
export type DiscussionMode = "qa" | "feynman" | "revise";

export interface KejiSettings {
  apiProtocol: ApiProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelCapability: ModelCapability;
  transcriptionEndpoint: string;
  transcriptionModel: string;
  transcriptionLanguage: string;
  transcriptionPrompt: string;
  transcriptionApiKey: string;
  transcriptionConcurrency: number | string;
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
}

export interface GenerationProgress {
  completedChunks: number;
  totalChunks: number;
}

export interface NoteSummary {
  id: string;
  title?: string;
  part?: string;
  url?: string;
  page?: number;
  pageCount?: number;
  duration?: number;
  cover?: string;
  template?: TemplateId | string;
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
  excerpt?: string;
}

export interface NoteRecord extends NoteSummary {
  customPrompt?: string;
  modelMarkdown?: string;
  transcript?: string;
  transcriptSegments?: TranscriptSegment[];
  detectedLanguages?: string[];
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
  transcriptBytes: number;
  noteIntermediateBytes: number;
  totalBytes: number;
  lessonCount: number;
}

const DEFAULT_SETTINGS: KejiSettings = {
  apiProtocol: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
  modelCapability: "text",
  transcriptionEndpoint: "",
  transcriptionModel: "whisper-1",
  transcriptionLanguage: "",
  transcriptionPrompt: "",
  transcriptionApiKey: "",
  transcriptionConcurrency: 0,
  generationConcurrency: 2,
  remoteBackupUrl: "",
  remoteBackupUsername: "",
  remoteBackupPassword: "",
  remoteBackupAutoSync: false,
  temperature: 0.3,
  customPrompt: ""
};

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

  normalizeProtocol(protocol: unknown, baseUrl = ""): ApiProtocol {
    if (protocol === "mimo") return "mimo";
    if (protocol === "openai") return "openai";
    return /xiaomimimo\.com/i.test(String(baseUrl || "")) ? "mimo" : "openai";
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
    const page = Math.max(1, Math.floor(Number(target?.page) || 1));
    return `${bvid}:${page}`;
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
    mergeMarkdown: (previousMarkdown: string, chunkMarkdown: string) => string,
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
          const nextMarkdown = mergeMarkdown(markdown, item.value.markdown!);
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
