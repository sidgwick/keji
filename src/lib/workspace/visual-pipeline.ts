import { Keji, type KejiSettings, type KeyFrameItem, type ModelCapability, type VideoTarget } from '../keji.ts';
import { getCachedVideo } from '../lesson-cache.ts';
import { restoreScreenshotEmbeds } from '../markdown.ts';
import { planVisualCandidateTimes, refineKeyframeTargetsWithTranscript } from '../note-schema.ts';
import { workspace } from './state.svelte.ts';
import { callBackground } from './ui.ts';
import { captureVideoFrames, type FrameTarget } from './video-frames.ts';

let activeVideoTaskId = '';

export function getActiveVideoProgressStorageKey(): string {
  return activeVideoTaskId ? `videoProgress_${activeVideoTaskId}` : '';
}

export function renderVideoProgress(progress: any): void {
  if (!progress || !activeVideoTaskId || progress.taskId !== activeVideoTaskId) return;
  const total = Number(progress.totalBytes) || 0;
  const loaded = Number(progress.loadedBytes) || 0;
  const mb = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (progress.stage === 'downloading') {
    const amount = total ? `${mb(loaded)} / ${mb(total)} · ${Math.min(100, Math.floor(loaded / total * 100))}%` : `${mb(loaded)} 已获取`;
    workspace.generationStageText = `正在从 B 站下载并缓存视频流供模型分析：${amount}`;
  } else if (progress.stage === 'analyzing') {
    workspace.generationStageText = `视频已提交（${mb(loaded)}），模型正在联合分析画面和讲解内容…`;
  }
}

export function framesFromMarkdown(markdown: string): KeyFrameItem[] {
  return [...String(markdown || '').matchAll(/!\[([^\]]*)\]\((data:image\/(?:jpeg|png|webp);base64,[^)]+)\)/gi)]
    .map((match) => {
      const caption = match[1] || '';
      return {
        timestamp: caption.match(/\d{1,2}:\d{2}(?::\d{2})?$/)?.[0] || '画面截图',
        seconds: 0,
        caption,
        dataUrl: match[2]!
      };
    });
}

function findKeyframes(markdown: string): FrameTarget[] {
  const pattern = /\[\[KEYFRAME:\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\|\s*([^\]]+)\]\]|>\s*关键时刻\s*·\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[：:]\s*([^\r\n（]+)(?:（截图未能捕获[^）]*）)?/gi;
  const found: FrameTarget[] = [];
  for (const match of markdown.matchAll(pattern)) {
    const timestamp = match[1] || match[3] || '';
    const caption = match[2] || match[4] || '';
    const seconds = Keji.parseTime(timestamp);
    if (seconds === null) continue;
    if (found.some((frame) => Math.abs(frame.seconds - seconds) < 8)) continue;
    found.push({ raw: match[0], timestamp, seconds, caption: caption.trim() });
  }
  return found;
}

function humanizeKeyframeMarkers(markdown: string, reason = '截图未能捕获'): string {
  return String(markdown || '').replace(
    /\[\[KEYFRAME:\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\|\s*([^\]]+)\]\]/gi,
    (_match, timestamp: string, caption: string) => `> 关键时刻 · ${timestamp}：${caption.trim()}（${reason}）`
  );
}

async function resolvePreparedVideoSource(tabId: number | null, videoTarget: VideoTarget): Promise<Record<string, any>> {
  const cachedVideo = videoTarget ? await getCachedVideo(videoTarget, { expectedCid: videoTarget.cid }).catch(() => null) : null;
  if (cachedVideo?.file) {
    workspace.generationStageText = '正在从本机缓存视频轨读取画面…';
    return {
      file: cachedVideo.file,
      duration: Number(videoTarget?.duration || cachedVideo.meta?.duration) || 0,
      bvid: videoTarget?.bvid || Keji.bvidFromUrl(videoTarget?.url),
      page: Number(videoTarget?.page) || 1
    };
  }
  const source = await callBackground('READ_VIDEO_SOURCE', { tabId, lesson: videoTarget });
  if (!source?.ok) throw new Error(source?.error || '无法读取 B 站视频轨。');
  const origin = new URL(source.source.url).origin;
  if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
    throw new Error('尚未授权访问当前视频 CDN；请在设置中重新保存配置并允许 B 站视频域名。');
  }
  const prepared = await callBackground('PREPARE_VIDEO_CAPTURE');
  if (!prepared?.ok) throw new Error(prepared?.error || '无法准备视频画面读取。');
  workspace.generationStageText = '正在后台读取视频轨准备截图…';
  return {
    ...source.source,
    bvid: videoTarget?.bvid || Keji.bvidFromUrl(videoTarget?.url),
    page: Number(videoTarget?.page) || 1,
    cid: Number(videoTarget?.cid) || 0,
    title: videoTarget?.title || '',
    part: videoTarget?.part || '',
    pageUrl: videoTarget?.url || ''
  };
}

function reportFrameCaptureProgress(loaded: number | null, total: number | null, index?: number, count?: number, timestamp?: string) {
  if (index) {
    workspace.generationStageText = `正在截取关键画面 ${index}/${count} · ${timestamp}`;
  } else {
    const amount = ((loaded || 0) / 1024 / 1024).toFixed(1);
    const totalAmount = total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ' MB';
    workspace.generationStageText = `正在后台下载并缓存视频轨 ${amount}${totalAmount}…`;
  }
}

async function captureKeyframes(
  markdown: string,
  tabId: number | null,
  signal: AbortSignal | undefined,
  videoTarget: VideoTarget,
  transcript = ''
) {
  const rawKeyframes = findKeyframes(markdown);
  if (!rawKeyframes.length) return { markdown, frames: [] as KeyFrameItem[], failed: false };
  const videoSource = await resolvePreparedVideoSource(tabId, videoTarget);
  const duration = Number(videoSource.duration || videoTarget?.duration) || 0;
  const keyframes = transcript
    ? refineKeyframeTargetsWithTranscript(rawKeyframes, transcript, duration)
    : rawKeyframes;

  const captured = await captureVideoFrames(videoSource, keyframes, reportFrameCaptureProgress, signal, {
    settleWindowSeconds: 3.5
  });

  let output = markdown;
  for (const frame of keyframes) {
    const found = captured.find((item) => item.raw === frame.raw);
    if (found) {
      const alt = `${found.caption} · ${found.timestamp}`.replace(/[\[\]]/g, '');
      output = output.replace(frame.raw!, `![${alt}](${found.dataUrl})`);
    } else {
      output = output.replace(frame.raw!, `> 关键时刻 · ${frame.timestamp}：${frame.caption}（截图未能捕获）`);
    }
  }
  return { markdown: output, frames: captured, failed: false };
}

async function discoverAndCaptureKeyframes(
  markdown: string,
  transcript: string,
  title: string,
  duration: number,
  options: {
    tabId: number | null;
    generationTaskId: string;
    isCancelled: () => boolean;
    signal?: AbortSignal;
    videoTarget: VideoTarget;
  }
) {
  const transcriptTimes = [...String(transcript || '').matchAll(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g)]
    .map((match) => Keji.parseTime(match[1]!))
    .filter((seconds): seconds is number => seconds !== null && Number.isFinite(seconds));
  const transcriptEnd = transcriptTimes.reduce((latest, seconds) => Math.max(latest, seconds), 0);
  const durationValue = Number(duration);
  const totalSeconds = (Number.isFinite(durationValue) && durationValue > 0 ? durationValue : 0) || transcriptEnd;
  if (totalSeconds < 10) throw new Error('视频时长不可用，无法抽取候选画面供视觉模型筛选。');

  const candidates = planVisualCandidateTimes(totalSeconds, transcript, markdown);
  if (!candidates.length) throw new Error('视频时间线不可用，无法抽取候选画面供视觉模型筛选。');

  const videoSource = await resolvePreparedVideoSource(options.tabId, options.videoTarget);
  const candidateTargets: FrameTarget[] = candidates.map((seconds) => ({
    timestamp: Keji.formatTime(seconds),
    seconds,
    caption: '候选画面'
  }));
  const capturedCandidates = await captureVideoFrames(videoSource, candidateTargets, (loaded, total, index, count, ts) => {
    if (index) workspace.generationStageText = `正在采样重点候选画面 ${index}/${count} · ${ts}`;
    else reportFrameCaptureProgress(loaded, total);
  }, options.signal, { settleWindowSeconds: 0 });
  if (!capturedCandidates.length) throw new Error('无法捕获候选画面。');

  workspace.generationStageText = '正在由视觉模型结合文字稿筛选重点画面并校对板书…';
  const response = await callBackground('ENRICH_NOTE_WITH_FRAMES', {
    payload: {
      title,
      transcript,
      markdown,
      frames: capturedCandidates,
      discoverKeyframes: true,
      generationTaskId: options.generationTaskId
    }
  });
  if (response?.cancelled || options.isCancelled()) throw Object.assign(new Error('已停止生成。'), { cancelled: true });
  if (!response?.ok) throw new Error(response?.error || '视觉模型未能筛选候选画面。');

  const selectedMarkers = findKeyframes(response.markdown);
  if (!selectedMarkers.length) {
    // Content-driven 0 keyframes: no diagram/board focal points need embedding.
    return {
      markdown: String(response.markdown || '').replace(/\[\[KEYFRAME:[^\]]+\]\]/gi, '').replace(/\n{3,}/g, '\n\n').trim(),
      frames: [] as KeyFrameItem[],
      failed: false
    };
  }

  const matchedFrames: Array<KeyFrameItem & { marker: string }> = [];
  const unmatchedTargets: FrameTarget[] = [];
  for (const marker of selectedMarkers) {
    let nearest: KeyFrameItem | null = null;
    let bestDiff = 4.5;
    for (const candidate of capturedCandidates) {
      const diff = Math.abs(candidate.seconds - marker.seconds);
      if (diff <= bestDiff) {
        bestDiff = diff;
        nearest = candidate;
      }
    }
    if (nearest) {
      matchedFrames.push({ ...nearest, caption: marker.caption, marker: marker.raw! });
    } else {
      unmatchedTargets.push(marker);
    }
  }

  let extraCaptured: KeyFrameItem[] = [];
  if (unmatchedTargets.length) {
    extraCaptured = await captureVideoFrames(videoSource, unmatchedTargets, reportFrameCaptureProgress, options.signal, {
      settleWindowSeconds: 2.5
    }).catch(() => []);
  }

  const allSelected: KeyFrameItem[] = [
    ...matchedFrames,
    ...extraCaptured.map((item) => ({ ...item, marker: item.raw }))
  ].sort((a, b) => a.seconds - b.seconds);

  let output: string = response.markdown;
  const embeddedFrames: KeyFrameItem[] = [];
  for (const frame of allSelected) {
    if (!frame.marker || !output.includes(frame.marker)) continue;
    const alt = `${frame.caption} · ${frame.timestamp}`.replace(/[\[\]]/g, '');
    output = output.replace(frame.marker, `![${alt}](${frame.dataUrl})`);
    embeddedFrames.push(frame);
  }
  output = output.replace(/\[\[KEYFRAME:[^\]]+\]\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  return { markdown: output, frames: embeddedFrames, failed: unmatchedTargets.length > extraCaptured.length };
}

async function enrichVideoWithProgress(payload: Record<string, unknown>, generationTaskId: string) {
  activeVideoTaskId = crypto.randomUUID();
  try {
    return await callBackground('ENRICH_NOTE_WITH_VIDEO', {
      payload: { ...payload, videoTaskId: activeVideoTaskId, generationTaskId }
    });
  } finally {
    activeVideoTaskId = '';
  }
}

export async function runVisualAnalysisPipeline({
  video,
  transcript,
  initialBodyMarkdown,
  settings,
  cachedVideo,
  sameOpenVideo,
  tabId,
  generationTaskId,
  signal,
  isCancelled,
  fallbackFrames = [],
  revertToInitialOnFullVideoCaptureError = false,
  throwOnFrameEnrichError = false
}: {
  video: VideoTarget;
  transcript: string;
  initialBodyMarkdown: string;
  settings: (Partial<KejiSettings> & Record<string, unknown>) | undefined;
  cachedVideo: Awaited<ReturnType<typeof getCachedVideo>>;
  sameOpenVideo: boolean;
  tabId: number | null;
  generationTaskId: string;
  signal?: AbortSignal;
  isCancelled: () => boolean;
  fallbackFrames?: KeyFrameItem[];
  revertToInitialOnFullVideoCaptureError?: boolean;
  throwOnFrameEnrichError?: boolean;
}) {
  let bodyMarkdown = initialBodyMarkdown;
  let visualAnalysis = false;
  let visualAnalysisMode = 'transcript-only-or-incomplete';
  let frames = [...fallbackFrames];
  let captureFailed = false;
  let visualError = '';
  const capability: ModelCapability = Keji.normalizeCapability(settings?.modelCapability, settings?.videoInputMode);

  if (!Keji.supportsImage(capability)) {
    if (findKeyframes(bodyMarkdown).length && (sameOpenVideo || cachedVideo?.file)) {
      try {
        const captured = await captureKeyframes(bodyMarkdown, tabId, signal, video, transcript);
        bodyMarkdown = captured.markdown;
        frames = captured.frames;
        captureFailed = captured.failed;
      } catch (error) {
        const err = error as Error & { cancelled?: boolean };
        if (isCancelled() || err?.cancelled || err?.name === 'AbortError') {
          throw Object.assign(new Error('已停止生成。'), { cancelled: true });
        }
        bodyMarkdown = humanizeKeyframeMarkers(bodyMarkdown, '当前纯文本模式，未截取视频画面');
      }
    } else {
      bodyMarkdown = humanizeKeyframeMarkers(bodyMarkdown, '当前纯文本模式，未截取视频画面');
    }
    return { bodyMarkdown, frames, captureFailed, visualAnalysis: false, visualAnalysisMode: 'text-only', visualError: '' };
  }

  const MAX_INLINE_VIDEO_BYTES = 36 * 1024 * 1024;
  const videoDuration = Number(video.duration || cachedVideo?.meta?.duration) || 0;
  const canReuseCompactCache = Boolean(cachedVideo?.file && cachedVideo.size <= MAX_INLINE_VIDEO_BYTES);

  if (Keji.supportsVideo(capability) && (canReuseCompactCache || sameOpenVideo)) {
    try {
      workspace.generationStageText = canReuseCompactCache
        ? '正在读取本机缓存视频并提交给模型联合分析…'
        : '正在获取本节视频流并提交给模型联合分析…';
      let source: any = null;
      if (!canReuseCompactCache) {
        source = await callBackground('READ_VIDEO_SOURCE', { tabId, maxTargetBytes: MAX_INLINE_VIDEO_BYTES, lesson: video });
        if (!source?.ok) throw new Error(source?.error || '读取 B 站视频流失败。');
      }
      const enriched = await enrichVideoWithProgress({
        title: video.title,
        transcript,
        markdown: bodyMarkdown,
        videoUrl: source?.source?.url || '',
        duration: source?.source?.duration || videoDuration,
        lessonKey: Keji.lessonKey(video),
        bvid: video.bvid || Keji.bvidFromUrl(video.url),
        page: video.page,
        cid: video.cid || 0,
        part: video.part || '',
        pageUrl: video.url || ''
      }, generationTaskId);
      if (enriched?.cancelled || isCancelled()) throw Object.assign(new Error('已停止生成。'), { cancelled: true });
      if (!enriched?.ok) throw new Error(enriched?.error || '完整视频分析失败。');
      bodyMarkdown = enriched.markdown;
      visualAnalysis = true;
      visualAnalysisMode = 'full-video';
    } catch (error) {
      const err = error as Error & { cancelled?: boolean };
      if (isCancelled() || err?.cancelled || err?.name === 'AbortError') {
        throw Object.assign(new Error('已停止生成。'), { cancelled: true });
      }
      visualError = err.message || '完整视频输入失败。';
    }
  }

  if (!visualAnalysis) {
    try {
      workspace.generationStageText = '正在采集重点候选画面，由视觉模型结合内容筛选…';
      const discovered = await discoverAndCaptureKeyframes(
        bodyMarkdown,
        transcript,
        video.title || '',
        videoDuration,
        { tabId, generationTaskId, isCancelled, signal, videoTarget: video }
      );
      bodyMarkdown = discovered.markdown;
      frames = discovered.frames;
      captureFailed = discovered.failed;
      visualAnalysis = true;
      visualAnalysisMode = 'keyframes';
      visualError = '';
    } catch (error) {
      const err = error as Error & { cancelled?: boolean };
      if (isCancelled() || err?.cancelled || err?.name === 'AbortError') {
        throw Object.assign(new Error('已停止生成。'), { cancelled: true });
      }
      visualError = [visualError, err.message || '视觉模型筛选候选画面失败。'].filter(Boolean).join('；');
    }
  }

  if (!visualAnalysis || visualAnalysisMode === 'full-video') {
    try {
      const captured = await captureKeyframes(bodyMarkdown, tabId, signal, video, transcript);
      bodyMarkdown = captured.markdown;
      frames = captured.frames;
      captureFailed = captured.failed;
    } catch (error) {
      const err = error as Error & { cancelled?: boolean };
      if (isCancelled() || err?.cancelled || err?.name === 'AbortError') {
        throw Object.assign(new Error('已停止生成。'), { cancelled: true });
      }
      if (visualAnalysisMode === 'full-video' && !revertToInitialOnFullVideoCaptureError) throw error;
      const baseBody = visualAnalysisMode === 'full-video' ? initialBodyMarkdown : bodyMarkdown;
      bodyMarkdown = humanizeKeyframeMarkers(baseBody, `截图未能捕获：${err.message || '浏览器无法读取视频画面'}`);
      frames = [];
      captureFailed = true;
      visualAnalysis = false;
      visualAnalysisMode = 'transcript-only-or-incomplete';
      visualError = [visualError, err.message || '截取视频关键帧失败。'].filter(Boolean).join('；');
    }
  }

  if (!visualAnalysis && frames.length) {
    workspace.generationStageText = `正在结合 ${frames.length} 张关键帧校对笔记…`;
    try {
      const enriched = await callBackground('ENRICH_NOTE_WITH_FRAMES', {
        payload: { title: video.title, transcript, markdown: bodyMarkdown, frames, generationTaskId }
      });
      if (enriched?.cancelled || isCancelled()) throw Object.assign(new Error('已停止生成。'), { cancelled: true });
      if (!enriched?.ok) throw new Error(enriched?.error || '关键帧校对失败。');
      bodyMarkdown = restoreScreenshotEmbeds(enriched.markdown, bodyMarkdown);
      visualAnalysis = true;
      visualAnalysisMode = 'keyframes';
      visualError = '';
    } catch (error) {
      const err = error as Error & { cancelled?: boolean };
      if (isCancelled() || err?.cancelled || err?.name === 'AbortError') {
        throw Object.assign(new Error('已停止生成。'), { cancelled: true });
      }
      if (throwOnFrameEnrichError) throw error;
      visualError = [visualError, err.message || '关键帧校对失败。'].filter(Boolean).join('；');
    }
  }

  return { bodyMarkdown, frames, captureFailed, visualAnalysis, visualAnalysisMode, visualError };
}
