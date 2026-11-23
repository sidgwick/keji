import { Keji, type TranscriptSegment, type VideoTarget } from "../../lib/keji.ts";
import { getCachedAudio, putCachedAudio } from "../../lib/lesson-cache.ts";

interface TranscriptionEndpointSettings {
  endpoint: string;
  endpoints?: string[];
  model: string;
  apiKey?: string;
  language?: string;
  prompt?: string;
  transcriptionConcurrency?: number;
}

interface TranscriptionApiSegment {
  start?: number;
  end?: number;
  text?: string;
  language?: string;
  lang?: string;
}

interface TranscriptionApiResult {
  text?: string;
  language?: string;
  languages?: Array<string | { code?: string }>;
  segments?: TranscriptionApiSegment[];
  error?: { message?: string };
  message?: string;
}

interface DirectTask {
  id?: string;
  controller: AbortController;
  cancelled: boolean;
  failure?: string;
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
let retryClipCache: { key: string; blob: Blob; audioStart: number; audioEnd: number; expiresAt: number } | null = null;
let retryClipCacheTimer: ReturnType<typeof setTimeout> | 0 = 0;
let decodedLessonAudioCache: DecodedLessonAudio | null = null;
let decodedLessonAudioTimer: ReturnType<typeof setTimeout> | 0 = 0;
let pendingLessonAudio: { key: string; promise: Promise<DecodedLessonAudio>; controller: AbortController } | null = null;

function clearDecodedLessonAudio(): void {
  clearTimeout(decodedLessonAudioTimer);
  decodedLessonAudioTimer = 0;
  decodedLessonAudioCache = null;
  clearTimeout(retryClipCacheTimer);
  retryClipCacheTimer = 0;
  retryClipCache = null;
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

async function runDirectTranscription(message: { video?: VideoTarget; audioSource?: AudioSourcePayload; settings: TranscriptionEndpointSettings }, task: DirectTask): Promise<void> {
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
    const fallbackDuration = Number(message.audioSource?.duration || message.video?.duration || cachedAudio?.meta?.duration) || 0;
    const duration = await transcribeAudioInChunks(audioBlob, message.settings, task, fallbackDuration);
    await sendToBackground("TRANSCRIPTION_DONE", {
      state: { status: "done", currentTime: duration, duration }
    });
  } catch (error) {
    const err = error as Error;
    const cancelled = task.cancelled || err?.name === "AbortError";
    await sendToBackground("TRANSCRIPTION_ERROR", {
      error: cancelled ? "已停止转写。" : task.failure || err.message || "快速音轨转写失败。",
      state: { status: cancelled ? "cancelled" : "error" }
    }).catch(() => {});
  } finally {
    if (directTask === task) directTask = null;
  }
}

async function transcribeAudioInChunks(blob: Blob, settings: TranscriptionEndpointSettings, task: DirectTask, fallbackDuration = 0): Promise<number> {
  let audioBuffer: AudioBuffer;
  try {
    audioBuffer = await decodeAudio(blob);
  } catch {
    await sendToBackground("TRANSCRIPTION_PROGRESS", {
      state: { status: "transcribing", phase: "whole-file", chunksDone: 0, chunksTotal: 1 }
    });
    const result = await sendAudioToTranscriptionEndpoints(blob, settings, {
      filename: "keji-audio.m4a",
      signal: task.controller.signal,
      singleEndpointOnly: true,
      msg413: "语音识别服务拒绝了这段音轨，文件可能超过该服务的大小限制。请改用支持长音频或本机的 Whisper 服务。"
    });
    const segments = extractSegments(result, 0, 0);
    if (!segments.length) throw new Error("语音识别接口返回成功，但没有识别到文字。");
    await sendToBackground("TRANSCRIPTION_SEGMENTS", { segments, languages: getDetectedLanguages(result) });
    return Number(fallbackDuration) || 0;
  }

  const duration = audioBuffer.duration;
  const chunkSeconds = 180;
  const overlapSeconds = 1.5;
  const chunksTotal = Math.ceil(duration / chunkSeconds);
  const channels = getChannels(audioBuffer);
  const endpoints = Array.isArray(settings.endpoints) && settings.endpoints.length ? settings.endpoints : [settings.endpoint];
  const requestedConcurrency = Number(settings.transcriptionConcurrency) || 0;
  const concurrency = Math.max(1, Math.min(4, requestedConcurrency || (endpoints.length > 1 ? endpoints.length : 1)));
  let nextIndex = 0;
  let chunksDone = 0;
  let foundText = false;
  let failure = "";

  await sendToBackground("TRANSCRIPTION_PROGRESS", {
    state: { status: "transcribing", phase: "segments", chunksDone, chunksTotal, duration }
  });

  async function worker() {
    while (!failure && !task.cancelled) {
      const index = nextIndex++;
      if (index >= chunksTotal) return;
      const coreStart = index * chunkSeconds;
      const coreEnd = Math.min(duration, coreStart + chunkSeconds);
      const audioStart = Math.max(0, coreStart - overlapSeconds);
      const audioEnd = Math.min(duration, coreEnd + overlapSeconds);
      try {
        const audioChunk = encodeWavChunk(audioBuffer, channels, audioStart, audioEnd);
        const result = await sendAudioToTranscriptionEndpoints(audioChunk, settings, {
          filename: `keji-audio-${String(index + 1).padStart(3, "0")}.wav`,
          signal: task.controller.signal,
          startIndex: index
        });
        const segments = extractSegments(result, audioStart, coreStart, { minMid: coreStart, maxMid: coreEnd });
        if (segments.length) {
          foundText = true;
          await sendToBackground("TRANSCRIPTION_SEGMENTS", { segments, languages: getDetectedLanguages(result) });
        }
        chunksDone += 1;
        await sendToBackground("TRANSCRIPTION_PROGRESS", {
          state: { status: "transcribing", phase: "segments", chunksDone, chunksTotal, duration }
        });
      } catch (error) {
        if (task.cancelled || task.failure) return;
        failure = `第 ${index + 1}/${chunksTotal} 段转写失败：${(error as Error).message || "语音识别接口错误"}`;
        task.failure = failure;
        task.controller.abort();
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, chunksTotal) }, () => worker()));
  if (task.cancelled) throw new DOMException("已停止转写。", "AbortError");
  if (failure) throw new Error(failure);
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
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 180) {
      throw new Error("所选音频范围无效；单次重识别最多支持 3 分钟。");
    }
    const cacheKey = `${String(message.bvid || "").toUpperCase()}:${Number(message.page) || 1}:${start.toFixed(2)}:${end.toFixed(2)}`;
    const cacheHit = retryClipCache?.key === cacheKey && retryClipCache.expiresAt > Date.now();
    let audioBuffer: AudioBuffer;
    let bufferOrigin: number;
    let audioStart: number;
    let audioEnd: number;
    let chunk: Blob;
    if (cacheHit && retryClipCache) {
      audioBuffer = await decodeAudio(retryClipCache.blob);
      bufferOrigin = retryClipCache.audioStart;
      audioStart = retryClipCache.audioStart;
      audioEnd = retryClipCache.audioEnd;
      chunk = retryClipCache.blob;
      cacheRetryClip(cacheKey, chunk, audioStart, audioEnd);
    } else {
      const lessonTarget: VideoTarget = { bvid: message.bvid, page: message.page, url: message.videoUrl };
      const cachedAudio = await getCachedAudio(lessonTarget);
      let audioBlob: Blob | null = cachedAudio?.file || null;
      if (!audioBlob) {
        if (!message.audioSource?.url) throw new Error("本机没有缓存该分 P 音轨，且无法读取在线音轨。");
        audioBlob = await downloadAudio(message.audioSource, message.videoUrl, task, false);
        await putCachedAudio(lessonTarget, audioBlob, {
          cid: message.audioSource?.expectedCid || 0,
          part: message.audioSource?.part || "",
          url: message.videoUrl || "",
          duration: Number(message.audioSource?.duration) || 0
        }).catch(() => {});
      }
      audioBuffer = await decodeAudio(audioBlob);
      bufferOrigin = 0;
      audioStart = Math.max(0, start - 4);
      audioEnd = Math.min(audioBuffer.duration, end + 4);
      if (audioEnd <= audioStart) throw new Error("无法裁剪所选音频范围。");
      chunk = encodeWavChunk(audioBuffer, getChannels(audioBuffer), audioStart, audioEnd);
      cacheRetryClip(cacheKey, chunk, audioStart, audioEnd);
    }

    const requestOptions = { filename: "keji-audio-001.wav", signal: task.controller.signal };
    let result = await sendAudioToTranscriptionEndpoints(chunk, message.settings, requestOptions);
    let responseOffset = audioStart;
    const rawSegments = Array.isArray(result?.segments) ? result.segments : [];
    if (!rawSegments.length && String(result?.text || "").trim() && (audioStart < start || audioEnd > end)) {
      const exactChunk = encodeWavChunk(audioBuffer, getChannels(audioBuffer), start - bufferOrigin, end - bufferOrigin);
      result = await sendAudioToTranscriptionEndpoints(exactChunk, message.settings, requestOptions);
      responseOffset = start;
    }
    return extractSegments(result, responseOffset, responseOffset, {
      minMid: start,
      maxMid: end,
      inclusiveMax: true,
      preferAllIfEmpty: true,
      fallbackEnd: responseOffset === start ? end : audioEnd
    });
  } finally {
    if (directTask === task) directTask = null;
  }
}

function cacheRetryClip(key: string, blob: Blob, audioStart: number, audioEnd: number): void {
  clearTimeout(retryClipCacheTimer);
  retryClipCache = { key, blob, audioStart, audioEnd, expiresAt: Date.now() + 5 * 60 * 1000 };
  retryClipCacheTimer = setTimeout(() => {
    retryClipCache = null;
    retryClipCacheTimer = 0;
  }, 5 * 60 * 1000);
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

function getDetectedLanguages(result: TranscriptionApiResult | null): string[] {
  const detected = [result?.language, ...(Array.isArray(result?.languages) ? result.languages : [])]
    .map((item) => typeof item === "string" ? item : item?.code)
    .map((language) => String(language || "").trim())
    .filter(Boolean);
  return [...new Set(detected)];
}

function mapRawSegments(rawSegments: TranscriptionApiSegment[] | undefined, offsetSeconds = 0, fallbackLanguage = ""): TranscriptSegment[] {
  const offset = Math.max(0, Number(offsetSeconds) || 0);
  return (Array.isArray(rawSegments) ? rawSegments : [])
    .filter((segment) => String(segment?.text || "").trim())
    .map((segment) => {
      const localStart = Math.max(0, Number(segment.start) || 0);
      const localEnd = Math.max(localStart, Number(segment.end) || localStart);
      const language = String(segment.language || segment.lang || fallbackLanguage || "").trim();
      return {
        time: offset + localStart,
        end: offset + localEnd,
        text: String(segment.text).trim(),
        ...(language ? { language } : {})
      };
    });
}

function extractSegments(
  result: TranscriptionApiResult | null,
  offsetSeconds: number,
  fallbackStart: number,
  options: { minMid?: number; maxMid?: number; inclusiveMax?: boolean; preferAllIfEmpty?: boolean; fallbackEnd?: number } = {}
): TranscriptSegment[] {
  const language = getDetectedLanguages(result)[0] || "";
  const mapped = mapRawSegments(result?.segments, offsetSeconds, language);
  let segments = options.minMid !== undefined && options.maxMid !== undefined
    ? mapped.filter((segment) => {
      const midpoint = (segment.time + (segment.end ?? segment.time)) / 2;
      return midpoint >= options.minMid! && (options.inclusiveMax ? midpoint <= options.maxMid! : midpoint < options.maxMid!);
    })
    : mapped;
  if (!segments.length && options.preferAllIfEmpty && mapped.length) segments = mapped;
  const text = String(result?.text || "").trim();
  if (!segments.length && text) {
    segments.push({
      time: Math.max(0, fallbackStart),
      ...(options.fallbackEnd !== undefined ? { end: options.fallbackEnd } : {}),
      text,
      ...(language ? { language } : {})
    });
  }
  return segments;
}

async function requestTranscriptionEndpoint(
  endpoint: string,
  blob: Blob,
  filename: string,
  settings: TranscriptionEndpointSettings,
  signal?: AbortSignal
): Promise<{ response: Response; result: TranscriptionApiResult | null }> {
  const headers: Record<string, string> = {};
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  const send = async (responseFormat: string, includeTimestamps: boolean) => {
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model", settings.model);
    form.append("response_format", responseFormat);
    if (settings.language) form.append("language", settings.language);
    if (settings.prompt) form.append("prompt", settings.prompt);
    if (includeTimestamps) form.append("timestamp_granularities[]", "segment");
    const response = await fetch(endpoint, { method: "POST", headers, body: form, ...(signal ? { signal } : {}) });
    const result = await response.json().catch(() => null) as TranscriptionApiResult | null;
    return { response, result };
  };
  let { response, result } = await send("verbose_json", true);
  if (!response.ok && /response_format|timestamp_granularities|verbose_json/i.test(result?.error?.message || "")) {
    ({ response, result } = await send("json", false));
  }
  return { response, result };
}

async function sendAudioToTranscriptionEndpoints(
  blob: Blob,
  settings: TranscriptionEndpointSettings,
  options: { filename: string; signal?: AbortSignal; startIndex?: number; singleEndpointOnly?: boolean; msg413?: string }
): Promise<TranscriptionApiResult> {
  const endpoints = options.singleEndpointOnly
    ? [settings.endpoint]
    : (Array.isArray(settings.endpoints) && settings.endpoints.length ? settings.endpoints : [settings.endpoint]);
  const firstEndpoint = (options.startIndex || 0) % endpoints.length;
  const orderedEndpoints = endpoints.map((_, offset) => endpoints[(firstEndpoint + offset) % endpoints.length]!);

  if (options.singleEndpointOnly) {
    const { response, result } = await requestTranscriptionEndpoint(orderedEndpoints[0]!, blob, options.filename, settings, options.signal);
    if (!response.ok) {
      const detail = result?.error?.message || result?.message || `HTTP ${response.status}`;
      if (response.status === 413 && options.msg413) throw new Error(options.msg413);
      throw new Error(`语音识别接口错误：${detail}`);
    }
    if (!result || typeof result !== "object") throw new Error("服务返回了无效的 JSON 响应。");
    return result;
  }

  const failures: string[] = [];
  for (let endpointIndex = 0; endpointIndex < orderedEndpoints.length; endpointIndex += 1) {
    try {
      const { response, result } = await requestTranscriptionEndpoint(orderedEndpoints[endpointIndex]!, blob, options.filename, settings, options.signal);
      if (!response.ok) {
        const detail = result?.error?.message || result?.message || `HTTP ${response.status}`;
        throw new Error(response.status === 413 ? "服务拒绝了 WAV 分段文件，可能不支持此格式或文件大小。" : detail);
      }
      if (!result || typeof result !== "object") throw new Error("服务返回了无效的 JSON 响应。");
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failures.push(`API ${((firstEndpoint + endpointIndex) % endpoints.length) + 1}：${(error as Error).message || "请求失败"}`);
    }
  }
  throw new Error(failures.join("；") || "所有语音识别 API 都请求失败。");
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
