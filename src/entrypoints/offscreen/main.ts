import {
  estimateAsrMaxTokens,
  planSpeechChunks,
  requestAsr,
  splitTextToTimedSegments,
  type AsrEndpointSettings,
} from "../../lib/asr.ts";
import { Keji, type TranscriptSegment, type VideoTarget } from "../../lib/keji.ts";
import { getCachedAudio, putCachedAudio } from "../../lib/lesson-cache.ts";

interface DirectTask {
  id?: string;
  controller: AbortController;
  cancelled: boolean;
}

interface AudioSourcePayload {
  url?: string;
  backupUrls?: string[];
  duration?: number;
  bvid?: string;
  page?: number;
  part?: string;
  expectedCid?: number;
}

interface DecodedLessonAudio {
  key: string;
  buffer: AudioBuffer;
  channels: Float32Array[];
  expiresAt: number;
  fromCache: boolean;
}

let directTask: DirectTask | null = null;
let decodedLessonAudioCache: DecodedLessonAudio | null = null;
let decodedLessonAudioTimer: ReturnType<typeof setTimeout> | 0 = 0;
let pendingLessonAudio: { key: string; promise: Promise<DecodedLessonAudio>; controller: AbortController } | null = null;

function clearDecodedLessonAudio(): void {
  clearTimeout(decodedLessonAudioTimer);
  decodedLessonAudioTimer = 0;
  decodedLessonAudioCache = null;
  if (pendingLessonAudio) {
    pendingLessonAudio.controller.abort();
    pendingLessonAudio = null;
  }
}

function refreshDecodedLessonAudioTtl(entry: DecodedLessonAudio): void {
  clearTimeout(decodedLessonAudioTimer);
  entry.expiresAt = Date.now() + 10 * 60 * 1000;
  decodedLessonAudioTimer = setTimeout(() => {
    decodedLessonAudioCache = null;
    decodedLessonAudioTimer = 0;
  }, 10 * 60 * 1000);
}

async function getOrDecodeLessonAudio(message: any): Promise<DecodedLessonAudio> {
  const bvid = String(message.bvid || message.video?.bvid || message.audioSource?.bvid || "").trim().toUpperCase();
  const page = Math.max(1, Number(message.page || message.video?.page || message.audioSource?.page) || 1);
  const expectedCid = Number(message.cid || message.video?.cid || message.audioSource?.expectedCid) || 0;
  const videoUrl = String(message.videoUrl || message.video?.url || "");
  const key = `${bvid}:${page}:${expectedCid}`;
  if (decodedLessonAudioCache?.key === key && decodedLessonAudioCache.expiresAt > Date.now()) {
    refreshDecodedLessonAudioTtl(decodedLessonAudioCache);
    return decodedLessonAudioCache;
  }
  if (pendingLessonAudio?.key === key) return pendingLessonAudio.promise;

  const controller = new AbortController();
  const promise = (async (): Promise<DecodedLessonAudio> => {
    const lessonTarget: VideoTarget = { bvid, page, url: videoUrl };
    const cachedAudio = await getCachedAudio(lessonTarget, { expectedCid });
    let audioBlob: Blob | null = cachedAudio?.file || null;
    if (!audioBlob) {
      if (!message.audioSource?.url) throw new Error("本机没有缓存该分 P 音轨，且无法读取在线音轨。");
      audioBlob = await downloadAudio(message.audioSource, videoUrl, { controller, cancelled: false }, false);
      await putCachedAudio(lessonTarget, audioBlob, {
        cid: expectedCid,
        title: message.video?.title || "",
        part: message.video?.part || message.audioSource?.part || "",
        url: videoUrl,
        duration: Number(message.audioSource?.duration || message.video?.duration) || 0
      }).catch(() => {});
    }
    const buffer = await decodeAudio(audioBlob);
    const entry: DecodedLessonAudio = {
      key,
      buffer,
      channels: getChannels(buffer),
      expiresAt: Date.now() + 10 * 60 * 1000,
      fromCache: Boolean(cachedAudio)
    };
    decodedLessonAudioCache = entry;
    refreshDecodedLessonAudioTtl(entry);
    return entry;
  })();

  pendingLessonAudio = { key, promise, controller };
  try {
    return await promise;
  } finally {
    if (pendingLessonAudio?.promise === promise) pendingLessonAudio = null;
  }
}

function assertIdle(busyMessage = "已有一项音频转写正在运行。"): void {
  if (directTask) throw new Error(busyMessage);
}

function getChannels(audioBuffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: audioBuffer.numberOfChannels }, (_, index) => audioBuffer.getChannelData(index));
}

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "START_DIRECT_AUDIO_TRANSCRIPTION") {
    startDirectTranscription(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message || "启动快速音轨转写失败。" }));
    return true;
  }
  if (message.type === "RETRANSCRIBE_AUDIO_RANGE") {
    retranscribeAudioRange(message)
      .then((segments) => sendResponse({ ok: true, segments }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message || "重新识别失败。" }));
    return true;
  }
  if (message.type === "PREPARE_LESSON_AUDIO") {
    getOrDecodeLessonAudio(message)
      .then((prepared) => sendResponse({ ok: true, duration: prepared.buffer.duration, fromCache: prepared.fromCache }))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message || "准备音轨失败。" }));
    return true;
  }
  if (message.type === "CACHE_LESSON_AUDIO") {
    (async () => {
      assertIdle('转写正在运行，请等待完成后再准备媒体文件。');
      const bvid = String(message.bvid || '').toUpperCase();
      const page = Math.max(1, Number(message.page) || 1);
      const expectedCid = Number(message.cid) || 0;
      const target: VideoTarget = { bvid, page, url: String(message.videoUrl || '') };
      const cached = await getCachedAudio(target, { expectedCid });
      if (cached) return { ok: true, size: cached.size, fromCache: true };
      const blob = await downloadAudio(message.audioSource, target.url || '', { controller: new AbortController(), cancelled: false }, false);
      await putCachedAudio(target, blob, {
        cid: expectedCid, title: message.video?.title || '', part: message.video?.part || '',
        duration: Number(message.audioSource?.duration || message.video?.duration) || 0
      });
      const saved = await getCachedAudio(target, { expectedCid });
      if (!saved) throw new Error('音轨下载完成，但无法写入浏览器缓存。');
      return { ok: true, size: saved.size, fromCache: false };
    })().then(sendResponse).catch((error: Error) => sendResponse({ ok: false, error: error.message || '缓存音轨失败。' }));
    return true;
  }
  if (message.type === "ENCODE_AUDIO_WAV_CHUNK") {
    getOrDecodeLessonAudio(message)
      .then(async (decoded) => {
        const start = Math.max(0, Number(message.start) || 0);
        const rawEnd = Number(message.end);
        const end = Math.min(decoded.buffer.duration, rawEnd > start ? rawEnd : decoded.buffer.duration);
        if (end <= start) throw new Error("无法裁剪音频分片。");
        const wavBlob = encodeWavChunk(decoded.buffer, decoded.channels, start, end);
        const wavBase64 = Keji.bytesToBase64(new Uint8Array(await wavBlob.arrayBuffer()));
        return { ok: true, wavBase64 };
      })
      .then(sendResponse)
      .catch((error: Error) => sendResponse({ ok: false, error: error.message || "编码音频分片失败。" }));
    return true;
  }
  if (message.type === "RELEASE_LESSON_AUDIO") {
    clearDecodedLessonAudio();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "STOP_AUDIO_CAPTURE") {
    if (directTask) {
      directTask.cancelled = true;
      directTask.controller.abort();
    }
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

async function startDirectTranscription(message: any): Promise<void> {
  assertIdle();
  const task: DirectTask = { id: message.taskId, controller: new AbortController(), cancelled: false };
  directTask = task;
  void runDirectTranscription(message, task);
}

async function runDirectTranscription(message: { video?: VideoTarget; audioSource?: AudioSourcePayload; settings: AsrEndpointSettings }, task: DirectTask): Promise<void> {
  try {
    const lessonTarget: VideoTarget = {
      bvid: message.video?.bvid || message.audioSource?.bvid || "",
      url: message.video?.url || "",
      page: message.video?.page || message.audioSource?.page || 1
    };
    const expectedCid = message.video?.cid || message.audioSource?.expectedCid || 0;
    const cachedAudio = await getCachedAudio(lessonTarget, { expectedCid });
    let audioBlob: Blob | null = cachedAudio?.file || null;

    if (!audioBlob) {
      await sendToBackground("TRANSCRIPTION_PROGRESS", {
        state: { status: "downloading", phase: "download", downloadBytes: 0, downloadTotal: 0, fromCache: false }
      });
      audioBlob = await downloadAudio(message.audioSource || {}, message.video?.url || "", task);
      if (task.cancelled) throw new DOMException("已停止转写。", "AbortError");
      await putCachedAudio(lessonTarget, audioBlob, {
        cid: expectedCid,
        title: message.video?.title || "",
        part: message.video?.part || message.audioSource?.part || "",
        url: message.video?.url || "",
        duration: Number(message.audioSource?.duration || message.video?.duration) || 0
      }).catch(() => {});
    }
    if (task.cancelled) throw new DOMException("已停止转写。", "AbortError");

    await sendToBackground("TRANSCRIPTION_PROGRESS", {
      state: {
        status: "transcribing",
        phase: "decode",
        fromCache: Boolean(cachedAudio),
        downloadedBytes: audioBlob.size,
        downloadTotal: audioBlob.size,
        currentTime: 0
      }
    });
    const duration = await transcribeAudioInChunks(audioBlob, message.settings, task);
    await sendToBackground("TRANSCRIPTION_DONE", {
      state: { status: "done", currentTime: duration, duration }
    });
  } catch (error) {
    const err = error as Error;
    const cancelled = task.cancelled || err?.name === "AbortError";
    await sendToBackground("TRANSCRIPTION_ERROR", {
      error: cancelled ? "已停止转写。" : err.message || "快速音轨转写失败。",
      state: { status: cancelled ? "cancelled" : "error" }
    }).catch(() => {});
  } finally {
    if (directTask === task) directTask = null;
    if (!directTask) clearDecodedLessonAudio();
  }
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

async function transcribeAudioInChunks(blob: Blob, settings: AsrEndpointSettings, task: DirectTask): Promise<number> {
  const audioBuffer = await decodeAudio(blob);
  const duration = audioBuffer.duration;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取音轨时长。");
  const channels = getChannels(audioBuffer);
  const ranges = planSpeechChunks(channels, audioBuffer.sampleRate, duration);
  if (!ranges.length) throw new Error("无法读取音轨时长。");
  const chunksTotal = ranges.length;
  const halfOverlap = 0.5;
  const concurrency = isLoopbackEndpoint(settings.endpoint) ? 1 : Math.min(3, chunksTotal);

  const completed = new Map<number, { rawText: string; language: string }>();
  let nextIndex = 0;
  let nextToCommit = 0;
  let chunksDone = 0;
  let foundText = false;
  let previousText = "";
  let commitQueue = Promise.resolve();
  let firstError: Error | null = null;

  await sendToBackground("TRANSCRIPTION_PROGRESS", {
    state: { status: "transcribing", phase: "segments", chunksDone: 0, chunksTotal, duration }
  });

  const enqueueCommit = () => {
    commitQueue = commitQueue.then(async () => {
      while (completed.has(nextToCommit)) {
        const range = ranges[nextToCommit]!;
        const { rawText, language } = completed.get(nextToCommit)!;
        completed.delete(nextToCommit);
        const text = range.padPrev && previousText
          ? Keji.dedupeTranscriptOverlap(previousText, rawText)
          : rawText;
        previousText = range.padNext ? rawText : "";
        if (text) {
          const fineSegments = splitTextToTimedSegments(text, range.start, range.end, language);
          if (fineSegments.length) {
            foundText = true;
            await sendToBackground("TRANSCRIPTION_SEGMENTS", {
              segments: fineSegments,
              languages: language ? [language] : []
            });
          }
        }
        nextToCommit += 1;
      }
    });
    return commitQueue;
  };

  const runWorker = async () => {
    while (true) {
      if (task.cancelled || firstError) return;
      const index = nextIndex;
      if (index >= chunksTotal) return;
      nextIndex += 1;

      const range = ranges[index]!;
      const audioStart = range.padPrev ? Math.max(0, range.start - halfOverlap) : range.start;
      const audioEnd = range.padNext ? Math.min(duration, range.end + halfOverlap) : range.end;
      try {
        const wavChunk = encodeWavChunk(audioBuffer, channels, audioStart, audioEnd);
        const asrResult = await requestAsr(
          new Uint8Array(await wavChunk.arrayBuffer()),
          settings,
          task.controller.signal,
          { maxTokens: estimateAsrMaxTokens(audioEnd - audioStart) }
        );
        if (task.cancelled) return;
        completed.set(index, { rawText: asrResult.text, language: asrResult.language });
        chunksDone += 1;
        await enqueueCommit();
        await sendToBackground("TRANSCRIPTION_PROGRESS", {
          state: { status: "transcribing", phase: "segments", chunksDone, chunksTotal, duration }
        });
      } catch (error) {
        if (!firstError) {
          firstError = task.cancelled
            ? (new DOMException("已停止转写。", "AbortError") as unknown as Error)
            : new Error(`第 ${index + 1}/${chunksTotal} 段转写失败：${(error as Error).message || "语音识别接口错误"}`);
          task.controller.abort();
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  await commitQueue;
  if (task.cancelled) throw new DOMException("已停止转写。", "AbortError");
  if (firstError) throw firstError;
  if (!foundText) throw new Error("语音识别接口返回成功，但没有识别到文字。");
  return duration;
}

async function retranscribeAudioRange(message: any): Promise<TranscriptSegment[]> {
  assertIdle("当前已有音频转写任务正在运行。");
  const task: DirectTask = { controller: new AbortController(), cancelled: false };
  directTask = task;
  try {
    const start = Number(message.start);
    const end = Number(message.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 60) {
      throw new Error("所选音频范围无效；单次重识别最多支持 60 秒。");
    }
    const decoded = await getOrDecodeLessonAudio(message);
    const clampedEnd = Math.min(decoded.buffer.duration, end);
    if (clampedEnd <= start) throw new Error("无法裁剪所选音频范围。");
    const wavChunk = encodeWavChunk(decoded.buffer, decoded.channels, start, clampedEnd);
    const { text, language } = await requestAsr(
      new Uint8Array(await wavChunk.arrayBuffer()),
      message.settings,
      task.controller.signal,
      { maxTokens: estimateAsrMaxTokens(clampedEnd - start) }
    );
    return splitTextToTimedSegments(text, start, clampedEnd, language);
  } finally {
    if (directTask === task) directTask = null;
  }
}

async function decodeAudio(blob: Blob): Promise<AudioBuffer> {
  const Context = globalThis.AudioContext || (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) throw new Error("当前浏览器不支持音轨解码。");
  const audioContext = new Context({ sampleRate: 16000 });
  try {
    const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    if (audioBuffer.sampleRate !== 16000) throw new Error("浏览器没有按 16 kHz 解码音轨。");
    return audioBuffer;
  } finally {
    await audioContext.close().catch(() => {});
  }
}

function encodeWavChunk(audioBuffer: AudioBuffer, channels: Float32Array[], startSeconds: number, endSeconds: number): Blob {
  const sampleRate = audioBuffer.sampleRate;
  const startFrame = Math.max(0, Math.floor(startSeconds * sampleRate));
  const endFrame = Math.min(audioBuffer.length, Math.floor(endSeconds * sampleRate));
  const frameCount = Math.max(0, endFrame - startFrame);
  const dataBytes = frameCount * 2;
  const output = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(output);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataBytes, true);
  const samples = new Int16Array(output, 44);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let mono = 0;
    for (const channel of channels) mono += channel[startFrame + frame] || 0;
    mono /= channels.length || 1;
    const clipped = Math.max(-1, Math.min(1, mono));
    samples[frame] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
  }
  return new Blob([output], { type: "audio/wav" });
}

async function downloadAudio(audioSource: AudioSourcePayload, videoUrl: string, task: DirectTask, reportProgress = true): Promise<Blob> {
  const candidates = [audioSource.url, ...(audioSource.backupUrls || [])].filter((u): u is string => Boolean(u));
  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        signal: task.controller.signal,
        referrer: videoUrl,
        referrerPolicy: "strict-origin-when-cross-origin",
        credentials: "omit"
      });
      if (!response.ok) throw new Error(`下载 B 站音轨失败（HTTP ${response.status}）。`);
      if (!response.body) return await response.blob();

      const total = Number(response.headers.get("content-length")) || 0;
      const reader = response.body.getReader();
      const chunks: BlobPart[] = [];
      let loaded = 0;
      let lastReportedAt = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value.slice());
        loaded += value.byteLength;
        const now = Date.now();
        if (reportProgress && now - lastReportedAt > 700) {
          lastReportedAt = now;
          await sendToBackground("TRANSCRIPTION_PROGRESS", {
            state: { status: "downloading", phase: "download", downloadBytes: loaded, downloadTotal: total }
          });
        }
      }
      if (loaded < 1024) throw new Error("下载到的 B 站音轨为空或不完整。");
      return new Blob(chunks, { type: "audio/mp4" });
    } catch (error) {
      if (task.controller.signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("没有可用的 B 站音轨地址。");
}

function sendToBackground(type: string, payload: Record<string, unknown> = {}) {
  const taskId = directTask?.id;
  return chrome.runtime.sendMessage({ target: "background", type, ...payload, ...(taskId ? { taskId } : {}) });
}
