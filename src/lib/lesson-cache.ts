import { Keji, type LessonCacheStatus, type TranscriptSegment, type VideoTarget } from "./keji.ts";
import { muxDashTracks } from './media-mux.ts';

const CACHE_DIR_NAME = "keji-lesson-cache";
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const MEMORY_FALLBACK_BYTES = 150 * 1024 * 1024;
const ORPHAN_TMP_AGE_MS = 60 * 60 * 1000;

export const BILIBILI_CDN_SUFFIXES = ["bilivideo.com", "bilivideo.cn", "bilivideo.net", "hdslb.com"];
export const BILIBILI_CDN_ORIGINS = BILIBILI_CDN_SUFFIXES.map((suffix) => `https://*.${suffix}/*`);

type CacheKind = "audio.bin" | "video.mp4" | "audiovisual.mp4" | "transcript.json" | "meta.json";

interface CacheSizes {
  lessonKey: string;
  audioBytes: number;
  videoBytes: number;
  muxedVideoBytes: number;
  transcriptBytes: number;
  metaBytes: number;
  opfsBytes: number;
}

const KIND_TO_FIELD: Record<CacheKind, "audioBytes" | "videoBytes" | "muxedVideoBytes" | "transcriptBytes" | "metaBytes"> = {
  "audio.bin": "audioBytes",
  "video.mp4": "videoBytes",
  "audiovisual.mp4": "muxedVideoBytes",
  "transcript.json": "transcriptBytes",
  "meta.json": "metaBytes"
};

function createCacheSizes(lessonKey: string): CacheSizes {
  return { lessonKey, audioBytes: 0, videoBytes: 0, muxedVideoBytes: 0, transcriptBytes: 0, metaBytes: 0, opfsBytes: 0 };
}

function addCacheSize(target: CacheSizes, kind: CacheKind, size: number): void {
  target[KIND_TO_FIELD[kind]] += size;
  target.opfsBytes += size;
}

export function isBilibiliCdnUrl(rawUrl: unknown, requireHttps = true): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const validProtocol = requireHttps ? parsed.protocol === "https:" : /^https?:$/.test(parsed.protocol);
  if (!validProtocol || !BILIBILI_CDN_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    return null;
  }
  return parsed;
}

const metaWriteQueues = new Map<string, Promise<void>>();

export function normalizeLessonKey(target: string | VideoTarget | null | undefined): string {
  if (typeof target === "string") {
    const raw = target.trim();
    const colon = raw.match(/^(BV[0-9A-Za-z]+):(\d+)$/i);
    if (colon) return `${colon[1]!.toUpperCase()}:${Math.max(1, Number(colon[2]) || 1)}`;
    const underscore = raw.match(/^(BV[0-9A-Za-z]+)_p(\d+)$/i);
    if (underscore) return `${underscore[1]!.toUpperCase()}:${Math.max(1, Number(underscore[2]) || 1)}`;
    const bvidOnly = Keji.bvidFromUrl(raw);
    if (bvidOnly) {
      let page = 1;
      try {
        page = Math.max(1, Number(new URL(raw).searchParams.get("p")) || 1);
      } catch {
        page = 1;
      }
      return `${bvidOnly}:${page}`;
    }
    return "";
  }
  if (!target || typeof target !== "object") return "";
  if (typeof target.lessonKey === "string" && target.lessonKey.trim()) {
    const normalized = normalizeLessonKey(target.lessonKey);
    if (normalized) return normalized;
  }
  return Keji.lessonKey(target);
}

function lessonFilePrefix(target: string | VideoTarget | null | undefined): string {
  const key = normalizeLessonKey(target);
  if (!key) return "";
  const [bvid, page] = key.split(":");
  return `${bvid}_p${page}`;
}

export function formatBytes(value: number): string {
  const bytes = Math.max(0, Number(value) || 0);
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function lessonNames(prefix: string): Record<"audio" | "video" | "audiovisual" | "transcript" | "meta", string> {
  return {
    audio: `${prefix}.audio.bin`,
    video: `${prefix}.video.mp4`,
    audiovisual: `${prefix}.audiovisual.mp4`,
    transcript: `${prefix}.transcript.json`,
    meta: `${prefix}.meta.json`
  };
}

function keyPartsFromPrefix(prefix: string): { bvid: string; page: number; lessonKey: string } {
  const match = String(prefix || "").match(/^(BV[0-9A-Za-z]+)_p(\d+)$/i);
  if (!match) return { bvid: "", page: 1, lessonKey: "" };
  const bvid = match[1]!.toUpperCase();
  const page = Math.max(1, Number(match[2]) || 1);
  return { bvid, page, lessonKey: `${bvid}:${page}` };
}

async function openCacheDir({ create = false } = {}): Promise<FileSystemDirectoryHandle | null> {
  if (!globalThis.navigator?.storage?.getDirectory) return null;
  try {
    const root = await globalThis.navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR_NAME, { create });
  } catch {
    return null;
  }
}

async function getFileIfExists(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  if (!dir || !name) return null;
  try {
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch {
    return null;
  }
}

async function readJsonFile<T = Record<string, any>>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
  const file = await getFileIfExists(dir, name);
  if (!file) return null;
  try {
    return JSON.parse(await file.text()) as T;
  } catch {
    return null;
  }
}

async function commitTempHandle(
  dir: FileSystemDirectoryHandle,
  tempHandle: FileSystemFileHandle & { move?: (name: string) => Promise<void> },
  tempName: string,
  finalName: string
): Promise<void> {
  if (typeof tempHandle.move === "function") {
    try {
      await tempHandle.move(finalName);
      return;
    } catch {
      // Fallback below when move(newName) is unavailable or fails across implementations.
    }
  }
  const sourceFile = await tempHandle.getFile();
  const targetHandle = await dir.getFileHandle(finalName, { create: true });
  const writable = await targetHandle.createWritable();
  try {
    if (typeof sourceFile.stream === "function" && typeof writable.getWriter === "function") {
      await sourceFile.stream().pipeTo(writable);
    } else {
      await writable.write(await sourceFile.arrayBuffer());
      await writable.close();
    }
  } catch (error) {
    await writable.abort?.().catch(() => {});
    throw error;
  } finally {
    await dir.removeEntry(tempName).catch(() => {});
  }
}

async function writeTempAndCommit(
  dir: FileSystemDirectoryHandle,
  finalName: string,
  writeCallback: (writable: FileSystemWritableFileStream) => Promise<void>
): Promise<FileSystemFileHandle> {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempName = `${finalName}.${suffix}.tmp`;
  let writable: FileSystemWritableFileStream | null = null;
  try {
    const tempHandle = await dir.getFileHandle(tempName, { create: true });
    writable = await tempHandle.createWritable();
    await writeCallback(writable);
    await writable.close();
    writable = null;
    await commitTempHandle(dir, tempHandle, tempName, finalName);
    return await dir.getFileHandle(finalName);
  } catch (error) {
    if (writable) await writable.abort?.().catch(() => {});
    await dir.removeEntry(tempName).catch(() => {});
    throw error;
  }
}

function enqueueMetaUpdate<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = metaWriteQueues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  const tracked = next.then(() => undefined, () => undefined);
  metaWriteQueues.set(key, tracked);
  tracked.finally(() => {
    if (metaWriteQueues.get(key) === tracked) metaWriteQueues.delete(key);
  });
  return next;
}

async function updateLessonMeta(target: string | VideoTarget, patch: Record<string, any>): Promise<Record<string, any> | null> {
  const key = normalizeLessonKey(target);
  const prefix = lessonFilePrefix(key);
  if (!key || !prefix) return null;
  return enqueueMetaUpdate(key, async () => {
    const dir = await openCacheDir({ create: true });
    if (!dir) return null;
    const names = lessonNames(prefix);
    const existing = (await readJsonFile(dir, names.meta)) || {};
    const { bvid, page } = keyPartsFromPrefix(prefix);
    const next = {
      ...existing,
      ...patch,
      lessonKey: key,
      bvid: existing.bvid || patch.bvid || bvid,
      page: Number(patch.page || existing.page || page) || 1,
      updatedAt: Date.now()
    };
    const encoded = new TextEncoder().encode(JSON.stringify(next));
    await writeTempAndCommit(dir, names.meta, (writable) => writable.write(encoded));
    return next;
  });
}

function cidMatches(metaCid: unknown, expectedCid: unknown): boolean {
  const left = Number(metaCid) || 0;
  const right = Number(expectedCid) || 0;
  return !left || !right || left === right;
}

export async function getCachedAudio(target: string | VideoTarget, { expectedCid = 0 } = {}) {
  const prefix = lessonFilePrefix(target);
  if (!prefix) return null;
  const dir = await openCacheDir({ create: false });
  if (!dir) return null;
  const names = lessonNames(prefix);
  const [file, meta] = await Promise.all([
    getFileIfExists(dir, names.audio),
    readJsonFile(dir, names.meta)
  ]);
  if (!file || file.size < 1024 || !cidMatches(meta?.cid, expectedCid)) return null;
  const mimeType = meta?.audioMime || file.type || "audio/mp4";
  const typedFile = file.type === mimeType ? file : new File([file], `${prefix}.m4a`, { type: mimeType });
  return { file: typedFile, size: file.size, mimeType, meta };
}

export async function putCachedAudio(target: string | VideoTarget, blob: Blob, metaPatch: Record<string, any> = {}) {
  const prefix = lessonFilePrefix(target);
  if (!prefix || !blob || blob.size < 1024) return null;
  const dir = await openCacheDir({ create: true });
  if (!dir) return null;
  const names = lessonNames(prefix);
  await writeTempAndCommit(dir, names.audio, async (writable) => {
    await writable.write(await blob.arrayBuffer());
  });
  return updateLessonMeta(target, {
    ...metaPatch,
    audioBytes: blob.size,
    audioMime: blob.type || metaPatch.audioMime || "audio/mp4"
  });
}

export async function getCachedTranscription(target: string | VideoTarget, { expectedCid = 0 } = {}) {
  const prefix = lessonFilePrefix(target);
  if (!prefix) return null;
  const dir = await openCacheDir({ create: false });
  if (!dir) return null;
  const data = await readJsonFile<{
    cid?: number;
    text?: string;
    segments?: TranscriptSegment[];
    detectedLanguages?: string[];
    manual?: boolean;
  }>(dir, lessonNames(prefix).transcript);
  if (!data || !String(data.text || "").trim() || !cidMatches(data.cid, expectedCid)) return null;
  return data;
}

export async function putCachedTranscription(
  target: string | VideoTarget,
  payload: {
    bvid?: string;
    page?: number;
    cid?: number;
    title?: string;
    part?: string;
    duration?: number;
    text?: string;
    segments?: TranscriptSegment[];
    detectedLanguages?: string[];
    manual?: boolean;
  } = {}
) {
  const key = normalizeLessonKey(target);
  const prefix = lessonFilePrefix(key);
  const text = String(payload?.text || "").trim();
  if (!key || !prefix || !text) return null;
  const dir = await openCacheDir({ create: true });
  if (!dir) return null;
  const names = lessonNames(prefix);
  const { bvid, page } = keyPartsFromPrefix(prefix);
  const record = {
    lessonKey: key,
    bvid: String(payload.bvid || bvid).toUpperCase(),
    page: Number(payload.page || page) || 1,
    cid: Number(payload.cid) || 0,
    title: String(payload.title || ""),
    part: String(payload.part || ""),
    duration: Number(payload.duration) || 0,
    text,
    segments: Array.isArray(payload.segments) ? payload.segments : [],
    detectedLanguages: Array.isArray(payload.detectedLanguages) ? payload.detectedLanguages : [],
    manual: Boolean(payload.manual),
    updatedAt: Date.now()
  };
  const encoded = new TextEncoder().encode(JSON.stringify(record));
  await writeTempAndCommit(dir, names.transcript, (writable) => writable.write(encoded));
  await updateLessonMeta(key, {
    cid: record.cid,
    title: record.title,
    part: record.part,
    duration: record.duration,
    transcriptBytes: encoded.byteLength
  }).catch(() => {});
  return record;
}

export async function getCachedVideo(target: string | VideoTarget, { expectedCid = 0 } = {}) {
  const prefix = lessonFilePrefix(target);
  if (!prefix) return null;
  const dir = await openCacheDir({ create: false });
  if (!dir) return null;
  const names = lessonNames(prefix);
  const [file, meta] = await Promise.all([
    getFileIfExists(dir, names.video),
    readJsonFile(dir, names.meta)
  ]);
  if (!file || file.size < 1024 || !cidMatches(meta?.cid, expectedCid)) return null;
  return { file, size: file.size, mimeType: meta?.videoMime || file.type || "video/mp4", meta };
}

export async function getCachedMuxedVideo(target: string | VideoTarget, { expectedCid = 0 } = {}) {
  const prefix = lessonFilePrefix(target);
  if (!prefix) return null;
  const dir = await openCacheDir({ create: false });
  if (!dir) return null;
  const names = lessonNames(prefix);
  const [file, meta] = await Promise.all([getFileIfExists(dir, names.audiovisual), readJsonFile(dir, names.meta)]);
  if (!file || file.size < 1024 || !cidMatches(meta?.cid, expectedCid)) return null;
  return { file, size: file.size, mimeType: 'video/mp4', meta };
}

export async function putCachedMuxedVideo(target: string | VideoTarget, options: { expectedCid?: number; onProgress?: (fraction: number) => void } = {}) {
  const prefix = lessonFilePrefix(target);
  if (!prefix) throw new Error('无法确定当前分 P。');
  const existing = await getCachedMuxedVideo(target, options);
  if (existing) return existing;
  const dir = await openCacheDir({ create: true });
  if (!dir) throw new Error('浏览器磁盘缓存不可用，无法保存合成视频。');
  const [audio, video] = await Promise.all([
    getCachedAudio(target, { expectedCid: options.expectedCid }),
    getCachedVideo(target, { expectedCid: options.expectedCid })
  ]);
  if (!audio || !video) throw new Error('请先缓存音轨和纯画面，再合成带声音的视频。');
  const names = lessonNames(prefix);
  await writeTempAndCommit(dir, names.audiovisual, (writable) =>
    muxDashTracks(video.file, audio.file, writable, options.onProgress));
  const file = await getFileIfExists(dir, names.audiovisual);
  if (!file || file.size < 1024) throw new Error('合成视频没有成功写入缓存。');
  await updateLessonMeta(target, { cid: Number(options.expectedCid) || Number(video.meta?.cid) || 0, muxedVideoBytes: file.size });
  return { file, size: file.size, mimeType: 'video/mp4', meta: video.meta };
}

export async function downloadAndCacheVideo(
  target: string | VideoTarget,
  videoUrl: string,
  options: {
    maxBytes?: number;
    memoryFallbackBytes?: number;
    expectedCid?: number;
    providerLabel?: string;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number, info: { cached: boolean }) => void;
    meta?: Record<string, any>;
  } = {}
): Promise<{ file: Blob; size: number; cached: boolean; cleanup: () => Promise<void> }> {
  const {
    maxBytes = MAX_VIDEO_BYTES,
    memoryFallbackBytes = MEMORY_FALLBACK_BYTES,
    expectedCid = 0,
    providerLabel = "",
    signal,
    onProgress,
    meta = {}
  } = options;

  const prefix = lessonFilePrefix(target);
  if (prefix) {
    const cached = await getCachedVideo(prefix, { expectedCid });
    if (cached) {
      if (maxBytes && cached.size > maxBytes) {
        const prefixLabel = providerLabel ? `${providerLabel} ` : "";
        throw new Error(`${prefixLabel}视频超过当前上限 ${Math.floor(maxBytes / 1024 / 1024)} MB。`);
      }
      onProgress?.(cached.size, cached.size, { cached: true });
      return { file: cached.file, size: cached.size, cached: true, cleanup: async () => {} };
    }
  }

  if (signal?.aborted) throw new DOMException("已停止生成。", "AbortError");
  if (!isBilibiliCdnUrl(videoUrl, true)) throw new Error("视频流地址无效或不属于 B 站 CDN。");

  const response = await fetch(videoUrl, {
    referrer: "https://www.bilibili.com/",
    credentials: "omit",
    signal
  });
  if (!response.ok) {
    throw new Error(response.status === 403
      ? "B 站 CDN 拒绝下载视频流（403）；签名可能已过期。请刷新播放页后重试。"
      : `下载 B 站视频流失败：HTTP ${response.status}。请刷新视频页后重试。`);
  }
  if (!response.body) throw new Error("浏览器无法读取 B 站视频流。");

  const contentLength = Number(response.headers.get("content-length")) || 0;
  onProgress?.(0, contentLength, { cached: false });

  if (contentLength > maxBytes) {
    await response.body.cancel().catch(() => {});
    const prefixLabel = providerLabel ? `${providerLabel} ` : "";
    throw new Error(`${prefixLabel}视频超过当前文件上限 ${Math.floor(maxBytes / 1024 / 1024)} MB${providerLabel ? "，将改用关键帧分析" : ""}。`);
  }

  let dir = prefix ? await openCacheDir({ create: true }) : null;
  const finalName = prefix ? lessonNames(prefix).video : "";
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempName = dir && finalName ? `${finalName}.${suffix}.tmp` : "";
  let tempHandle: FileSystemFileHandle | null = null;
  let writable: FileSystemWritableFileStream | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const chunks: BlobPart[] = [];

  try {
    if (dir && tempName) {
      try {
        tempHandle = await dir.getFileHandle(tempName, { create: true });
        writable = await tempHandle.createWritable();
      } catch {
        await dir.removeEntry(tempName).catch(() => {});
        dir = null;
        tempHandle = null;
        writable = null;
      }
    }

    if (!writable && contentLength > Math.min(maxBytes, memoryFallbackBytes)) {
      await response.body.cancel().catch(() => {});
      throw new Error("浏览器磁盘缓存不可用；为避免占用过多内存，视频超过 150 MB 时无法缓存或上传。请释放磁盘空间后重试。");
    }

    const downloadLimit = writable ? maxBytes : Math.min(maxBytes, memoryFallbackBytes);
    reader = response.body.getReader();
    let totalBytes = 0;
    let lastProgressBytes = 0;
    let lastProgressAt = Date.now();

    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new DOMException("已停止生成。", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > downloadLimit) {
        await reader.cancel().catch(() => {});
        const prefixLabel = providerLabel ? `${providerLabel} ` : "";
        throw new Error(writable
          ? `${prefixLabel}视频超过当前上限 ${Math.floor(maxBytes / 1024 / 1024)} MB${providerLabel ? "，将改用关键帧分析" : ""}。`
          : "浏览器磁盘缓存不可用，视频超过 150 MB，无法安全读取。");
      }
      if (writable) await writable.write(value);
      else chunks.push(value.slice());

      const now = Date.now();
      if (totalBytes - lastProgressBytes >= 2 * 1024 * 1024 || now - lastProgressAt >= 700) {
        lastProgressBytes = totalBytes;
        lastProgressAt = now;
        onProgress?.(totalBytes, contentLength, { cached: false });
      }
    }

    if (totalBytes < 1024) throw new Error("下载到的 B 站视频流为空或不完整。");

    if (writable && dir && tempHandle) {
      await writable.close();
      writable = null;
      await commitTempHandle(dir, tempHandle, tempName, finalName);
      const finalFile = await (await dir.getFileHandle(finalName)).getFile();
      await updateLessonMeta(prefix, {
        ...meta,
        cid: Number(meta.cid || expectedCid) || 0,
        videoBytes: totalBytes,
        videoMime: response.headers.get("content-type") || "video/mp4"
      }).catch(() => {});
      return { file: finalFile, size: totalBytes, cached: false, cleanup: async () => {} };
    }

    return { file: new Blob(chunks, { type: "video/mp4" }), size: totalBytes, cached: false, cleanup: async () => {} };
  } catch (error) {
    await reader?.cancel?.().catch(() => {});
    if (writable) await writable.abort?.().catch(() => {});
    if (dir && tempName) await dir.removeEntry(tempName).catch(() => {});
    throw error;
  }
}

export async function getLessonCacheStatus(target: string | VideoTarget): Promise<LessonCacheStatus> {
  const key = normalizeLessonKey(target);
  const prefix = lessonFilePrefix(key);
  const sizes = createCacheSizes(key);
  const empty: LessonCacheStatus = { ...sizes, hasAudio: false, hasVideo: false, hasMuxedVideo: false, hasTranscript: false, meta: null };
  if (!key || !prefix) return empty;
  const dir = await openCacheDir({ create: false });
  if (!dir) return empty;

  const names = lessonNames(prefix);
  const [audioFile, videoFile, muxedFile, transcriptFile, metaFile] = await Promise.all([
    getFileIfExists(dir, names.audio),
    getFileIfExists(dir, names.video),
    getFileIfExists(dir, names.audiovisual),
    getFileIfExists(dir, names.transcript),
    getFileIfExists(dir, names.meta)
  ]);

  let meta: Record<string, any> | null = null;
  if (metaFile) {
    try { meta = JSON.parse(await metaFile.text()); } catch { meta = null; }
  }
  if (audioFile && audioFile.size >= 1024) addCacheSize(sizes, "audio.bin", audioFile.size);
  if (videoFile && videoFile.size >= 1024) addCacheSize(sizes, "video.mp4", videoFile.size);
  if (muxedFile && muxedFile.size >= 1024) addCacheSize(sizes, "audiovisual.mp4", muxedFile.size);
  if (transcriptFile) addCacheSize(sizes, "transcript.json", transcriptFile.size);
  if (metaFile) addCacheSize(sizes, "meta.json", metaFile.size);
  return {
    ...sizes,
    hasAudio: sizes.audioBytes > 0,
    hasVideo: sizes.videoBytes > 0,
    hasMuxedVideo: sizes.muxedVideoBytes > 0,
    hasTranscript: sizes.transcriptBytes > 0,
    meta
  };
}

export async function listAllLessonOpfsCaches() {
  const lessons = new Map<string, CacheSizes>();
  const totals = createCacheSizes("");
  const dir = await openCacheDir({ create: false });
  if (!dir) return { lessonCount: 0, ...totals, lessons };

  const now = Date.now();
  for await (const [name, handle] of (dir as FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind !== "file") continue;
    const fileHandle = handle as FileSystemFileHandle;
    if (name.endsWith(".tmp")) {
      const file = await fileHandle.getFile().catch(() => null);
      if (file && now - (Number(file.lastModified) || 0) > ORPHAN_TMP_AGE_MS) {
        await dir.removeEntry(name).catch(() => {});
      }
      continue;
    }
    const match = name.match(/^(BV[0-9A-Za-z]+_p\d+)\.(audio\.bin|video\.mp4|audiovisual\.mp4|transcript\.json|meta\.json)$/i);
    if (!match) continue;
    const { lessonKey } = keyPartsFromPrefix(match[1]!);
    if (!lessonKey) continue;
    const file = await fileHandle.getFile().catch(() => null);
    const size = file ? file.size : 0;
    const kind = match[2]!.toLowerCase() as CacheKind;
    let entry = lessons.get(lessonKey);
    if (!entry) {
      entry = createCacheSizes(lessonKey);
      lessons.set(lessonKey, entry);
    }
    addCacheSize(entry, kind, size);
    addCacheSize(totals, kind, size);
  }
  return {
    ...totals,
    lessonCount: [...lessons.values()].filter((item) => item.opfsBytes > 0).length,
    lessons
  };
}

export async function clearLessonOpfsCache(target: string | VideoTarget): Promise<{ freedBytes: number }> {
  const prefix = lessonFilePrefix(target);
  if (!prefix) return { freedBytes: 0 };
  const dir = await openCacheDir({ create: false });
  if (!dir) return { freedBytes: 0 };

  let freedBytes = 0;
  const toRemove: string[] = [];
  for await (const [name, handle] of (dir as FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind !== "file" || !name.startsWith(`${prefix}.`)) continue;
    const file = await (handle as FileSystemFileHandle).getFile().catch(() => null);
    if (file) freedBytes += file.size;
    toRemove.push(name);
  }
  for (const name of toRemove) await dir.removeEntry(name).catch(() => {});
  return { freedBytes };
}

export async function clearAllLessonOpfsCaches(): Promise<{ freedBytes: number }> {
  let freedBytes = 0;
  if (!globalThis.navigator?.storage?.getDirectory) return { freedBytes: 0 };
  try {
    const root = await globalThis.navigator.storage.getDirectory() as FileSystemDirectoryHandle & {
      entries(): AsyncIterable<[string, FileSystemHandle]>;
    };
    const dir = await openCacheDir({ create: false }) as (FileSystemDirectoryHandle & {
      entries(): AsyncIterable<[string, FileSystemHandle]>;
    }) | null;
    if (dir) {
      for await (const [, handle] of dir.entries()) {
        if (handle.kind !== "file") continue;
        const file = await (handle as FileSystemFileHandle).getFile().catch(() => null);
        if (file) freedBytes += file.size;
      }
      await root.removeEntry(CACHE_DIR_NAME, { recursive: true }).catch(() => {});
    }
    // Also clean any leftover legacy root temporary video captures if present.
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "file" || !/^keji-(?:video|capture)-.*\.mp4$/i.test(name)) continue;
      const file = await (handle as FileSystemFileHandle).getFile().catch(() => null);
      if (file) freedBytes += file.size;
      await root.removeEntry(name).catch(() => {});
    }
  } catch {
    return { freedBytes };
  }
  return { freedBytes };
}
