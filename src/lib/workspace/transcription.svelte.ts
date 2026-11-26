import { safeFilename } from '../bundle-zip.ts';
import { Keji, type TranscriptSegment, type VideoTarget } from '../keji.ts';
import { getCachedTranscription, putCachedTranscription } from '../lesson-cache.ts';
import {
  normalizeTranscriptFile,
  resolveSelectedTranscriptTimeRange,
  transcriptToSrt,
} from '../subtitles.ts';
import { workspace } from './state.svelte.ts';
import { callBackground, downloadText, showNotice } from './ui.ts';

interface TranscriptionHostHooks {
  getCurrentVideo: () => VideoTarget | null;
  getLatestVideo: () => VideoTarget | null;
  getLatestNoteTitle: () => string;
  getCurrentTabId: () => number | null;
  requestAudioPermissions: (deniedMessage: string) => Promise<boolean>;
  onTranscriptChanged: () => void;
  onInvalidateGeneratedDraft: () => void;
  onCacheUpdated: (target: VideoTarget | null) => void;
}

export const transcriptionState = $state({
  running: false,
  starting: false,
  stopping: false,
  retranscribingSelection: false,
  phaseLabel: '',
  progress: '',
  progressPercent: null as number | null,
  outcome: 'idle' as 'idle' | 'running' | 'done' | 'cancelled' | 'error',
  progressVisible: false,
  conflict: { visible: false, copy: '', title: '', text: '' },
  previewOpen: false,
});

export function dismissTranscriptionProgress(): void {
  if (transcriptionState.running) return;
  transcriptionState.progressVisible = false;
}

let autoTranscriptionText = '';
let transcriptManuallyEdited = false;
let latestTranscriptionSegments: TranscriptSegment[] = [];
let latestDetectedLanguages: string[] = [];
let latestTranscription: any = null;
let resolvedTranscriptionId = '';
let transcriptCacheSaveTimer: ReturnType<typeof setTimeout> | null = null;

let host: TranscriptionHostHooks = {
  getCurrentVideo: () => null,
  getLatestVideo: () => null,
  getLatestNoteTitle: () => '',
  getCurrentTabId: () => null,
  requestAudioPermissions: async () => false,
  onTranscriptChanged: () => {},
  onInvalidateGeneratedDraft: () => {},
  onCacheUpdated: () => {},
};

function isSameVideo(transcription: any): boolean {
  const currentVideo = host.getCurrentVideo();
  return Boolean(currentVideo && transcription
    && transcription.bvid === currentVideo.bvid
    && Number(transcription.page) === Number(currentVideo.page)
    && (!transcription.cid || !currentVideo.cid || Number(transcription.cid) === Number(currentVideo.cid)));
}

function transcriptionIdentity(transcription: any): string {
  return String(
    transcription?.taskId
    || `${transcription?.bvid || ''}:${transcription?.page || ''}:${transcription?.updatedAt || transcription?.text?.length || 0}`
  );
}

function renderTranscriptionConflict(transcription = latestTranscription): void {
  const currentVideo = host.getCurrentVideo();
  const hasDifferentResult = Boolean(
    isSameVideo(transcription)
    && transcription?.status === 'done'
    && transcription.text
    && workspace.transcript !== transcription.text
  );
  const id = hasDifferentResult ? transcriptionIdentity(transcription) : '';
  const unresolved = hasDifferentResult && id !== resolvedTranscriptionId;
  transcriptionState.conflict.visible = Boolean(unresolved);
  if (!hasDifferentResult) {
    transcriptionState.conflict = { visible: false, copy: '', title: '', text: '' };
    host.onTranscriptChanged();
    return;
  }
  const partLabel = `第 ${transcription.page || currentVideo?.page}/${currentVideo?.pageCount || 1} 节`;
  const partName = transcription.part || currentVideo?.part || '本节';
  transcriptionState.conflict = {
    visible: Boolean(unresolved),
    copy: `本次识别稿来自${partLabel} · ${partName}。编辑区保留着另一份内容，课记没有自动覆盖。`,
    title: `本次识别稿 · ${partLabel} · ${partName}`,
    text: transcription.text,
  };
  host.onTranscriptChanged();
}

function saveCurrentTranscriptToCache(delay = 500, manual = true): void {
  clearPendingTranscriptCacheTimer();
  const video = host.getCurrentVideo();
  const text = workspace.transcript.trim();
  if (!video || !text) return;
  const videoSnapshot = { ...video };
  const segmentsSnapshot = [...latestTranscriptionSegments];
  const langsSnapshot = [...latestDetectedLanguages];
  const expectedLessonKey = Keji.lessonKey(videoSnapshot);
  const write = () => {
    transcriptCacheSaveTimer = null;
    void putCachedTranscription(videoSnapshot, {
      cid: Number(videoSnapshot.cid) || 0,
      title: videoSnapshot.title || '',
      part: videoSnapshot.part || '',
      duration: Number(videoSnapshot.duration) || 0,
      text,
      segments: segmentsSnapshot,
      detectedLanguages: langsSnapshot,
      manual
    }).then(() => {
      if (Keji.lessonKey(host.getCurrentVideo()) === expectedLessonKey) {
        host.onCacheUpdated(videoSnapshot);
      }
    }).catch(() => {});
  };
  if (delay <= 0) write();
  else transcriptCacheSaveTimer = setTimeout(write, delay);
}

export function configureTranscriptionHost(hooks: TranscriptionHostHooks): void {
  host = hooks;
}

export function clearPendingTranscriptCacheTimer(): void {
  if (transcriptCacheSaveTimer) {
    clearTimeout(transcriptCacheSaveTimer);
    transcriptCacheSaveTimer = null;
  }
}

export function resetTranscriptionForNewVideo(clearTranscriptAndConflict = true): void {
  clearPendingTranscriptCacheTimer();
  autoTranscriptionText = '';
  transcriptManuallyEdited = false;
  latestTranscriptionSegments = [];
  latestDetectedLanguages = [];
  if (clearTranscriptAndConflict) {
    workspace.transcript = '';
    workspace.transcriptExpanded = false;
    latestTranscription = null;
    resolvedTranscriptionId = '';
    transcriptionState.running = false;
    transcriptionState.starting = false;
    transcriptionState.stopping = false;
    transcriptionState.retranscribingSelection = false;
    transcriptionState.phaseLabel = '';
    transcriptionState.progress = '';
    transcriptionState.progressPercent = null;
    transcriptionState.outcome = 'idle';
    transcriptionState.progressVisible = false;
    transcriptionState.conflict = { visible: false, copy: '', title: '', text: '' };
    transcriptionState.previewOpen = false;
  }
}

export function getTranscriptionMetadata() {
  return {
    segments: latestTranscriptionSegments,
    detectedLanguages: latestDetectedLanguages,
  };
}

export function setSavedNoteTranscriptionState(note: {
  transcriptSegments?: TranscriptSegment[];
  detectedLanguages?: string[];
  cachedFallback?: Awaited<ReturnType<typeof getCachedTranscription>> | null;
}): void {
  autoTranscriptionText = '';
  transcriptManuallyEdited = false;
  latestTranscriptionSegments = Array.isArray(note.transcriptSegments) ? note.transcriptSegments : [];
  latestDetectedLanguages = Array.isArray(note.detectedLanguages) ? note.detectedLanguages : [];
  if (!latestTranscriptionSegments.length && Array.isArray(note.cachedFallback?.segments)) {
    latestTranscriptionSegments = note.cachedFallback.segments;
  }
  if (!latestDetectedLanguages.length && Array.isArray(note.cachedFallback?.detectedLanguages)) {
    latestDetectedLanguages = note.cachedFallback.detectedLanguages;
  }
  if (latestDetectedLanguages.length) {
    transcriptionState.progressVisible = true;
    transcriptionState.outcome = 'done';
    transcriptionState.phaseLabel = '已保存语言信息';
    transcriptionState.progressPercent = null;
    transcriptionState.progress = `已保存的转写检测语言：${latestDetectedLanguages.join('、')}。`;
  }
}

export function clearTranscriptProcessMetadata(clearCreateTranscript = false): void {
  latestTranscriptionSegments = [];
  latestDetectedLanguages = [];
  if (clearCreateTranscript) {
    workspace.transcript = '';
    workspace.transcriptExpanded = false;
    workspace.characterCount = 0;
    workspace.hasCaptions = false;
    workspace.captionStatus = '已清理本节媒体缓存；可点击「重新读取」恢复字幕。';
    transcriptionState.phaseLabel = '';
    transcriptionState.progressPercent = null;
    transcriptionState.outcome = 'idle';
    transcriptionState.progressVisible = false;
    transcriptionState.progress = '';
  }
}

export function hasUnresolvedTranscriptionConflict(): boolean {
  const transcription = latestTranscription;
  return Boolean(
    isSameVideo(transcription)
    && transcription?.status === 'done'
    && transcription.text
    && workspace.transcript !== transcription.text
    && transcriptionIdentity(transcription) !== resolvedTranscriptionId
  );
}

export function handleTranscriptionStorageChange(transcription: any): void {
  if (!isSameVideo(transcription)) return;
  latestTranscription = transcription;
  latestTranscriptionSegments = Array.isArray(transcription.segments) ? transcription.segments : [];
  latestDetectedLanguages = Array.isArray(transcription.detectedLanguages) ? transcription.detectedLanguages : [];
  if (transcription.text && !transcriptManuallyEdited) {
    const currentText = workspace.transcript;
    if (!currentText.trim() || currentText === autoTranscriptionText) {
      if (currentText !== transcription.text) {
        workspace.transcript = transcription.text;
        host.onTranscriptChanged();
      }
      autoTranscriptionText = transcription.text;
    }
  }
  const running = ['starting', 'downloading', 'transcribing'].includes(transcription.status);
  transcriptionState.running = running;
  if (running) transcriptionState.starting = false;
  else transcriptionState.stopping = false;
  transcriptionState.progressVisible = Boolean(transcription.status);

  if (!transcription.status) {
    transcriptionState.outcome = 'idle';
    transcriptionState.phaseLabel = '';
    transcriptionState.progressPercent = null;
    transcriptionState.progress = '';
  } else if (transcription.status === 'cancelled') {
    transcriptionState.outcome = 'cancelled';
    transcriptionState.phaseLabel = '已停止转写';
    transcriptionState.progressPercent = null;
    transcriptionState.progress = transcription.text
      ? '已停止转写，已保留前面识别到的文字'
      : '已停止转写';
  } else if (transcription.status === 'error') {
    transcriptionState.outcome = 'error';
    transcriptionState.phaseLabel = '转写失败';
    transcriptionState.progressPercent = null;
    transcriptionState.progress = `${transcription.error || '未知错误'}${transcription.text ? '（已保留前面识别到的文字）' : ''}`;
  } else if (transcription.status === 'downloading') {
    const loaded = Number(transcription.downloadBytes) || 0;
    const total = Number(transcription.downloadTotal) || 0;
    const pct = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : null;
    transcriptionState.outcome = 'running';
    transcriptionState.phaseLabel = '下载音轨';
    transcriptionState.progressPercent = pct;
    transcriptionState.progress = pct !== null
      ? '正在获取 B 站音轨，无需播放视频'
      : '正在直接获取 B 站音轨，无需播放视频';
  } else if (transcription.status === 'transcribing') {
    transcriptionState.outcome = 'running';
    if (transcription.phase === 'decode') {
      const mb = (Number(transcription.downloadedBytes || 0) / 1024 / 1024).toFixed(1);
      transcriptionState.phaseLabel = '解码切分';
      transcriptionState.progressPercent = null;
      transcriptionState.progress = transcription.fromCache
        ? `已读取本机缓存音轨（${mb} MB），正在解码切分`
        : `音轨已获取（${mb} MB），正在解码切分`;
    } else if (transcription.chunksTotal > 1) {
      const done = Number(transcription.chunksDone) || 0;
      const total = Number(transcription.chunksTotal) || 1;
      transcriptionState.phaseLabel = '语音识别中';
      transcriptionState.progressPercent = Math.min(100, Math.round((done / total) * 100));
      transcriptionState.progress = `已完成 ${done} / ${total} 个音频分段`;
    } else {
      transcriptionState.phaseLabel = '语音识别中';
      transcriptionState.progressPercent = null;
      transcriptionState.progress = '已获取音轨，正在发送至语音识别服务…';
    }
  } else if (transcription.status === 'starting') {
    transcriptionState.outcome = 'running';
    transcriptionState.phaseLabel = '准备音轨';
    transcriptionState.progressPercent = null;
    transcriptionState.progress = transcription.fromCache
      ? '正在读取本机缓存音轨…'
      : '正在准备本节音轨…';
  }
  if (transcription.status === 'done') {
    transcriptionState.outcome = 'done';
    transcriptionState.phaseLabel = '转写完成';
    transcriptionState.progressPercent = 100;
    if (transcription.text) {
      const languageSummary = transcription.detectedLanguages?.length
        ? `，检测语言：${transcription.detectedLanguages.join('、')}`
        : '';
      const segmentCount = Number(transcription.segments?.length) || 0;
      const characterCount = String(transcription.text || '').length;
      transcriptionState.progress = `已识别 ${segmentCount.toLocaleString('zh-CN')} 个片段 · ${characterCount.toLocaleString('zh-CN')} 字${languageSummary}`;
      host.onCacheUpdated(host.getCurrentVideo() || host.getLatestVideo());
    } else {
      transcriptionState.progress = '转写已完成，但未识别到有效语音内容。';
    }
  }
  renderTranscriptionConflict(transcription);
}

export async function refreshActiveTranscription(): Promise<void> {
  const result = await callBackground('GET_TRANSCRIPTION');
  if (result?.ok) handleTranscriptionStorageChange(result.transcription);
}

export async function restoreCachedLessonTranscript(forceCaptions: boolean): Promise<void> {
  const currentVideo = host.getCurrentVideo();
  if (!currentVideo || (forceCaptions && (workspace.hasCaptions || workspace.transcript.trim()))) return;
  const cachedTranscript = await getCachedTranscription(currentVideo, { expectedCid: currentVideo.cid }).catch(() => null);
  if (cachedTranscript?.text?.trim() && (cachedTranscript.manual || (!workspace.hasCaptions && !workspace.transcript.trim()))) {
    workspace.transcript = cachedTranscript.text;
    transcriptManuallyEdited = Boolean(cachedTranscript.manual);
    autoTranscriptionText = cachedTranscript.manual ? '' : cachedTranscript.text;
    latestTranscriptionSegments = Array.isArray(cachedTranscript.segments) ? cachedTranscript.segments : [];
    latestDetectedLanguages = Array.isArray(cachedTranscript.detectedLanguages) ? cachedTranscript.detectedLanguages : [];
    workspace.captionStatus = cachedTranscript.manual ? '已载入本机缓存的文字稿。' : '已载入本机缓存的语音转写稿。';
    host.onTranscriptChanged();
  }
}

export function viewTranscriptionResult(): void {
  const transcription = latestTranscription;
  if (!isSameVideo(transcription) || !transcription?.text) return;
  if (transcriptionState.previewOpen) {
    transcriptionState.previewOpen = false;
    return;
  }
  transcriptionState.conflict.text = transcription.text;
  transcriptionState.previewOpen = true;
}

export function replaceTranscriptWithLatestResult(): void {
  const transcription = latestTranscription;
  if (!isSameVideo(transcription) || !transcription?.text) return;
  workspace.transcript = transcription.text;
  autoTranscriptionText = transcription.text;
  transcriptManuallyEdited = false;
  latestTranscriptionSegments = Array.isArray(transcription.segments) ? transcription.segments : [];
  latestDetectedLanguages = Array.isArray(transcription.detectedLanguages) ? transcription.detectedLanguages : [];
  resolvedTranscriptionId = transcriptionIdentity(transcription);
  transcriptionState.previewOpen = false;
  host.onTranscriptChanged();
  saveCurrentTranscriptToCache(0, false);
  renderTranscriptionConflict(transcription);
}

export function keepCurrentTranscript(): void {
  if (!hasUnresolvedTranscriptionConflict()) return;
  resolvedTranscriptionId = transcriptionIdentity(latestTranscription);
  transcriptionState.conflict.visible = false;
  host.onTranscriptChanged();
}

export function onTranscriptInput(): void {
  if (workspace.transcript !== autoTranscriptionText) transcriptManuallyEdited = true;
  host.onTranscriptChanged();
  renderTranscriptionConflict();
  saveCurrentTranscriptToCache(500);
}

export function onTranscriptBlur(): void {
  saveCurrentTranscriptToCache(0);
}

export async function startDirectTranscription(): Promise<void> {
  if (transcriptionState.starting || transcriptionState.running) return;
  if (!workspace.transcript.trim()) {
    autoTranscriptionText = '';
    transcriptManuallyEdited = false;
  }
  transcriptionState.starting = true;
  try {
    await host.requestAudioPermissions('需要允许课记访问 B 站音频服务器，才能直接获取音轨。');
    const targetVideo = host.getCurrentVideo() || host.getLatestVideo();
    const lesson = targetVideo
      ? {
        bvid: targetVideo.bvid || Keji.bvidFromUrl(targetVideo.url),
        page: Number(targetVideo.page) || 1,
        cid: Number(targetVideo.cid) || 0,
        title: targetVideo.title || '',
        part: targetVideo.part || '',
        url: targetVideo.url || '',
        duration: Number(targetVideo.duration) || 0
      }
      : null;
    const result = await callBackground('START_DIRECT_AUDIO_TRANSCRIPTION', {
      tabId: host.getCurrentTabId(),
      lesson
    });
    if (!result?.ok) throw new Error(result?.error || '启动快速音轨转写失败。');
    handleTranscriptionStorageChange(result.transcription);
    showNotice(
      result.transcription?.fromCache
        ? '已命中本机缓存音轨，正在开始转写。'
        : '已开始下载本节音轨，无需播放视频。',
      'success'
    );
  } catch (error) {
    showNotice((error as Error).message || '启动快速音轨转写失败。', 'error');
  } finally {
    transcriptionState.starting = false;
  }
}

export async function stopTranscription(): Promise<void> {
  if (transcriptionState.stopping) return;
  transcriptionState.stopping = true;
  try {
    const result = await callBackground('STOP_AUDIO_TRANSCRIPTION');
    if (!result?.ok) throw new Error(result?.error || '停止失败。');
    transcriptionState.progressVisible = true;
    transcriptionState.phaseLabel = '正在停止';
    transcriptionState.progressPercent = null;
    transcriptionState.progress = '正在识别最后一段音频…';
  } catch (error) {
    transcriptionState.stopping = false;
    showNotice((error as Error).message || '停止失败。', 'error');
  } finally {
    if (!transcriptionState.running) transcriptionState.stopping = false;
  }
}

export async function retranscribeSelectedTranscript(
  textarea?: HTMLTextAreaElement | null
): Promise<void> {
  if (!textarea || transcriptionState.retranscribingSelection) return;
  const transcript = workspace.transcript;
  let range;
  try {
    range = resolveSelectedTranscriptTimeRange(
      transcript,
      textarea.selectionStart,
      textarea.selectionEnd,
      latestTranscriptionSegments
    );
  } catch (error) {
    return showNotice((error as Error).message, 'error');
  }

  transcriptionState.retranscribingSelection = true;
  try {
    await host.requestAudioPermissions('需要允许课记访问 B 站音频服务器，才能重新识别片段。');
    const targetVideo = host.getCurrentVideo() || host.getLatestVideo();
    const result = await callBackground('RETRANSCRIBE_AUDIO_RANGE', {
      tabId: host.getCurrentTabId(),
      bvid: targetVideo?.bvid || Keji.bvidFromUrl(targetVideo?.url),
      page: targetVideo?.page,
      url: targetVideo?.url || '',
      start: range.start,
      end: range.end
    });
    if (!result?.ok) throw new Error(result?.error || '重新识别失败。');
    host.onCacheUpdated(targetVideo);
    const segments: TranscriptSegment[] = result.segments || [];
    const replacement = segments.map((segment) => `[${Keji.formatTime(segment.time)}] ${segment.text}`).join('\n');
    if (!replacement.trim()) throw new Error('语音识别接口没有返回文字。');

    textarea.setRangeText(`${replacement}${range.suffix}`, range.replaceStart, range.replaceEnd, 'select');
    workspace.transcript = textarea.value;
    transcriptManuallyEdited = true;
    autoTranscriptionText = '';
    latestTranscriptionSegments = [
      ...latestTranscriptionSegments.filter((segment) => {
        const t = Number(segment.time);
        return Number.isFinite(t) && (t < range.firstTime || t > range.lastTime + 0.5);
      }),
      ...segments
    ].sort((a, b) => a.time - b.time);
    saveCurrentTranscriptToCache(0);
    host.onTranscriptChanged();
    showNotice(`已重新识别 ${Keji.formatTime(range.start)}–${Keji.formatTime(range.end)}，结果已替换选中内容。`, 'success');
  } catch (error) {
    showNotice((error as Error).message || '重新识别失败。', 'error');
  } finally {
    transcriptionState.retranscribingSelection = false;
  }
}

export async function importTranscriptFile(file?: File, fileInput?: HTMLInputElement | null): Promise<void> {
  if (!file) return;
  try {
    if (workspace.transcript.trim() && !window.confirm('用文件内容替换当前文字稿？')) return;
    const imported = normalizeTranscriptFile(await file.text(), file.name);
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    if (['srt', 'vtt'].includes(extension) && !imported.cueCount) {
      throw new Error('文件中没有识别到字幕时间轴，请确认文件是有效的 SRT 或 WebVTT。');
    }
    if (!imported.transcript.trim()) throw new Error('文件中没有可导入的文字内容。');
    workspace.transcript = imported.transcript;
    autoTranscriptionText = '';
    transcriptManuallyEdited = true;
    latestTranscriptionSegments = [];
    latestDetectedLanguages = [];
    host.onInvalidateGeneratedDraft();
    saveCurrentTranscriptToCache(0);
    host.onTranscriptChanged();
    workspace.captionStatus = imported.cueCount
      ? `已从 ${file.name} 导入 ${imported.cueCount} 条带时间戳字幕。`
      : `已从 ${file.name} 导入纯文字稿。`;
    showNotice(imported.cueCount
      ? `已导入 ${imported.cueCount} 条字幕，时间戳已转换为课记格式。`
      : '已导入文字稿。', 'success');
  } catch (error) {
    showNotice((error as Error).message || '文字稿导入失败。', 'error');
  } finally {
    if (fileInput) fileInput.value = '';
  }
}

export function exportTranscript(): void {
  const transcript = workspace.transcript.trim();
  if (!transcript) return showNotice('当前没有可导出的文字稿。', 'error');
  const currentVideo = host.getCurrentVideo();
  const latestVideo = host.getLatestVideo();
  const title = host.getLatestNoteTitle() || currentVideo?.title || '课程文字稿';
  const safeTitle = safeFilename(title, '课程文字稿');
  const metadata = [
    `${title} · 原始文字稿`,
    latestVideo?.part ? `${latestVideo.part} · 第 ${latestVideo.page || 1} 节` : '',
    latestVideo?.url ? `视频链接：${latestVideo.url}` : ''
  ].filter(Boolean).join('\n');
  downloadText(`${safeTitle}-文字稿.txt`, `${metadata}\n\n${transcript}\n`, 'text/plain;charset=utf-8');
  showNotice('已导出带时间戳的文字稿 TXT。', 'success');
}

export function exportTranscriptSrt(): void {
  const transcript = workspace.transcript.trim();
  if (!transcript) return showNotice('当前没有可导出的文字稿。', 'error');
  const latestVideo = host.getLatestVideo();
  const currentVideo = host.getCurrentVideo();
  const result = transcriptToSrt(transcript, latestVideo?.duration);
  if (!result.cueCount) return showNotice('文字稿中没有可识别的 [时间戳]，无法生成同步字幕。', 'error');
  const title = host.getLatestNoteTitle() || latestVideo?.title || currentVideo?.title || '课程字幕';
  const safeTitle = safeFilename(title, '课程字幕');
  downloadText(`${safeTitle}.srt`, result.srt, 'application/x-subrip;charset=utf-8');
  showNotice(`已导出 ${result.cueCount} 条 SRT 字幕${result.unmatchedLines ? `；${result.unmatchedLines} 行无时间戳内容未写入` : ''}。`, 'success');
}
