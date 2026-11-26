import { Keji, type KeyFrameItem } from "../keji.ts";
import { downloadAndCacheVideo } from "../lesson-cache.ts";
import { scoreRgbaFrameQuality } from "../note-schema.ts";

interface VideoFrameSource {
  file?: Blob;
  url?: string;
  duration?: number;
  bvid?: string;
  page?: number;
  cid?: number;
  title?: string;
  part?: string;
  pageUrl?: string;
}

export interface FrameTarget {
  raw?: string;
  timestamp: string;
  seconds: number;
  caption: string;
}

type FrameProgressCallback = (
  loaded: number | null,
  total: number | null,
  index?: number,
  count?: number,
  timestamp?: string
) => void;

function waitForVideo(video: HTMLVideoElement, eventName: keyof HTMLMediaElementEventMap, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`读取视频画面超时（${eventName}）。`)), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      video.removeEventListener(eventName, onReady);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error("浏览器无法解码当前 B 站视频轨。"));
    video.addEventListener(eventName, onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
    if (video.error) onError();
  });
}

async function resolveVideoFile(source: VideoFrameSource, onProgress?: FrameProgressCallback, signal?: AbortSignal) {
  if (source?.file) {
    onProgress?.(source.file.size, source.file.size);
    return { file: source.file, cleanup: async () => {} };
  }
  return downloadAndCacheVideo(source, source?.url || "", {
    expectedCid: source?.cid || 0,
    signal,
    meta: {
      cid: source?.cid || 0,
      title: source?.title || "",
      part: source?.part || "",
      url: source?.pageUrl || "",
      duration: Number(source?.duration) || 0
    },
    onProgress: (loaded, expected) => onProgress?.(loaded, expected)
  });
}

async function seekVideoToTime(video: HTMLVideoElement, seconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("已停止生成。", "AbortError");
  if (Math.abs(video.currentTime - seconds) > 0.05 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    const seeked = waitForVideo(video, "seeked", 20000);
    video.currentTime = seconds;
    await seeked;
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForVideo(video, "loadeddata", 20000);
  }
}

function measureProbeFrame(video: HTMLVideoElement, probeCanvas: HTMLCanvasElement, probeCtx: CanvasRenderingContext2D) {
  const pw = probeCanvas.width;
  const ph = probeCanvas.height;
  probeCtx.drawImage(video, 0, 0, pw, ph);
  const data = probeCtx.getImageData(0, 0, pw, ph).data;
  return scoreRgbaFrameQuality(data, pw, ph);
}

export async function captureVideoFrames(
  source: VideoFrameSource,
  frames: FrameTarget[],
  onProgress?: FrameProgressCallback,
  signal?: AbortSignal,
  options: { settleWindowSeconds?: number } = {}
): Promise<KeyFrameItem[]> {
  if (!Array.isArray(frames) || !frames.length) return [];
  if (signal?.aborted) throw new DOMException("已停止生成。", "AbortError");
  const temporary = await resolveVideoFile(source, onProgress, signal);
  const objectUrl = URL.createObjectURL(temporary.file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;
  const canvas = document.createElement("canvas");
  const probeCanvas = document.createElement("canvas");
  probeCanvas.width = 160;
  probeCanvas.height = 90;
  const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
  const settleWindow = Math.max(0, Number(options.settleWindowSeconds) || 0);

  try {
    video.load();
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitForVideo(video, "loadedmetadata", 30000);
    }
    const duration = Number.isFinite(video.duration) ? video.duration : Number(source.duration) || 0;
    const maxAllowed = Math.max(0, duration > 0.2 ? duration - 0.15 : 0);
    const captured: KeyFrameItem[] = [];

    for (let index = 0; index < frames.length; index += 1) {
      if (signal?.aborted) throw new DOMException("已停止生成。", "AbortError");
      const frame = frames[index]!;
      const rawTarget = Math.max(0, Math.min(Number(frame.seconds) || 0, maxAllowed));
      onProgress?.(null, null, index + 1, frames.length, frame.timestamp);

      await seekVideoToTime(video, rawTarget, signal);
      if (!video.videoWidth || !video.videoHeight) throw new Error("视频轨没有可绘制的画面。");

      let chosenTime = rawTarget;
      if (probeCtx) {
        const baseline = measureProbeFrame(video, probeCanvas, probeCtx);
        const nextLimit = index + 1 < frames.length
          ? Math.max(rawTarget, (Number(frames[index + 1]!.seconds) || maxAllowed) - 1.5)
          : maxAllowed;
        const windowCeiling = Math.min(maxAllowed, nextLimit);

        if (settleWindow > 0 && windowCeiling > rawTarget + 0.6) {
          const offsets = [
            Math.min(windowCeiling, rawTarget + 1.8),
            Math.min(windowCeiling, rawTarget + Math.min(3.5, settleWindow))
          ].filter((candidate, pos, arr) => candidate > rawTarget + 0.4 && (pos === 0 || Math.abs(candidate - arr[pos - 1]!) > 0.4));

          let bestScore = baseline.score;
          let bestIsBlank = baseline.isBlankOrFade;
          for (const candidateTime of offsets) {
            await seekVideoToTime(video, candidateTime, signal);
            const probed = measureProbeFrame(video, probeCanvas, probeCtx);
            if ((bestIsBlank && !probed.isBlankOrFade) || (!probed.isBlankOrFade && probed.score > bestScore * 1.12)) {
              chosenTime = candidateTime;
              bestScore = probed.score;
              bestIsBlank = probed.isBlankOrFade;
            }
          }
          if (Math.abs(video.currentTime - chosenTime) > 0.05) {
            await seekVideoToTime(video, chosenTime, signal);
          }
        } else if (baseline.isBlankOrFade && windowCeiling > rawTarget + 0.5) {
          const nudgeTime = Math.min(windowCeiling, rawTarget + 1.0);
          await seekVideoToTime(video, nudgeTime, signal);
          const nudged = measureProbeFrame(video, probeCanvas, probeCtx);
          if (!nudged.isBlankOrFade || nudged.score > baseline.score) {
            chosenTime = nudgeTime;
          } else {
            await seekVideoToTime(video, chosenTime, signal);
          }
        }
      }

      const finalSeconds = Number(video.currentTime) || chosenTime;
      const width = Math.min(1000, video.videoWidth);
      canvas.width = width;
      canvas.height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      captured.push({
        ...frame,
        timestamp: settleWindow > 0 ? Keji.formatTime(finalSeconds) : frame.timestamp,
        seconds: finalSeconds,
        dataUrl: canvas.toDataURL("image/jpeg", 0.82)
      });
    }
    return captured;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
    await temporary.cleanup();
  }
}
