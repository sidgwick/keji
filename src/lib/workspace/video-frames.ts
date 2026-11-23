import type { KeyFrameItem } from "../keji.ts";
import { downloadAndCacheVideo } from "../lesson-cache.ts";

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

export async function captureVideoFrames(
  source: VideoFrameSource,
  frames: FrameTarget[],
  onProgress?: FrameProgressCallback,
  signal?: AbortSignal
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
  try {
    video.load();
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitForVideo(video, "loadedmetadata", 30000);
    }
    const duration = Number.isFinite(video.duration) ? video.duration : Number(source.duration) || 0;
    const captured: KeyFrameItem[] = [];
    for (let index = 0; index < frames.length; index += 1) {
      if (signal?.aborted) throw new DOMException("已停止生成。", "AbortError");
      const frame = frames[index]!;
      const target = Math.max(0, Math.min(Number(frame.seconds) || 0, Math.max(0, duration - 0.15)));
      onProgress?.(null, null, index + 1, frames.length, frame.timestamp);
      if (Math.abs(video.currentTime - target) > 0.05 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        const seeked = waitForVideo(video, "seeked", 20000);
        video.currentTime = target;
        await seeked;
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await waitForVideo(video, "loadeddata", 20000);
      }
      if (!video.videoWidth || !video.videoHeight) throw new Error("视频轨没有可绘制的画面。");
      const width = Math.min(1000, video.videoWidth);
      canvas.width = width;
      canvas.height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      captured.push({
        ...frame,
        seconds: Number(video.currentTime) || target,
        dataUrl: canvas.toDataURL("image/jpeg", 0.78)
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
