import { createNoteBundleZip } from '../bundle-zip.ts';
import type { FlashcardReviewState } from '../flashcards.ts';
import {
  Keji,
  type ConversationItem,
  type DiscussionMode,
  type GenerationProgress,
  type KejiSettings,
  type KeyFrameItem,
  type NoteRecord,
  type NoteSummary,
  type ReviewMark,
  type TemplateId,
  type TranscriptSegment,
  type VideoPart,
  type VideoTarget,
} from '../keji.ts';
import { BILIBILI_CDN_ORIGINS, downloadAndCacheVideo, formatBytes, getCachedAudio, getCachedMuxedVideo, getCachedTranscription, getCachedVideo, putCachedMuxedVideo } from '../lesson-cache.ts';
import {
  foldMarkdownImagesForEdit,
  formatNoteMarkdown,
  noteBodyMarkdown,
  renderMarkdownPreview,
  restoreScreenshotEmbeds,
  unfoldMarkdownImagesFromEdit,
} from '../markdown.ts';
import {
  compileStructuredNoteToMarkdown,
  extractMarkdownOutline,
  extractStructuredOutline,
  mergeNoteMarkdownChunks,
  mergeStructuredNoteData,
  type StructuredNoteData,
} from '../note-schema.ts';
import { NOTE_DOCUMENT_STRUCTURES, getNoteStructure, isNoteStructureId, isNoteViewKey, type NoteViewKey } from '../note-structures.ts';
import type { QuizQuestion, QuizRecordState } from '../quiz.ts';
import * as disc from './discussion.svelte.ts';
import * as fc from './flashcards.svelte.ts';
import * as qz from './quiz.svelte.ts';
import * as tx from './transcription.svelte.ts';
import { workspace, type LibraryViewMode, type MarkdownMode, type NoteTab, type ReturnView, type WorkspaceView } from './state.svelte.ts';
import { callBackground, downloadBlob, showNotice, withButtonBusy } from './ui.ts';
import {
  framesFromMarkdown,
  getActiveVideoProgressStorageKey,
  renderVideoProgress,
  runVisualAnalysisPipeline,
} from './visual-pipeline.ts';

const elements: Record<string, any> = new Proxy({}, {
  get: (_target, prop) => document.getElementById(String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
});

let currentVideo: VideoTarget | null = null;
let preferredSubtitleLanguage = '';
const launchParams = new URLSearchParams(location.search);
let currentTabId: number | null = Number(launchParams.get('tabId')) || null;
const launchVideoUrl = launchParams.get('videoUrl') || '';
const launchOrigin = (() => {
  try { return new URL(launchVideoUrl).origin; } catch { return ''; }
})();
const authorizedOrigins = new Set<string>();
let activeTabAccessId: number | null = currentTabId;
let activeGenerationTaskId = '';
let activeCaptureAbortController: AbortController | null = null;
let generationCancelled = false;

let latestMarkdown = '';
let latestViews: Partial<Record<NoteViewKey, string>> = {};
let activeDocumentView: NoteViewKey = 'study';
let latestGeneratingView: TemplateId | '' = '';
let latestFailedView: TemplateId | '' = '';
let latestResumableView: TemplateId | '' = '';
let markdownEditing = false;
let markdownEditOriginal = '';
let markdownEditMode: MarkdownMode = 'preview';
let markdownEditImageMap = new Map<string, string>();
let latestNoteTitle = '';
let latestCourseTitle = '';
let latestReviewMark: ReviewMark = '';
let latestPersonalNote = '';
let latestVideo: VideoTarget | null = null;
let latestTemplate: TemplateId = 'study';
let latestCustomPrompt = '';
let latestModelMarkdown = '';
let latestGenerationProgress: GenerationProgress | null = null;
let latestGenerationStatus = '';
let latestGenerationStartedAt = '';
let latestGenerationError = '';
let latestGenerationModels: string[] = [];
let latestFrames: KeyFrameItem[] = [];
let latestNoteId: string | null = null;
let latestTranscript = '';
let latestVisualAnalysis = false;
let latestVisualAnalysisMode = 'transcript-only-or-incomplete';
let savedNotes: NoteSummary[] = [];
let notesSearchRequest = 0;
let notesSearchTimer: ReturnType<typeof setTimeout> | null = null;
let filteredSavedNotes: NoteSummary[] = [];
let visibleNotesLimit = 100;
let historyIndex = Number(history.state?.workspaceIndex) || 0;
let restoringHistory = false;
let initialized = false;
interface GenerationJob {
  taskId: string;
  noteId: string | null;
  lessonKey: string;
  video: VideoTarget;
  courseTitle: string;
  noteTitle: string;
  targetTemplate: TemplateId;
  expectedMarkdown: string;
  snapshotPending: boolean;
  customPrompt: string;
  transcript: string;
  transcriptSegments: TranscriptSegment[];
  detectedLanguages: string[];
  views: Partial<Record<NoteViewKey, string>>;
  flashcardMarkdown: string;
  flashcardReview: FlashcardReviewState[];
  quizState?: QuizRecordState;
  conversation: ConversationItem[];
  modelMarkdown: string;
  generationModels: string[];
  generationProgress: GenerationProgress | null;
  generationStatus: string;
  generationStartedAt: string;
  generationError: string;
  visualAnalysis: boolean;
  visualAnalysisMode: string;
  inVisualStage: boolean;
  stageText: string;
  generateLabel: string;
}

interface VisualRetryJob {
  noteId: string | null;
  video: VideoTarget;
  label: string;
  stageText: string;
}

let activeGenJob: GenerationJob | null = null;
let activeVisualJob: VisualRetryJob | null = null;
let pendingDelete: { note: NoteSummary; timer: ReturnType<typeof setTimeout> } | null = null;
let renamingField: 'title' | 'part' = 'title';

function isActivelyGeneratingNoteId(noteId?: string | null): boolean {
  if (!noteId) return false;
  return Boolean(
    (activeGenJob?.noteId && activeGenJob.noteId === noteId)
    || (activeVisualJob?.noteId && activeVisualJob.noteId === noteId)
  );
}

function isViewingJob(job: Pick<GenerationJob, 'noteId' | 'lessonKey' | 'video'> | null): boolean {
  if (!job) return false;
  if (job.noteId) return latestNoteId === job.noteId;
  if (latestNoteId) return false;
  return isSameLesson(latestVideo, job.video) || (Boolean(job.lessonKey) && Keji.lessonKey(latestVideo) === job.lessonKey);
}

function formatJobLabel(video: VideoTarget | null, fallbackTitle = ''): string {
  if (!video) return fallbackTitle || '后台笔记';
  const part = String(video.part || '').trim();
  const page = Number(video.page) || 0;
  if (part) {
    const hasPrefix = page > 0 && new RegExp(`^P\\s*${page}\\b`, 'i').test(part);
    return hasPrefix || !page ? part : `P${page} · ${part}`;
  }
  return fallbackTitle || video.title || '后台笔记';
}

function syncGenerationUiFlags(): void {
  if (activeGenJob) {
    const viewing = isViewingJob(activeGenJob);
    workspace.activeNoteGenerating = viewing;
    workspace.backgroundGeneratingTitle = viewing ? '' : formatJobLabel(activeGenJob.video, activeGenJob.noteTitle);
    return;
  }
  if (activeVisualJob) {
    const viewing = activeVisualJob.noteId
      ? latestNoteId === activeVisualJob.noteId
      : (!latestNoteId && isSameLesson(latestVideo, activeVisualJob.video));
    workspace.activeNoteGenerating = viewing;
    workspace.backgroundGeneratingTitle = viewing ? '' : activeVisualJob.label;
    return;
  }
  workspace.activeNoteGenerating = false;
  workspace.backgroundGeneratingTitle = '';
}

function syncGenerationProgressState(): void {
  workspace.generationProgress = latestGenerationProgress
    ? {
        completedChunks: latestGenerationProgress.completedChunks,
        totalChunks: latestGenerationProgress.totalChunks,
        ...(latestGenerationProgress.chunkMaxChars ? { chunkMaxChars: latestGenerationProgress.chunkMaxChars } : {}),
      }
    : { completedChunks: 0, totalChunks: 0 };
}

function getEffectiveActiveTranscript(): string {
  const saved = latestTranscript.trim();
  if (saved) return saved;
  return isSameLesson(currentVideo, latestVideo) ? workspace.transcript.trim() : '';
}

function isPlaceholderMarkdown(markdown?: string | null): boolean {
  const text = String(markdown || '').trim();
  if (!text) return true;
  return /^#\s+[^\n]+\r?\n\r?\n>\s*(?:正在生成笔记，请稍候…|生成失败：[\s\S]*)$/.test(text);
}

function cleanDocumentViewsMap(
  rawViews?: Partial<Record<NoteViewKey, string>> | null
): Partial<Record<NoteViewKey, string>> {
  const views: Partial<Record<NoteViewKey, string>> = {};
  if (!rawViews || typeof rawViews !== 'object') return views;
  for (const item of NOTE_DOCUMENT_STRUCTURES) {
    const value = String(rawViews[item.id] || '').trim();
    if (value && !isPlaceholderMarkdown(value)) views[item.id] = String(rawViews[item.id] || '');
  }
  return views;
}

function extractViewsFromNote(note: Partial<NoteRecord>): Partial<Record<NoteViewKey, string>> {
  const views = cleanDocumentViewsMap(note.views);
  const legacyMd = String(note.markdown || '').trim();
  if (legacyMd && !isPlaceholderMarkdown(legacyMd)) {
    const legacyTemplate = isNoteViewKey(note.template)
      ? note.template
      : (!isNoteStructureId(note.template) ? 'study' : null);
    if (legacyTemplate && !views[legacyTemplate]) {
      views[legacyTemplate] = String(note.markdown || '');
    }
  }
  return views;
}

function getPrimaryDocumentView(): { key: NoteViewKey; markdown: string } {
  const activeMd = latestViews[activeDocumentView];
  if (activeMd && activeMd.trim()) return { key: activeDocumentView, markdown: activeMd };
  for (const item of NOTE_DOCUMENT_STRUCTURES) {
    const candidate = latestViews[item.id];
    if (candidate && candidate.trim()) return { key: item.id, markdown: candidate };
  }
  return { key: activeDocumentView, markdown: '' };
}

function syncGeneratedViewsState(): void {
  workspace.generatedViews = {
    study: Boolean(latestViews.study?.trim()),
    brief: Boolean(latestViews.brief?.trim()),
    tutorial: Boolean(latestViews.tutorial?.trim()),
    timeline: Boolean(latestViews.timeline?.trim()),
    custom: Boolean(latestViews.custom?.trim()),
  };
}

function isSameLesson(a?: VideoTarget | null, b?: VideoTarget | null): boolean {
  const keyA = Keji.lessonKey(a);
  const keyB = Keji.lessonKey(b);
  return Boolean(keyA && keyB && keyA === keyB);
}

function getCopyableContentForCurrentTab(): { label: string; text: string } {
  if (isNoteViewKey(workspace.noteTab)) {
    return { label: '复制笔记', text: latestViews[workspace.noteTab] || '' };
  }
  if (workspace.noteTab === 'quiz') {
    return { label: '复制自测', text: qz.getActiveQuizCopyMarkdown() };
  }
  return { label: '复制闪卡', text: fc.getActiveFlashcardCopyMarkdown() };
}

const statusLabels: Record<string, string> = {
  processing: '生成中',
  failed: '生成失败',
  interrupted: '未完成',
  audiovisual: '已完成 · 含画面',
  transcript: '已完成',
  partial: '未完成',
  unknown: '已保存'
};

function formatShortDate(raw?: string | number | null): string {
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
}

function noteModels(note: Pick<NoteSummary, 'generationModels' | 'generationModel'>): string[] {
  return Array.isArray(note.generationModels) && note.generationModels.length
    ? note.generationModels
    : [note.generationModel].filter((model): model is string => Boolean(model));
}

function requestAudioPermissions(deniedMessage: string): Promise<boolean> {
  const permissionRequest: chrome.permissions.Permissions = workspace.currentLessonHasCachedAudio
    ? { permissions: ['offscreen'] }
    : { permissions: ['offscreen'], origins: BILIBILI_CDN_ORIGINS };
  return chrome.permissions.request(permissionRequest).then((granted) => {
    if (!granted) throw new Error(deniedMessage);
    return true;
  });
}

function syncNoteEpisodeLabel(): void {
  if (fc.flashcardState.crossNote || !latestVideo) {
    workspace.noteEpisodeLabel = '';
    workspace.noteCourseLabel = '';
    return;
  }
  const heading = Keji.formatEpisodeHeading({
    title: latestNoteTitle,
    courseTitle: latestCourseTitle || latestVideo.title,
    part: latestVideo.part,
    page: latestVideo.page,
    pageCount: latestVideo.pageCount,
  });
  workspace.noteCourseLabel = heading.courseLabel;
  workspace.noteEpisodeLabel = heading.courseLabel || (() => {
    const cleanPart = Keji.cleanPartTitle(latestVideo.part, latestVideo.page);
    const page = Number(latestVideo.page) || 0;
    return cleanPart && cleanPart !== latestNoteTitle.trim() ? (page ? `P${page} · ${cleanPart}` : cleanPart) : '';
  })();
}

function savedNoteStatus(note: Partial<NoteSummary>): string {
  if (note.generationStatus === 'failed') return 'failed';
  if (note.generationStatus === 'running') {
    if (workspace.generating && isActivelyGeneratingNoteId(note.id)) return 'processing';
    const completed = Number(note.generationProgress?.completedChunks);
    const total = Number(note.generationProgress?.totalChunks);
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed < total) {
      return 'interrupted';
    }
    if (note.hasContent && (!(Number.isFinite(total) && total > 0) || completed >= total)) {
      return note.visualAnalysis === true ? 'audiovisual' : 'transcript';
    }
    return 'interrupted';
  }
  if (note.visualAnalysis === true) return 'audiovisual';
  const completed = Number(note.generationProgress?.completedChunks);
  const total = Number(note.generationProgress?.totalChunks);
  if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) return completed >= total ? 'transcript' : 'partial';
  if (note.complete === true) return 'transcript';
  if (note.complete === false) return 'partial';
  return 'unknown';
}

function savedNoteStatusTone(status: string): 'completed' | 'processing' | 'failed' | 'incomplete' {
  if (status === 'audiovisual' || status === 'transcript') return 'completed';
  if (status === 'processing') return 'processing';
  if (status === 'failed') return 'failed';
  return 'incomplete';
}

function hasDocumentContentInRecord(note: Partial<NoteRecord>): boolean {
  const views = extractViewsFromNote(note);
  return Boolean(
    Object.keys(views).length
    || String(note.flashcardMarkdown || '').trim()
    || String(note.quizState?.generatedMarkdown || '').trim()
  );
}

async function reconcileOrphanedRunningNotes(notes: NoteSummary[]): Promise<NoteSummary[]> {
  return Promise.all(notes.map(async (item) => {
    if (item.generationStatus !== 'running') return item;
    if (workspace.generating && isActivelyGeneratingNoteId(item.id)) return item;
    const lessonKey = Keji.lessonKey(item);
    if (!lessonKey || !navigator.locks) return item;
    return navigator.locks.request(`keji-lesson-${lessonKey}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return item;
    const loaded = await callBackground('GET_NOTE', { id: item.id }).catch(() => null);
    const full = loaded?.ok ? (loaded.note as NoteRecord) : null;
    if (!full || full.generationStatus !== 'running') return item;
    const hasDoc = hasDocumentContentInRecord(full);
    const total = Number(full.generationProgress?.totalChunks) || 0;
    const completed = Number(full.generationProgress?.completedChunks) || 0;
    const hasIncompleteChunks = total > 0 && completed < total;
    if (hasDoc && !hasIncompleteChunks) {
      const updated = await callBackground('UPDATE_NOTE', {
        note: { id: full.id, generationStatus: 'completed', complete: true, generationError: '' }
      }).catch(() => null);
      return (updated?.ok && updated.note)
        ? (updated.note as NoteSummary)
        : { ...item, generationStatus: 'completed', complete: true, generationError: '', hasContent: true };
    }
    const errorMessage = full.generationError || (completed > 0 && total > 0
      ? `上次生成在第 ${completed}/${total} 段后中断，打开后可继续或重试。`
      : '上次生成已中断，打开后可重新生成。');
    const updated = await callBackground('UPDATE_NOTE', {
      note: { id: full.id, generationStatus: 'failed', complete: false, generationError: errorMessage }
    }).catch(() => null);
    return (updated?.ok && updated.note)
      ? (updated.note as NoteSummary)
      : { ...item, generationStatus: 'failed', complete: false, generationError: errorMessage, hasContent: hasDoc };
    });
  }));
}

function refreshLibraryViewsIfVisible(): void {
  if (workspace.activeView === 'library') {
    void renderRecentNotes().catch(() => {});
  } else if (workspace.activeView === 'create' && !workspace.currentVideo) {
    void refreshRecentNotesOverview();
  }
}

function safeCoverUrl(value?: string): string {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function safeBilibiliVideoUrl(value?: string): string {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (host === 'bilibili.com' || host.endsWith('.bilibili.com'))
      && url.pathname.startsWith('/video/')
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function renderDashboardStats(notes: NoteSummary[]): void {
  const uniqueParts = new Map<string, number>();
  for (const note of notes) {
    const bvid = Keji.bvidFromUrl(note.url);
    if (!bvid) continue;
    const key = `${bvid}:${Number(note.page) || 1}`;
    if (!uniqueParts.has(key)) uniqueParts.set(key, Math.max(0, Number(note.duration) || 0));
  }
  const totalDuration = [...uniqueParts.values()].reduce((sum, duration) => sum + duration, 0);
  const totalMinutes = Math.round(totalDuration / 60);
  const durationLabel = totalMinutes >= 60
    ? `${Math.floor(totalMinutes / 60)} 小时 ${totalMinutes % 60} 分钟`
    : `${totalMinutes} 分钟`;
  const completedCount = notes.filter((note) => ['audiovisual', 'transcript'].includes(savedNoteStatus(note))).length;
  const courseCount = [...new Set(notes.map((note) => Keji.bvidFromUrl(note.url)).filter(Boolean))].length;
  workspace.dashboardStats = [
    [notes.length.toLocaleString('zh-CN'), '笔记篇数'],
    [courseCount.toLocaleString('zh-CN'), '学习课程'],
    [durationLabel, '累计学习时长'],
    [`${completedCount.toLocaleString('zh-CN')} / ${notes.length.toLocaleString('zh-CN')}`, '已完成整理']
  ].map(([value, label]) => ({ value: value || '', label: label || '' }));
}

async function refreshRecentNotesOverview(): Promise<void> {
  const response = await callBackground('LIST_NOTES', { previewLimit: 3 }).catch(() => null);
  if (!response?.ok) return;
  const reconciledAll = await reconcileOrphanedRunningNotes((response.allNotes || []) as NoteSummary[]);
  const reconciledById = new Map(reconciledAll.map((item) => [item.id, item]));
  renderDashboardStats(reconciledAll);
  workspace.recentNotes = ((response.notes || []) as NoteSummary[]).slice(0, 3).map((rawNote) => {
    const note = reconciledById.get(rawNote.id) || rawNote;
    const status = statusLabels[savedNoteStatus(note)] || '已保存';
    const heading = Keji.formatEpisodeHeading(note);
    return {
      note,
      coverUrl: safeCoverUrl(note.cover),
      title: heading.isMultiPart ? `${heading.courseTitle} · ${heading.mainTitle}` : heading.mainTitle,
      meta: [status, note.summaryPreview || '', formatShortDate(note.updatedAt || note.createdAt)].filter(Boolean).join(' · '),
    };
  });
}

async function refreshOpenBilibiliTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({
    url: ['https://www.bilibili.com/video/*', 'https://bilibili.com/video/*']
  }).catch(() => [] as chrome.tabs.Tab[]);
  const seen = new Set<string>();
  const list: typeof workspace.openBilibiliTabs = [];
  for (const tab of tabs.sort((a, b) => (Number(Boolean(b.active)) - Number(Boolean(a.active))) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)))) {
    if (!tab.id || !tab.url || !/^https:\/\/(www\.)?bilibili\.com\/video\//i.test(tab.url)) continue;
    const bvid = Keji.bvidFromUrl(tab.url);
    const key = `${bvid}:${pageFromBilibiliUrl(tab.url)}`;
    if (!bvid || seen.has(key)) continue;
    seen.add(key);
    list.push({
      tabId: tab.id,
      bvid,
      url: tab.url,
      title: String(tab.title || bvid).replace(/_bilibili.*$|_哔哩哔哩.*$/i, '').trim(),
    });
    if (list.length >= 6) break;
  }
  workspace.openBilibiliTabs = list;
}

function setWorkspaceView(view: string, { record = true } = {}): void {
  const activeView: WorkspaceView = (['create', 'library', 'note', 'settings'].includes(view) ? view : 'create') as WorkspaceView;
  const previousView = workspace.activeView;
  workspace.activeView = activeView;
  if (previousView === 'note' && activeView !== 'note') {
    fc.closeFlashcardSessionQuietly();
    workspace.noteTab = activeDocumentView;
    if (!latestNoteId && !latestVideo && !Object.keys(latestViews).length && workspace.resultVisible) {
      workspace.resultVisible = false;
      workspace.noteTitle = '';
    }
  }
  if (record && location.hash !== `#${activeView}`) {
    history.pushState({ view: activeView, workspaceIndex: ++historyIndex }, '', `#${activeView}`);
  }
  if (previousView !== activeView) window.scrollTo(0, 0);
  if (activeView === 'create') {
    void refreshOpenBilibiliTabs();
    void refreshRecentNotesOverview();
  } else if (activeView === 'library') {
    void renderRecentNotes().catch((error: Error) => showNotice(error.message || '读取笔记库失败。', 'error'));
    void refreshCacheOverview();
  } else if (activeView === 'settings') {
    void refreshCacheOverview();
  }
}

function navigateView(view: WorkspaceView, { group = '', guard = true } = {}): boolean {
  if (guard && !confirmDiscardMarkdownEdits()) return false;
  if (markdownEditing) discardMarkdownEditing();
  if (group) workspace.settingsGroup = group;
  setWorkspaceView(view);
  return true;
}

export function showNoteLibrary(): void {
  navigateView('library');
}

export function openCreateView(): void {
  if (!navigateView('create')) return;
  if (!workspace.currentVideo) requestAnimationFrame(() => elements.videoUrl?.focus());
}

export async function selectOpenBilibiliTab(tabId: number, url: string): Promise<void> {
  if (!confirmDiscardMarkdownEdits()) return;
  if (markdownEditing) discardMarkdownEditing();
  setWorkspaceView('create');
  currentTabId = tabId;
  workspace.videoUrl = url;
  workspace.loadingVideo = true;
  try {
    await loadCurrentVideo(url);
  } finally {
    workspace.loadingVideo = false;
  }
}

export function openSettingsView(group = ''): void {
  navigateView('settings', { group });
}

export function setNoteTab(tab: NoteTab): void {
  if (workspace.noteTab === tab) return;
  if (markdownEditing) {
    if (!confirmDiscardMarkdownEdits()) return;
    discardMarkdownEditing();
  }
  workspace.noteTab = tab;
  if (isNoteViewKey(tab)) {
    activeDocumentView = tab;
    latestTemplate = tab;
    latestMarkdown = latestViews[tab] || '';
    latestFrames = framesFromMarkdown(latestMarkdown);
    renderNoteOutput(latestMarkdown, latestVideo);
  }
  renderExportActions();
}

export function toggleAssistantPane(): void {
  workspace.assistantOpen = !workspace.assistantOpen;
  if (workspace.assistantOpen) disc.syncDiscussionContextState();
}

export function closeAssistantPane(): void {
  workspace.assistantOpen = false;
}

export function openAssistantInMode(mode: DiscussionMode, prefill = '', autoSend = false): void {
  workspace.assistantOpen = true;
  disc.setDiscussionMode(mode);
  disc.syncDiscussionContextState();
  if (prefill) disc.discussionState.input = prefill;
  if (autoSend) {
    void disc.sendDiscussion();
  } else {
    requestAnimationFrame(() => elements.discussionInput?.focus());
  }
}

export function askAssistantAboutQuizItem(item: QuizQuestion, chosen: string): void {
  const optionLines = item.options.map((opt) => `- ${opt.key}. ${opt.text}`).join('\n');
  const statusNote = chosen === item.answer
    ? `我选了 ${chosen}（回答正确），但想再深入理解背后的原理和容易忽略的细节。`
    : `我错选了 ${chosen}（正确答案是 ${item.answer}），请帮我对比分析为什么不是 ${chosen}，以及 ${item.answer} 的关键依据。`;
  const prompt = [
    `关于随堂自测题的追问${item.timestamp ? ` [${item.timestamp}]` : ''}：`,
    item.question,
    optionLines,
    statusNote,
    item.explanation ? `参考解析：${item.explanation}` : '',
  ].filter(Boolean).join('\n');
  openAssistantInMode('qa', prompt, true);
}

function computeCanGenerate(): boolean {
  return Boolean(
    currentVideo
    && !tx.hasUnresolvedTranscriptionConflict()
    && (workspace.transcript.trim() || workspace.modelCapability === 'video_audio')
  );
}

export function applyWorkspaceSettings(settings: Partial<KejiSettings> & { videoInputMode?: unknown } = {}): void {
  workspace.modelConfigured = Boolean(
    String(settings?.baseUrl || '').trim() && String(settings?.model || '').trim()
  );
  workspace.currentModelLabel = String(settings?.model || '').trim();
  workspace.modelCapability = Keji.normalizeCapability(settings?.modelCapability, settings?.videoInputMode);
  workspace.modelPresets = Array.isArray(settings?.modelPresets) ? [...settings.modelPresets] : [];
  workspace.activePresetId = String(settings?.activePresetId || '');
  workspace.remoteBackupConfigured = Boolean(String(settings?.remoteBackupUrl || '').trim());
  workspace.canGenerate = computeCanGenerate();
  renderExportActions();
  void refreshRemoteNotesSyncStatus();
}

export async function switchActiveModelPreset(presetId: string): Promise<void> {
  if (!presetId) return;
  const result = await callBackground('GET_SETTINGS').catch(() => null);
  const current = (result?.settings || {}) as Record<string, unknown>;
  const preset = workspace.modelPresets.find((item) => item.id === presetId);
  if (!preset) return;
  const nextSettings: KejiSettings = {
    ...Keji.defaultSettings,
    ...current,
    baseUrl: preset.baseUrl,
    model: preset.model,
    modelCapability: preset.modelCapability,
    apiKey: preset.apiKey,
    activePresetId: preset.id,
  };
  await chrome.storage.local.set({ settings: nextSettings });
  applyWorkspaceSettings(nextSettings);
  showNotice(`已切换模型：${preset.name || preset.model}`, 'success');
}

export function goBackFromNote(): void {
  navigateView(workspace.noteReturnView === 'create' ? 'create' : 'library');
}

export function toggleEditVideoUrl(): void {
  workspace.editingVideoUrl = !workspace.editingVideoUrl;
  if (workspace.editingVideoUrl) requestAnimationFrame(() => elements.videoUrl?.focus());
}

export function openCourseDrawer(): void {
  workspace.courseDrawerOpen = true;
}

export function closeCourseDrawer(): void {
  workspace.courseDrawerOpen = false;
  workspace.partSearch = '';
}

export async function openNoteSourceVideo(): Promise<void> {
  const url = safeBilibiliVideoUrl(workspace.noteVideoUrl);
  if (!url) return;
  if (currentTabId && matchesVideoTarget(currentVideo, url)) {
    const tab = await chrome.tabs.get(currentTabId).catch(() => null);
    if (tab?.id != null) {
      const focusedWindow = await chrome.windows.getLastFocused().catch(() => null);
      if (focusedWindow && focusedWindow.id !== tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      await chrome.tabs.update(tab.id, { active: true });
      return;
    }
  }
  await chrome.tabs.create({ url });
}

function syncCurrentPartNote(): void {
  const page = Number(currentVideo?.page) || 1;
  const existing = currentVideo ? (workspace.courseNotesByPage[page] || null) : null;
  workspace.currentPartNote = existing;
  if (existing) {
    const templateLabel = isNoteStructureId(existing.template)
      ? getNoteStructure(existing.template).label
      : (existing.template || '');
    const statusText = statusLabels[savedNoteStatus(existing)] || '已保存';
    const dateText = formatShortDate(existing.updatedAt || existing.createdAt);
    workspace.currentPartNoteMeta = [templateLabel, statusText, dateText].filter(Boolean).join(' · ');
  } else {
    workspace.currentPartNoteMeta = '';
  }
  workspace.sameCourseLoaded = Boolean(
    currentVideo && workspace.noteVideoUrl
    && Keji.bvidFromUrl(currentVideo.url)
    && Keji.bvidFromUrl(currentVideo.url) === Keji.bvidFromUrl(workspace.noteVideoUrl)
  );
  if (!workspace.generating) {
    workspace.generateLabel = existing ? '生成 / 更新本节笔记' : '生成学习笔记';
  }
}

async function refreshCourseNotesMap(notesList: NoteSummary[] | null = null): Promise<void> {
  const bvid = Keji.bvidFromUrl(currentVideo?.url);
  if (!bvid) {
    workspace.courseNotesByPage = {};
    syncCurrentPartNote();
    return;
  }
  let allNotes = notesList;
  if (!allNotes) {
    const result = await callBackground('LIST_NOTES').catch(() => null);
    if (!result?.ok) return;
    allNotes = (result.notes || []) as NoteSummary[];
  }
  const map: Record<number, NoteSummary> = {};
  for (const note of allNotes) {
    if (Keji.bvidFromUrl(note.url) !== bvid) continue;
    const page = Number(note.page) || 1;
    const prev = map[page];
    if (!prev || Date.parse(note.updatedAt || note.createdAt || '') > Date.parse(prev.updatedAt || prev.createdAt || '')) {
      map[page] = note;
    }
  }
  workspace.courseNotesByPage = map;
  syncCurrentPartNote();
}

function resetActiveNoteFields(video: VideoTarget | null = null): void {
  markdownEditing = false;
  markdownEditOriginal = '';
  markdownEditMode = 'preview';
  markdownEditImageMap.clear();
  workspace.markdownDraft = '';
  workspace.hasUnsavedMarkdown = false;
  workspace.resultVisible = false;
  workspace.assistantOpen = false;
  latestMarkdown = '';
  latestViews = {};
  activeDocumentView = 'study';
  workspace.noteTab = 'study';
  latestGeneratingView = '';
  latestFailedView = '';
  latestResumableView = '';
  workspace.generatingView = '';
  workspace.failedView = '';
  syncGeneratedViewsState();
  latestNoteTitle = '';
  latestCourseTitle = video?.title || '';
  latestReviewMark = '';
  latestPersonalNote = '';
  workspace.noteTitle = '';
  workspace.reviewMark = '';
  workspace.personalNote = '';
  workspace.personalNoteOpen = false;
  workspace.personalNoteSaving = false;
  latestVideo = video;
  syncNoteEpisodeLabel();
  workspace.noteVideoUrl = video ? safeBilibiliVideoUrl(video.url) : '';
  workspace.generationStageText = '';
  workspace.generationError = '';
  latestCustomPrompt = '';
  latestModelMarkdown = '';
  latestGenerationProgress = null;
  syncGenerationProgressState();
  latestGenerationModels = [];
  latestFrames = [];
  latestNoteId = null;
  latestTranscript = '';
  disc.setDiscussionItems([]);
  fc.setActiveNoteFlashcardData([], '');
  fc.closeFlashcardSessionQuietly();
  qz.setActiveNoteQuizRecord(undefined);
  tx.resetTranscriptionForNewVideo(false);
  latestVisualAnalysis = false;
  latestVisualAnalysisMode = 'transcript-only-or-incomplete';
}

function renderVideo(info: any, forceTranscript = false): void {
  const previousVideo = currentVideo;
  currentVideo = info.video;
  workspace.currentVideo = currentVideo;
  workspace.editingVideoUrl = false;
  currentTabId = info.tabId;
  const changedVideo = !previousVideo || previousVideo.bvid !== currentVideo!.bvid
    || Number(previousVideo.page) !== Number(currentVideo!.page)
    || (previousVideo.cid && currentVideo!.cid && Number(previousVideo.cid) !== Number(currentVideo!.cid));
  if (changedVideo) {
    workspace.currentLessonHasCachedAudio = false;
    resetActiveNoteFields(currentVideo);
    tx.resetTranscriptionForNewVideo(true);
  }
  if (!markdownEditing) workspace.noteTitle = currentVideo!.title || '';
  workspace.videoTitle = currentVideo!.title || '未命名视频';
  workspace.videoMeta = `${currentVideo!.part || '当前小节'}  ·  第 ${currentVideo!.page || 1}/${currentVideo!.pageCount || 1} 节${currentVideo!.duration ? `  ·  ${Keji.formatTime(currentVideo!.duration)}` : ''}`;
  workspace.courseTitle = currentVideo!.title || '未命名视频';
  workspace.videoUrl = currentVideo!.url || workspace.videoUrl;
  renderParts(info.parts || [], currentVideo!.page);
  workspace.captionStatus = info.captionMessage || '字幕已加载。';
  workspace.captionLanguage = info.language || '';
  workspace.captionTracks = info.captionTracks || [];
  const selectedLanguage = info.selectedSubtitleLanguage || '';
  if (!preferredSubtitleLanguage && selectedLanguage) preferredSubtitleLanguage = selectedLanguage;
  workspace.selectedCaptionTrack = selectedLanguage;
  workspace.hasCaptions = Boolean(info.captions?.length);
  if (Array.isArray(info.captions) && info.captions.length && (changedVideo || forceTranscript || !workspace.transcript.trim())) {
    workspace.transcript = info.captions.map((cue: { time: number; text: string }) => `[${Keji.formatTime(cue.time)}] ${cue.text}`).join('\n');
  }
  updateCharacterCount();
  syncCurrentPartNote();
}

function updateCharacterCount(): void {
  const value = workspace.transcript;
  workspace.characterCount = value.length;
  workspace.canGenerate = computeCanGenerate();
  renderExportActions();
}

function renderParts(parts: VideoPart[], currentPage?: number): void {
  workspace.parts = parts;
  workspace.currentPage = Number(currentPage) || 1;
  if (parts.length <= 1) {
    workspace.courseDrawerOpen = false;
    workspace.partSearch = '';
  }
}

export async function selectPart(part: VideoPart): Promise<void> {
  if (!confirmDiscardMarkdownEdits()) return;
  if (markdownEditing) discardMarkdownEditing();
  if (workspace.activeView !== 'create') setWorkspaceView('create');
  if (Number(part.page) === Number(currentVideo?.page)) return;
  workspace.videoUrl = part.url;
  await loadVideoFromUrl();
}

export async function selectAdjacentPart(delta: -1 | 1): Promise<void> {
  if (workspace.parts.length < 2) return;
  const currentIndex = workspace.parts.findIndex((item) => Number(item.page) === Number(workspace.currentPage));
  const baseIndex = currentIndex >= 0 ? currentIndex : Math.max(0, workspace.currentPage - 1);
  const nextPart = workspace.parts[baseIndex + delta];
  if (nextPart) await selectPart(nextPart);
}

function parseBilibiliVideoUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请粘贴有效的 B 站视频链接。'); }
  if (url.protocol !== 'https:' || !/^([a-z0-9-]+\.)?bilibili\.com$/i.test(url.hostname) || !/^\/video\/BV[\w]+/i.test(url.pathname)) {
    throw new Error('只支持 https://www.bilibili.com/video/… 链接。');
  }
  return url;
}

function pageFromBilibiliUrl(url: string): number {
  try {
    return Math.max(1, Number(new URL(url).searchParams.get('p')) || 1);
  } catch {
    return 1;
  }
}

async function findOpenBilibiliTab(target?: { bvid?: string; page?: number; url?: string } | null): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({
    url: ['https://www.bilibili.com/video/*', 'https://bilibili.com/video/*']
  }).catch(() => [] as chrome.tabs.Tab[]);
  const validTabs = tabs.filter((tab) => tab.id && tab.url && /^https:\/\/(www\.)?bilibili\.com\/video\//i.test(tab.url));
  if (!validTabs.length) return null;
  const targetBvid = String(target?.bvid || Keji.bvidFromUrl(target?.url || '')).trim().toUpperCase();
  const targetUrlPage = target?.url ? (() => { try { return Number(new URL(target.url).searchParams.get('p')) || 0; } catch { return 0; } })() : 0;
  const targetPage = Math.max(0, Number(target?.page) || targetUrlPage);
  const candidates = targetBvid
    ? validTabs.filter((tab) => Keji.bvidFromUrl(tab.url || '') === targetBvid)
    : validTabs;
  if (!candidates.length) return null;
  candidates.sort((a, b) => (Number(Boolean(b.active)) - Number(Boolean(a.active))) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  if (targetPage >= 1) {
    const exactPage = candidates.find((tab) => pageFromBilibiliUrl(tab.url || '') === targetPage);
    if (exactPage) return exactPage;
  }
  return candidates[0] || null;
}

function matchesVideoTarget(video: VideoTarget | null, url: string | URL | VideoTarget | null): boolean {
  if (!video || !url) return false;
  try {
    const parsed = url instanceof URL ? url : new URL(typeof url === 'string' ? url : url.url || '');
    const bvid = Keji.bvidFromUrl(parsed.toString());
    const page = Number(parsed.searchParams.get('p')) || 1;
    return Boolean(bvid && bvid === Keji.bvidFromUrl(video.url) && page === (Number(video.page) || 1));
  } catch {
    return false;
  }
}

function clearActiveNoteState(): void {
  resetActiveNoteFields(null);
  latestTemplate = 'study';
  workspace.currentLessonHasCachedAudio = false;
  workspace.currentLessonCacheBytes = 0;
  workspace.currentLessonCacheLabel = '';
  elements.markdownOutput?.replaceChildren();
  renderExportActions();
  syncCurrentPartNote();
}

function clearStaleNoteForTarget(url: string | URL): void {
  if (matchesVideoTarget(latestVideo, url) || matchesVideoTarget(currentVideo, url)) return;
  if (!latestVideo && !latestNoteId) return;
  clearActiveNoteState();
}

async function waitForTabReady(tabId: number): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return tab;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, readyTab?: chrome.tabs.Tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      error ? reject(error) : resolve(readyTab!);
    };
    const timeout = setTimeout(() => finish(new Error('B 站页面加载超时，请稍后重新载入。')), 30000);
    const onUpdated = (updatedId: number, changeInfo: { status?: string }, updatedTab: chrome.tabs.Tab) => {
      if (updatedId === tabId && changeInfo.status === 'complete') finish(null, updatedTab);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((latestTab) => {
      if (latestTab.status === 'complete') finish(null, latestTab);
    }).catch((error: Error) => finish(error));
  });
}

export async function loadVideoFromUrl(): Promise<boolean> {
  let requestedUrl: URL;
  try { requestedUrl = parseBilibiliVideoUrl(workspace.videoUrl.trim()); }
  catch (error) {
    showNotice((error as Error).message, 'error');
    return false;
  }
  if (!confirmDiscardMarkdownEdits()) return false;
  workspace.loadingVideo = true;
  workspace.canReloadCaptions = false;
  const canUseActiveTab = activeTabAccessId && currentTabId === activeTabAccessId && launchOrigin === requestedUrl.origin;
  let navigatedToRequestedVideo = false;
  try {
    const permissionPromise = authorizedOrigins.has(requestedUrl.origin) || canUseActiveTab
      ? Promise.resolve(true)
      : chrome.permissions.request({ origins: [`${requestedUrl.origin}/*`] });
    let tab = currentTabId ? await chrome.tabs.get(currentTabId).catch(() => null) : null;
    if (!await permissionPromise) throw new Error('需要允许课记读取该 B 站视频页面。');
    authorizedOrigins.add(requestedUrl.origin);
    const targetPage = pageFromBilibiliUrl(requestedUrl.toString());
    const openMatch = await findOpenBilibiliTab({ url: requestedUrl.toString(), page: targetPage });
    const currentIsBili = Boolean(tab?.id && /^https:\/\/(www\.)?bilibili\.com\/video\//i.test(tab.url || ''));
    const currentMatchesTarget = Boolean(
      currentIsBili && tab?.url && matchesVideoTarget({ url: tab.url, page: pageFromBilibiliUrl(tab.url) }, requestedUrl)
    );
    if (!currentMatchesTarget && openMatch?.id) {
      tab = openMatch;
    } else if (!currentIsBili || !tab?.id) {
      tab = openMatch?.id ? openMatch : await chrome.tabs.create({ url: requestedUrl.toString(), active: false });
      if (!openMatch?.id) navigatedToRequestedVideo = true;
    }
    const alreadyAtTarget = Boolean(
      tab?.id && tab.url && matchesVideoTarget({ url: tab.url, page: pageFromBilibiliUrl(tab.url) }, requestedUrl)
    );
    if (tab?.id && !alreadyAtTarget) {
      tab = await chrome.tabs.update(tab.id, { url: requestedUrl.toString(), active: false }) || null;
      navigatedToRequestedVideo = true;
    }
    currentTabId = tab?.id || null;
    if (!currentTabId) throw new Error('无法打开 B 站视频标签页。');
    await waitForTabReady(currentTabId);
    await loadCurrentVideo(requestedUrl);
    return matchesVideoTarget(currentVideo, requestedUrl);
  } catch (error) {
    if (navigatedToRequestedVideo) clearStaleNoteForTarget(requestedUrl);
    showNotice((error as Error).message || '载入视频失败。', 'error');
    return false;
  } finally {
    workspace.loadingVideo = false;
    workspace.canReloadCaptions = Boolean(currentVideo);
  }
}

export async function loadCurrentVideo(requestedUrl: string | URL | null = null, forceCaptions = false): Promise<void> {
  workspace.videoTitle = '正在读取 B 站页面…';
  workspace.captionStatus = '正在检查本节字幕…';
  workspace.canReloadCaptions = false;
  try {
    const result = await callBackground('READ_CURRENT_VIDEO', { tabId: currentTabId, subtitleLanguage: preferredSubtitleLanguage });
    if (!result?.ok) throw new Error(result?.error || '读取页面失败。');
    renderVideo(result.video, forceCaptions);
    await tx.refreshActiveTranscription();
    await tx.restoreCachedLessonTranscript(forceCaptions);
    void refreshCurrentLessonCacheStatus(currentVideo, null);
    void refreshCourseNotesMap();
  } catch (error) {
    if (requestedUrl) clearStaleNoteForTarget(requestedUrl);
    currentVideo = null;
    workspace.currentVideo = null;
    workspace.currentLessonHasCachedAudio = false;
    workspace.currentLessonCacheBytes = 0;
    workspace.currentLessonCacheLabel = '';
    workspace.videoTitle = '还没有连接到 B 站视频';
    workspace.videoMeta = '粘贴 B 站视频链接后载入课程。';
    workspace.captionStatus = (error as Error).message;
    workspace.courseTitle = '等待载入视频';
    workspace.courseNotesByPage = {};
    syncCurrentPartNote();
    renderParts([], 0);
    showNotice((error as Error).message || '读取视频失败。', 'error');
    updateCharacterCount();
  } finally {
    workspace.canReloadCaptions = Boolean(currentVideo);
  }
}

function renderNoteOutput(markdown = latestMarkdown, video: VideoTarget | null = latestVideo): void {
  elements.markdownOutput?.replaceChildren(renderMarkdownPreview(markdown, video));
}

async function persistCurrentNote(complete: boolean): Promise<void> {
  const txMeta = tx.getTranscriptionMetadata();
  const views = cleanDocumentViewsMap(latestViews);
  const primaryDoc = getPrimaryDocumentView();
  const flashcardMd = fc.getActiveNoteFlashcardMarkdown();
  const quizState = qz.getActiveNoteQuizRecord();
  const fallbackPracticeMd = latestTemplate === 'flashcards'
    ? flashcardMd
    : latestTemplate === 'quiz'
      ? (quizState?.generatedMarkdown || '')
      : '';
  const markdownToSave = primaryDoc.markdown || fallbackPracticeMd || '';
  const note: Partial<NoteRecord> = {
    title: latestNoteTitle,
    courseTitle: latestCourseTitle || latestVideo?.title || latestNoteTitle,
    reviewMark: latestReviewMark,
    personalNote: latestPersonalNote,
    part: latestVideo?.part,
    page: latestVideo?.page,
    pageCount: latestVideo?.pageCount || 1,
    duration: latestVideo?.duration,
    cover: latestVideo?.cover || '',
    url: latestVideo?.url,
    template: latestTemplate,
    customPrompt: latestCustomPrompt,
    modelMarkdown: latestModelMarkdown,
    generationModel: latestGenerationModels.at(-1) || '',
    generationModels: [...latestGenerationModels],
    generationProgress: latestGenerationProgress,
    generationStatus: latestGenerationStatus,
    generationStartedAt: latestGenerationStartedAt,
    generationError: latestGenerationError,
    complete,
    visualAnalysis: latestVisualAnalysis,
    visualAnalysisMode: latestVisualAnalysisMode,
    transcript: latestTranscript,
    transcriptSegments: txMeta.segments,
    detectedLanguages: txMeta.detectedLanguages,
    views,
    flashcardMarkdown: flashcardMd,
    flashcardReview: fc.getActiveNoteFlashcardReview(),
    quizState,
    conversation: disc.getDiscussionItems(),
    markdown: isPlaceholderMarkdown(markdownToSave) ? '' : markdownToSave
  };
  if (latestNoteId) note.id = latestNoteId;
  const result = latestNoteId
    ? await callBackground('UPDATE_NOTE', { note })
    : await callBackground('SAVE_NOTE', { note });
  if (!result?.ok) throw new Error(result?.error || '笔记保存失败。');
  latestNoteId = result.note?.id || latestNoteId;
}

async function persistGenerationJob(job: GenerationJob, complete: boolean): Promise<void> {
  const target = job.targetTemplate;
  const targetMarkdown = isNoteViewKey(target) ? (job.views[target] || '')
    : target === 'flashcards' ? job.flashcardMarkdown : (job.quizState?.generatedMarkdown || '');
  const note: Partial<NoteRecord> = {
    title: job.noteTitle,
    courseTitle: job.courseTitle || job.video.title || job.noteTitle,
    part: job.video.part, page: job.video.page, pageCount: job.video.pageCount || 1,
    duration: job.video.duration, cover: job.video.cover || '', url: job.video.url,
    template: target, customPrompt: job.customPrompt,
    modelMarkdown: job.modelMarkdown,
    generationModel: job.generationModels.at(-1) || '',
    generationModels: [...job.generationModels],
    generationProgress: job.generationProgress, generationStatus: job.generationStatus,
    generationStartedAt: job.generationStartedAt, generationError: job.generationError,
    complete, visualAnalysis: job.visualAnalysis, visualAnalysisMode: job.visualAnalysisMode,
    transcript: job.transcript, transcriptSegments: job.transcriptSegments,
    detectedLanguages: job.detectedLanguages,
    views: cleanDocumentViewsMap(job.views),
    flashcardMarkdown: job.flashcardMarkdown,
    flashcardReview: job.flashcardReview,
    quizState: job.quizState,
    conversation: job.conversation,
    markdown: isPlaceholderMarkdown(targetMarkdown) ? '' : targetMarkdown
  };
  const result = job.noteId
    ? await callBackground('UPDATE_GENERATION_NOTE', {
        input: { id: job.noteId, targetTemplate: target, expectedMarkdown: job.expectedMarkdown,
          saveSnapshot: job.snapshotPending, note }
      })
    : await callBackground('SAVE_NOTE', { note });
  if (!result?.ok) throw new Error(result?.error || '笔记保存失败。');
  if (targetMarkdown && targetMarkdown !== job.expectedMarkdown) job.snapshotPending = false;
  job.expectedMarkdown = targetMarkdown || job.expectedMarkdown;
  const savedId = result.note?.id || job.noteId;
  if (savedId) {
    const wasNull = !job.noteId;
    job.noteId = savedId;
    if (wasNull && isViewingJob({ noteId: null, lessonKey: job.lessonKey, video: job.video })) {
      latestNoteId = savedId;
    }
    syncGenerationUiFlags();
  }
}

export async function openGeneratingNote(): Promise<void> {
  const targetId = activeGenJob?.noteId || activeVisualJob?.noteId || '';
  if (targetId) {
    await openSavedNote({ id: targetId }, { returnView: workspace.noteReturnView || 'library' });
    return;
  }
  if (activeGenJob && isSameLesson(currentVideo, activeGenJob.video)) {
    const job = activeGenJob;
    resetActiveNoteFields(job.video);
    latestViews = cleanDocumentViewsMap(job.views);
    activeDocumentView = isNoteViewKey(job.targetTemplate) ? job.targetTemplate : 'study';
    workspace.noteTab = job.targetTemplate;
    latestMarkdown = latestViews[activeDocumentView] || '';
    latestCourseTitle = job.courseTitle;
    latestNoteTitle = job.noteTitle;
    workspace.noteTitle = job.noteTitle;
    latestVideo = { ...job.video };
    workspace.noteVideoUrl = safeBilibiliVideoUrl(job.video.url);
    syncNoteEpisodeLabel();
    latestTemplate = job.targetTemplate;
    latestCustomPrompt = job.customPrompt;
    latestModelMarkdown = job.modelMarkdown;
    latestGenerationProgress = job.generationProgress;
    latestGenerationStatus = job.generationStatus;
    latestGeneratingView = job.targetTemplate;
    latestResumableView = job.targetTemplate;
    workspace.generationStageText = job.stageText;
    syncGenerationProgressState();
    renderNoteOutput();
    renderExportActions();
    workspace.resultVisible = true;
    setWorkspaceView('note');
  }
}

function renderExportActions(): void {
  const effectiveTranscript = getEffectiveActiveTranscript();
  const transcriptUnchanged = !isSameLesson(currentVideo, latestVideo)
    || workspace.transcript.trim() === latestTranscript.trim();
  const hasTranscriptOrAudioCapability = Boolean(
    effectiveTranscript || workspace.modelCapability === 'video_audio'
  );
  workspace.canResumeGeneration = Boolean(latestGenerationProgress
    && latestGenerationProgress.completedChunks < latestGenerationProgress.totalChunks
    && latestModelMarkdown
    && transcriptUnchanged
    && (!latestResumableView || workspace.noteTab === latestResumableView));
  const textGenerationComplete = !latestGenerationProgress
    || latestGenerationProgress.completedChunks >= latestGenerationProgress.totalChunks;

  if (!workspace.activeNoteGenerating) syncGenerationProgressState();
  syncGenerationUiFlags();
  syncGeneratedViewsState();
  workspace.generatingView = latestGeneratingView;
  workspace.failedView = latestFailedView;

  const activeDocMd = isNoteViewKey(workspace.noteTab) ? (latestViews[workspace.noteTab] || '') : '';
  const primaryDoc = getPrimaryDocumentView();
  workspace.hasMarkdown = Boolean(activeDocMd);
  workspace.resultVisible = Boolean(
    latestVideo
    || latestNoteId
    || Object.keys(latestViews).length
    || fc.getActiveNoteFlashcardMarkdown()
    || qz.getActiveNoteQuizRecord()?.generatedMarkdown
    || fc.flashcardState.crossNote
  );
  workspace.markdownEditing = markdownEditing;
  workspace.markdownMode = markdownEditMode;
  workspace.canEditTitle = Boolean(
    workspace.resultVisible && !fc.flashcardState.crossNote && textGenerationComplete && !workspace.generating
  );
  workspace.canRegenerateActiveTab = Boolean(
    latestVideo && !workspace.generating && hasTranscriptOrAudioCapability
  );
  const copyState = getCopyableContentForCurrentTab();
  workspace.canCopyCurrentTab = Boolean(copyState.text.trim());
  workspace.copyButtonLabel = copyState.label;
  workspace.canExportBundle = Boolean(
    Object.keys(latestViews).length || fc.getActiveFlashcardCopyMarkdown() || qz.getActiveQuizCopyMarkdown()
  );

  const hasUncapturedKeyframes = /关键时刻\s*·[^\n]*（截图未能捕获/.test(activeDocMd);
  workspace.showRetryVisualAnalysis = Boolean(
    isNoteViewKey(workspace.noteTab)
    && activeDocMd
    && latestVideo
    && Keji.supportsImage(workspace.modelCapability)
    && (!latestVisualAnalysis || hasUncapturedKeyframes)
    && textGenerationComplete
    && hasTranscriptOrAudioCapability
    && transcriptUnchanged
  );
  disc.syncDiscussionContextState();
  fc.syncActiveNoteFlashcards({
    noteId: latestNoteId,
    title: latestNoteTitle || latestVideo?.title || '',
    markdown: primaryDoc.markdown,
    transcript: effectiveTranscript,
    frames: framesFromMarkdown(primaryDoc.markdown),
    template: latestTemplate,
    videoUrl: latestVideo?.url || '',
    editing: markdownEditing,
  });
  qz.syncActiveNoteQuiz({
    noteId: latestNoteId,
    title: latestNoteTitle || latestVideo?.title || '',
    markdown: primaryDoc.markdown,
    transcript: effectiveTranscript,
    frames: framesFromMarkdown(primaryDoc.markdown),
    template: latestTemplate,
    videoUrl: latestVideo?.url || '',
    editing: markdownEditing,
  });
}

function hasUnsavedMarkdownEdits(): boolean {
  return markdownEditing && workspace.markdownDraft !== markdownEditOriginal;
}

function confirmDiscardMarkdownEdits(): boolean {
  return !hasUnsavedMarkdownEdits() || window.confirm('Markdown 笔记有未保存修改。放弃这些修改并继续吗？');
}

export function setMarkdownEditMode(mode: MarkdownMode): void {
  if (!latestMarkdown || !['edit', 'preview'].includes(mode)) return;
  if (!markdownEditing) {
    const folded = foldMarkdownImagesForEdit(latestMarkdown);
    markdownEditImageMap = folded.imageMap;
    markdownEditOriginal = folded.draft;
    workspace.markdownDraft = folded.draft;
    workspace.hasUnsavedMarkdown = false;
    markdownEditing = true;
  }
  markdownEditMode = mode;
  workspace.markdownMode = mode;
  workspace.markdownEditing = true;
  renderExportActions();
  if (mode === 'preview') {
    renderNoteOutput(unfoldMarkdownImagesFromEdit(workspace.markdownDraft, markdownEditImageMap));
  }
  if (mode === 'edit') {
    requestAnimationFrame(() => elements.markdownEditor?.focus());
  }
}

function discardMarkdownEditing(): void {
  renderNoteOutput();
  markdownEditing = false;
  markdownEditOriginal = '';
  markdownEditImageMap.clear();
  workspace.markdownDraft = '';
  workspace.hasUnsavedMarkdown = false;
  markdownEditMode = 'preview';
  workspace.markdownEditing = false;
  workspace.markdownMode = 'preview';
  renderExportActions();
}

export function cancelMarkdownEditing(): void {
  if (!markdownEditing || !confirmDiscardMarkdownEdits()) return;
  discardMarkdownEditing();
}

export async function saveMarkdownEditing(): Promise<void> {
  const updated = unfoldMarkdownImagesFromEdit(workspace.markdownDraft, markdownEditImageMap).trim();
  if (!updated) return showNotice('Markdown 笔记不能为空。', 'error');
  const viewKey = activeDocumentView;
  const previousViews = { ...latestViews };
  const previousMarkdown = latestMarkdown;
  const previousModelMarkdown = latestModelMarkdown;
  latestViews[viewKey] = updated;
  latestMarkdown = updated;
  latestModelMarkdown = noteBodyMarkdown(updated);
  workspace.markdownSaving = true;
  try {
    if (latestNoteId) {
      const result = await callBackground('REVISE_NOTE_VIEW', {
        input: { id: latestNoteId, viewKey, expectedMarkdown: previousViews[viewKey] || '', markdown: updated }
      });
      if (!result?.ok) throw new Error(result?.error || '保存笔记修改失败。');
    } else {
      await persistCurrentNote(latestVisualAnalysis);
    }
    markdownEditing = false;
    markdownEditOriginal = '';
    markdownEditImageMap.clear();
    workspace.markdownDraft = '';
    workspace.hasUnsavedMarkdown = false;
    markdownEditMode = 'preview';
    workspace.markdownEditing = false;
    workspace.markdownMode = 'preview';
    latestFrames = framesFromMarkdown(latestMarkdown);
    renderNoteOutput();
    renderExportActions();
    showNotice('笔记修改已保存到本机。', 'success');
  } catch (error) {
    latestViews = previousViews;
    latestMarkdown = previousMarkdown;
    latestModelMarkdown = previousModelMarkdown;
    showNotice(`保存失败，修改仍保留在编辑框中：${(error as Error).message || '存储空间不足'}`, 'error');
  } finally {
    workspace.markdownSaving = false;
  }
}

export function updateMarkdownDraftPreview(): void {
  if (!markdownEditing) return;
  workspace.hasUnsavedMarkdown = workspace.markdownDraft !== markdownEditOriginal;
}

export function togglePersonalNoteCard(): void {
  workspace.personalNoteOpen = !workspace.personalNoteOpen;
}

export async function savePersonalNote(forceFeedback = false): Promise<void> {
  const nextPersonal = String(workspace.personalNote || '');
  const trimmed = nextPersonal.trim();
  const normalized = trimmed ? nextPersonal : '';
  if (!forceFeedback && normalized === latestPersonalNote) return;
  const previous = latestPersonalNote;
  latestPersonalNote = normalized;
  if (!latestNoteId) {
    if (!latestVideo) return;
    workspace.personalNoteSaving = true;
    try {
      await persistCurrentNote(latestVisualAnalysis);
    } catch (error) {
      latestPersonalNote = previous;
      workspace.personalNote = previous;
      showNotice(`保存个人批注失败：${(error as Error).message || '存储失败'}`, 'error');
    } finally {
      workspace.personalNoteSaving = false;
    }
    return;
  }
  workspace.personalNoteSaving = true;
  try {
    const result = await callBackground('UPDATE_NOTE', { note: { id: latestNoteId, personalNote: normalized } });
    if (!result?.ok) throw new Error(result?.error || '保存个人批注失败。');
    savedNotes = savedNotes.map((item) => item.id === latestNoteId ? { ...item, personalNote: normalized.trim().slice(0, 160) } : item);
    refreshLibraryViewsIfVisible();
    if (forceFeedback) showNotice('个人批注已保存到本机。', 'success');
  } catch (error) {
    latestPersonalNote = previous;
    workspace.personalNote = previous;
    showNotice(`保存个人批注失败：${(error as Error).message || '存储失败'}`, 'error');
  } finally {
    workspace.personalNoteSaving = false;
  }
}

export async function setActiveNoteReviewMark(mark: ReviewMark): Promise<void> {
  const nextMark: ReviewMark = latestReviewMark === mark ? '' : mark;
  const previous = latestReviewMark;
  latestReviewMark = nextMark;
  workspace.reviewMark = nextMark;
  if (!latestNoteId) {
    if (latestVideo) await persistCurrentNote(latestVisualAnalysis).catch(() => {});
    return;
  }
  try {
    const result = await callBackground('UPDATE_NOTE', { note: { id: latestNoteId, reviewMark: nextMark } });
    if (!result?.ok) throw new Error(result?.error || '更新复习标记失败。');
    savedNotes = savedNotes.map((item) => item.id === latestNoteId ? { ...item, reviewMark: nextMark } : item);
    refreshLibraryViewsIfVisible();
  } catch (error) {
    latestReviewMark = previous;
    workspace.reviewMark = previous;
    showNotice((error as Error).message || '更新复习标记失败。', 'error');
  }
}

async function appendEntryToPersonalNote(entry: string, duplicateProbe: string, successMessage: string): Promise<void> {
  const current = String(workspace.personalNote || '').trim();
  if (duplicateProbe && current.includes(duplicateProbe)) {
    workspace.personalNoteOpen = true;
    showNotice('该条要点已在「我的批注」中。', 'info');
    return;
  }
  workspace.personalNote = current ? `${current}\n\n${entry}` : entry;
  workspace.personalNoteOpen = true;
  await savePersonalNote(false);
  if (latestPersonalNote.trim()) showNotice(successMessage, 'success');
}

export async function saveDiscussionItemToPersonalNote(index: number): Promise<void> {
  const items = disc.getDiscussionItems();
  const item = items[index];
  if (!item || item.role === 'user') return;
  const prevUser = items[index - 1]?.role === 'user' ? String(items[index - 1]!.content || '').trim() : '';
  const questionHead = prevUser ? prevUser.replace(/\s+/g, ' ').slice(0, 64) : '';
  const label = item.mode === 'feynman' ? '费曼批改' : '助教答疑';
  const cleanedBody = String(item.content || '').trim().replace(/\n{3,}/g, '\n\n').slice(0, 800);
  if (!cleanedBody) return;
  const indentedBody = cleanedBody.split(/\r?\n/).map((line) => `  ${line}`).join('\n');
  const entry = `- **[${label}]**${questionHead ? ` ${questionHead}` : ''}\n${indentedBody}`;
  await appendEntryToPersonalNote(entry, cleanedBody.slice(0, 36), '已记入本节「我的批注」。');
}

export async function saveQuizItemToPersonalNote(item: QuizQuestion, chosen: string): Promise<void> {
  const correctOpt = item.options.find((opt) => opt.key === item.answer);
  const answerText = correctOpt ? `${correctOpt.key}. ${correctOpt.text}` : item.answer;
  const wrongHint = chosen && chosen !== item.answer ? `曾误选 ${chosen}；` : '';
  const detailLine = `  - 正解：${answerText}${wrongHint || item.explanation ? `（${wrongHint}${item.explanation || ''}）` : ''}`;
  const entry = `- **[自测要点${item.timestamp ? ` · [${item.timestamp}]` : ''}]** ${item.question}\n${detailLine}`;
  await appendEntryToPersonalNote(entry, item.question.slice(0, 28), '已将该题要点记入「我的批注」。');
}

export async function saveNoteTitleInline(): Promise<void> {
  if (!workspace.canEditTitle || workspace.titleSaving) return;
  const nextTitle = workspace.noteTitle.trim();
  if (!nextTitle) {
    workspace.noteTitle = latestNoteTitle;
    showNotice('笔记标题不能为空。', 'error');
    return;
  }
  if (nextTitle === latestNoteTitle) {
    workspace.noteTitle = latestNoteTitle;
    return;
  }
  const previousTitle = latestNoteTitle;
  latestNoteTitle = nextTitle;
  workspace.noteTitle = nextTitle;
  syncNoteEpisodeLabel();
  if (!latestNoteId) return;
  workspace.titleSaving = true;
  try {
    const result = await callBackground('UPDATE_NOTE', { note: { id: latestNoteId, title: nextTitle } });
    if (!result?.ok) throw new Error(result?.error || '保存标题失败。');
    savedNotes = savedNotes.map((item) => item.id === latestNoteId ? { ...item, title: nextTitle } : item);
    void refreshCourseNotesMap();
    renderExportActions();
    showNotice('标题已保存。', 'success');
  } catch (error) {
    latestNoteTitle = previousTitle;
    workspace.noteTitle = previousTitle;
    syncNoteEpisodeLabel();
    showNotice(`标题保存失败：${(error as Error).message || '存储空间不足'}`, 'error');
  } finally {
    workspace.titleSaving = false;
  }
}

export function revertNoteTitleInline(inputElement: HTMLInputElement | HTMLTextAreaElement | null = null): void {
  workspace.noteTitle = latestNoteTitle;
  inputElement?.blur();
}

export function changeCaptionTrack(): void {
  preferredSubtitleLanguage = workspace.selectedCaptionTrack;
  clearActiveNoteState();
  void loadCurrentVideo(null, true);
}

export function onNotesSearchInput(): void {
  if (notesSearchTimer) clearTimeout(notesSearchTimer);
  notesSearchTimer = setTimeout(() => {
    void filterSavedNotes().catch((error: Error) => showNotice(error.message || '搜索笔记失败。', 'error'));
  }, 180);
}

export function onNotesFilterChange(): void {
  void filterSavedNotes().catch((error: Error) => showNotice(error.message || '筛选笔记失败。', 'error'));
}

export function setNotesStatusFilter(status: string): void {
  workspace.notesStatusFilter = status;
  onNotesFilterChange();
}

export function setNotesReviewFilter(mark: ReviewMark): void {
  workspace.notesReviewFilter = mark;
  onNotesFilterChange();
}

export function resetNotesFilters(): void {
  workspace.notesSearch = '';
  workspace.notesModelFilter = '';
  workspace.notesStatusFilter = '';
  workspace.notesReviewFilter = '';
  void filterSavedNotes().catch((error: Error) => showNotice(error.message || '重置筛选失败。', 'error'));
}

export function setLibraryViewMode(mode: LibraryViewMode | string): void {
  workspace.libraryViewMode = mode === 'flat' ? 'flat' : 'grouped';
}

export async function returnToVideo(): Promise<void> {
  if (!currentTabId) return;
  const tab = await chrome.tabs.get(currentTabId).catch(() => null);
  if (!tab?.id) return showNotice('原视频标签页已关闭，请重新载入课程链接。', 'error');
  const focusedWindow = await chrome.windows.getLastFocused();
  if (focusedWindow.id !== tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

export function handleWorkspacePopState(event: PopStateEvent): void {
  if (restoringHistory) {
    restoringHistory = false;
    return;
  }
  const nextIndex = Number(event.state?.workspaceIndex) || 0;
  if (!confirmDiscardMarkdownEdits()) {
    const delta = historyIndex - nextIndex;
    if (delta) {
      restoringHistory = true;
      history.go(delta);
    } else {
      history.replaceState({ ...history.state, workspaceIndex: historyIndex }, '', `#${workspace.activeView}`);
    }
    return;
  }
  historyIndex = nextIndex;
  if (markdownEditing) discardMarkdownEditing();
  setWorkspaceView(location.hash.slice(1), { record: false });
}

export async function retryVisualAnalysis(): Promise<void> {
  const lessonKey = Keji.lessonKey(latestVideo);
  if (!lessonKey || !navigator.locks) return showNotice('当前浏览器无法保护并行任务。', 'error');
  await navigator.locks.request(`keji-lesson-${lessonKey}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return showNotice('本节正在另一工作区处理。', 'info');
    await runVisualRetry();
  });
}

async function runVisualRetry(): Promise<void> {
  if (workspace.generating || !latestMarkdown || !latestVideo || !isNoteViewKey(workspace.noteTab)) return;
  if (!Keji.supportsImage(workspace.modelCapability)) {
    return showNotice('当前模型为「仅文本」模式，请在设置中切换到支持图片或视频的能力后再补充画面分析。', 'info');
  }
  if (Keji.requiresTranscript(workspace.modelCapability) && !latestTranscript.trim()) {
    return showNotice('缺少课程文字稿，无法执行画面校对。', 'error');
  }
  let resolvedTabId = currentTabId;
  let sameOpenVideo = Boolean(currentVideo && resolvedTabId
    && Keji.bvidFromUrl(currentVideo.url) === Keji.bvidFromUrl(latestVideo.url)
    && Number(currentVideo.page) === Number(latestVideo.page));
  const cachedVideo = await getCachedVideo(latestVideo).catch(() => null);
  if (!sameOpenVideo && !cachedVideo?.file) {
    const openTab = await findOpenBilibiliTab(latestVideo);
    if (openTab?.id && openTab.url && matchesVideoTarget({ url: openTab.url, page: pageFromBilibiliUrl(openTab.url) }, latestVideo)) {
      resolvedTabId = openTab.id;
      sameOpenVideo = true;
    }
  }
  if (!sameOpenVideo && !cachedVideo?.file) {
    showNotice('本节暂无缓存的原视频流；请先在浏览器标签页打开本节对应的 B 站视频，再重试画面分析。', 'error');
    return;
  }
  if (isSameLesson(currentVideo, latestVideo) && workspace.transcript.trim() !== latestTranscript.trim()) {
    showNotice('文字稿已修改。请先重新生成笔记，再进行画面分析。', 'error');
    return;
  }

  const targetNoteId = latestNoteId;
  const targetVideo = { ...latestVideo };
  const targetTranscript = latestTranscript;
  const targetNoteTitle = latestNoteTitle || targetVideo.title || '课程笔记';
  const targetViewKey = workspace.noteTab;
  const stillViewingVisualTarget = () => targetNoteId
    ? latestNoteId === targetNoteId
    : (!latestNoteId && isSameLesson(latestVideo, targetVideo));
  const persistVisualPatch = async (patch: Partial<NoteRecord>) => {
    if (!targetNoteId) {
      if (stillViewingVisualTarget()) {
        await persistCurrentNote(Boolean(patch.complete));
      }
      return;
    }
    const result = await callBackground('UPDATE_VISUAL_NOTE', { input: {
      id: targetNoteId,
      viewKey: targetViewKey,
      expectedMarkdown: originalMarkdown,
      markdown: patch.views?.[targetViewKey] || originalMarkdown,
      visualAnalysis: Boolean(patch.visualAnalysis),
      visualAnalysisMode: patch.visualAnalysisMode || 'transcript-only-or-incomplete',
      complete: Boolean(patch.complete)
    } });
    if (!result?.ok) throw new Error(result?.error || '保存画面分析结果失败。');
  };

  if (elements.retryVisualAnalysis) elements.retryVisualAnalysis.disabled = true;
  workspace.generating = true;
  generationCancelled = false;
  activeGenerationTaskId = crypto.randomUUID();
  activeCaptureAbortController = new AbortController();
  activeVisualJob = {
    noteId: targetNoteId,
    video: targetVideo,
    label: formatJobLabel(targetVideo, targetNoteTitle),
    stageText: '正在准备画面分析…'
  };
  syncGenerationUiFlags();

  const originalMarkdown = latestMarkdown;
  const initialBodyMarkdown = noteBodyMarkdown(latestMarkdown)
    .replace(/!\[([^\]]*)\]\(data:image\/[^;]+;base64,[^)]+\)/g, '[视频关键帧：$1]');
  const previouslyCapturedFrames = [...latestFrames];
  try {
    workspace.generationError = '';
    const settingsResult = await callBackground('GET_SETTINGS');
    const result = await runVisualAnalysisPipeline({
      video: targetVideo,
      transcript: targetTranscript,
      initialBodyMarkdown,
      settings: settingsResult?.settings,
      cachedVideo,
      sameOpenVideo,
      tabId: resolvedTabId,
      generationTaskId: activeGenerationTaskId,
      signal: activeCaptureAbortController.signal,
      isCancelled: () => generationCancelled,
      fallbackFrames: previouslyCapturedFrames,
      revertToInitialOnFullVideoCaptureError: false,
      throwOnFrameEnrichError: true
    });
    if (!result.visualAnalysis) throw new Error(result.visualError || '本节暂未能完成画面分析，请稍后重试。');

    const finalMarkdown = restoreScreenshotEmbeds(
      formatNoteMarkdown(targetNoteTitle, targetVideo, result.bodyMarkdown),
      originalMarkdown
    );
    await persistVisualPatch({
      visualAnalysis: true,
      visualAnalysisMode: result.visualAnalysisMode,
      generationError: '',
      complete: true,
      views: { [targetViewKey]: finalMarkdown },
    });

    if (stillViewingVisualTarget()) {
      latestVisualAnalysis = true;
      latestVisualAnalysisMode = result.visualAnalysisMode;
      latestFrames = result.frames;
      latestGenerationError = '';
      latestMarkdown = finalMarkdown;
      latestViews[targetViewKey] = finalMarkdown;
      renderNoteOutput();
      renderExportActions();
      workspace.generationStageText = '';
    }
    showNotice(result.captureFailed
      ? '画面分析已完成，部分截图未能捕获。'
      : result.frames.length
        ? `画面分析已完成，已嵌入 ${result.frames.length} 张关键帧。`
        : '画面分析已完成，本节未发现需要额外截取的重点画面。', 'success');
  } catch (error) {
    const err = error as Error & { cancelled?: boolean };
    if (stillViewingVisualTarget()) {
      latestViews[targetViewKey] = originalMarkdown;
      latestMarkdown = originalMarkdown;
      latestVisualAnalysis = false;
      latestVisualAnalysisMode = 'transcript-only-or-incomplete';
      latestFrames = previouslyCapturedFrames;
      renderNoteOutput();
      renderExportActions();
      workspace.generationStageText = '';
    }
    if (generationCancelled || err?.cancelled || err?.name === 'AbortError') {
      showNotice('已停止画面分析。', 'info');
    } else {
      const message = `画面分析未完成：${err.message || '未知错误'}`;
      if (stillViewingVisualTarget()) workspace.generationError = message;
      showNotice(message, 'error');
    }
  } finally {
    activeVisualJob = null;
    workspace.generating = false;
    activeGenerationTaskId = '';
    activeCaptureAbortController = null;
    if (elements.retryVisualAnalysis) elements.retryVisualAnalysis.disabled = false;
    syncGenerationUiFlags();
    renderExportActions();
    refreshLibraryViewsIfVisible();
    if (stillViewingVisualTarget()) void refreshCurrentLessonCacheStatus(targetVideo, targetNoteId);
  }
}

function downloadNoteBundle(
  note: Pick<NoteRecord, 'title' | 'markdown' | 'views' | 'flashcardMarkdown' | 'quizState' | 'template' | 'personalNote'>
): void {
  const views = extractViewsFromNote(note);
  const legacyCardMd = (!note.flashcardMarkdown && note.template === 'flashcards' && !isPlaceholderMarkdown(note.markdown))
    ? note.markdown
    : '';
  const legacyQuizMd = (!note.quizState?.generatedMarkdown && note.template === 'quiz' && !isPlaceholderMarkdown(note.markdown))
    ? note.markdown
    : '';
  const bundle = createNoteBundleZip({
    title: note.title,
    markdown: isPlaceholderMarkdown(note.markdown) ? '' : note.markdown,
    views,
    flashcardMarkdown: note.flashcardMarkdown || legacyCardMd,
    quizMarkdown: note.quizState?.generatedMarkdown || legacyQuizMd,
    personalNote: note.personalNote,
  });
  downloadBlob(bundle.filename, new Blob([bundle.zip.buffer as ArrayBuffer], { type: 'application/zip' }));
  showNotice(bundle.imageCount ? `已导出资源包（含 ${bundle.imageCount} 张截图）。` : '已导出资源包。', 'success');
}

export async function exportCurrentNoteBundle(): Promise<void> {
  const primary = getPrimaryDocumentView();
  const flashcardMarkdown = fc.getActiveNoteFlashcardMarkdown();
  const quizMarkdown = qz.getActiveNoteQuizRecord()?.generatedMarkdown || '';
  if (!primary.markdown && !flashcardMarkdown && !quizMarkdown && !latestPersonalNote.trim()) return;
  try {
    downloadNoteBundle({
      title: latestNoteTitle || latestVideo?.title || '课程笔记',
      markdown: latestMarkdown || primary.markdown || flashcardMarkdown || quizMarkdown,
      template: latestTemplate,
      views: { ...latestViews },
      flashcardMarkdown,
      quizState: quizMarkdown ? { generatedMarkdown: quizMarkdown, answers: {} } : undefined,
      personalNote: latestPersonalNote,
    });
  } catch (error) {
    showNotice((error as Error).message || '资源包导出失败。', 'error');
  }
}

export async function cancelGeneration(): Promise<void> {
  if ((!activeGenJob && !workspace.generating) || generationCancelled) return;
  generationCancelled = true;
  if (activeGenJob) {
    activeGenJob.stageText = '正在停止生成…';
  }
  if (!activeGenJob || isViewingJob(activeGenJob)) {
    workspace.generationStageText = '正在停止生成…';
  }
  activeCaptureAbortController?.abort();
  if (activeGenerationTaskId) {
    await callBackground('CANCEL_GENERATION', { taskId: activeGenerationTaskId }).catch(() => {});
  }
}

async function triggerActiveNoteTabGeneration(confirmOverwrite: boolean): Promise<void> {
  if (workspace.generating || !latestVideo || !isNoteViewKey(workspace.noteTab)) return;
  if (Keji.requiresTranscript(workspace.modelCapability) && !getEffectiveActiveTranscript()) return;
  if (markdownEditing) {
    if (!confirmDiscardMarkdownEdits()) return;
    discardMarkdownEditing();
  }
  const targetTemplate = workspace.noteTab;
  const template = getNoteStructure(targetTemplate);
  if (template.id === 'custom' && !workspace.customPrompt.trim() && latestCustomPrompt.trim()) {
    workspace.customPrompt = latestCustomPrompt;
  }
  if (template.id === 'custom' && !workspace.customPrompt.trim()) {
    showNotice('请先填写自定义笔记要求后再生成。', 'info');
    requestAnimationFrame(() => {
      const inlinePrompt = elements.customTabPromptInline as HTMLTextAreaElement | null;
      if (inlinePrompt) {
        const details = inlinePrompt.closest('details');
        if (details) details.open = true;
        inlinePrompt.focus();
      } else {
        elements.customTabPrompt?.focus();
      }
    });
    return;
  }
  if (confirmOverwrite && !window.confirm(`按「${template.label}」重新生成将替换当前标签页内容（其他标签页不受影响），确定继续吗？`)) {
    return;
  }
  workspace.selectedTemplate = targetTemplate;
  await generate(false, { skipConfirm: true, fromOpenedNote: true, targetTemplate });
}

export async function generateActiveNoteTab(): Promise<void> {
  await triggerActiveNoteTabGeneration(false);
}

export async function regenerateActiveNoteTab(): Promise<void> {
  await triggerActiveNoteTabGeneration(true);
}

export async function generate(
  resume = false,
  options: { skipConfirm?: boolean; fromOpenedNote?: boolean; targetTemplate?: TemplateId } = {}
): Promise<void> {
  const target = (resume || options.fromOpenedNote) ? latestVideo : currentVideo;
  const lessonKey = Keji.lessonKey(target);
  if (!lessonKey || !navigator.locks) return showNotice('当前浏览器无法保护并行任务。', 'error');
  await navigator.locks.request(`keji-lesson-${lessonKey}`, { ifAvailable: true }, async (lock) => {
    if (!lock) return showNotice('本节正在另一工作区处理。', 'info');
    await runGeneration(resume, options);
  });
}

async function runGeneration(
  resume = false,
  options: { skipConfirm?: boolean; fromOpenedNote?: boolean; targetTemplate?: TemplateId } = {}
): Promise<void> {
  if (workspace.generating || activeGenJob || activeVisualJob) return;
  const isResume = Boolean(resume);
  const fromOpenedNote = Boolean(options?.fromOpenedNote);
  const skipConfirm = Boolean(options?.skipConfirm);
  if (!isResume && !fromOpenedNote && tx.hasUnresolvedTranscriptionConflict()) {
    return showNotice('请先查看本次识别稿，并选择替换文字稿或继续使用当前稿。', 'error');
  }
  if (!isResume && !confirmDiscardMarkdownEdits()) return;
  const targetTemplate: TemplateId = isResume
    ? (latestResumableView || latestTemplate)
    : (options.targetTemplate || workspace.selectedTemplate);
  const video = (isResume || fromOpenedNote) ? latestVideo : currentVideo;
  const transcript = (isResume || fromOpenedNote)
    ? (latestTranscript.trim() || (isSameLesson(currentVideo, video) ? workspace.transcript.trim() : ''))
    : workspace.transcript.trim();
  if (isResume && isSameLesson(currentVideo, video) && workspace.transcript.trim() !== transcript) {
    return showNotice('文字稿已修改，不能用旧分段进度续跑；请重新生成以确保内容一致。', 'error');
  }
  const useDirectAudio = !transcript && workspace.modelCapability === 'video_audio';
  if (!transcript && !useDirectAudio) {
    showNotice('先读取字幕，或粘贴课程文字稿。', 'error');
    workspace.transcriptExpanded = true;
    requestAnimationFrame(() => elements.transcript?.focus());
    return;
  }
  if (!video) return showNotice('请先载入 B 站视频。', 'error');
  const activeCustomPrompt = isResume ? latestCustomPrompt : workspace.customPrompt;
  if (!isResume && targetTemplate === 'custom' && !activeCustomPrompt.trim()) {
    showNotice('请先填写自定义笔记要求。', 'error');
    (elements.customTabPromptInline || elements.customTabPrompt || elements.customPrompt)?.focus();
    return;
  }
  if (useDirectAudio) {
    try {
      await requestAudioPermissions('需要允许课记访问 B 站音视频服务器与音频处理权限，才能直接分析课程音视频。');
    } catch (error) {
      return showNotice((error as Error).message || '未获得音频处理权限。', 'error');
    }
  }

  let previousNoteSnapshot: NoteRecord | null = null;
  const lessonKey = Keji.lessonKey(video);
  if (!isResume) {
    let existingSummary: NoteSummary | null = fromOpenedNote && latestNoteId
      ? { id: latestNoteId, title: latestNoteTitle }
      : workspace.currentPartNote;
    if (!existingSummary && lessonKey) {
      const listed = await callBackground('LIST_NOTES').catch(() => null);
      if (listed?.ok) existingSummary = ((listed.notes || []) as NoteSummary[]).find((item) => Keji.lessonKey(item) === lessonKey) || null;
    }
    if (existingSummary?.id) {
      const loaded = await callBackground('GET_NOTE', { id: existingSummary.id }).catch(() => null);
      if (loaded?.ok && loaded.note) previousNoteSnapshot = loaded.note;
    }
    if (previousNoteSnapshot && !skipConfirm) {
      const snapshotViews = extractViewsFromNote(previousNoteSnapshot);
      const targetAlreadyExists = isNoteViewKey(targetTemplate)
        ? Boolean(snapshotViews[targetTemplate]?.trim())
        : targetTemplate === 'flashcards'
          ? Boolean(previousNoteSnapshot.flashcardMarkdown?.trim())
          : Boolean(previousNoteSnapshot.quizState?.generatedMarkdown?.trim());
      if (targetAlreadyExists) {
        const label = getNoteStructure(targetTemplate).label;
        if (!window.confirm(`本节已有「${label}」，重新生成将覆盖该标签页内容（其他标签页不受影响）。确定继续吗？`)) {
          return;
        }
      }
    }
  }

  let audioChunks: Array<{ index: number; start: number; end: number }> = [];
  if (useDirectAudio) {
    workspace.generating = true;
    workspace.activeNoteGenerating = true;
    workspace.generationStageText = '正在获取并准备课程音轨用于直接理解…';
    const prepared = await callBackground('PREPARE_LESSON_AUDIO', { tabId: currentTabId, lesson: video })
      .catch((error: Error) => ({ ok: false, error: error?.message }));
    if (!prepared?.ok) {
      workspace.generating = false;
      workspace.activeNoteGenerating = false;
      workspace.generationStageText = '';
      workspace.canGenerate = computeCanGenerate();
      showNotice(prepared?.error || '准备课程音轨失败。', 'error');
      return;
    }
    audioChunks = Keji.audioChunkRanges(Number((prepared as any).duration) || Number(video.duration) || 0, 600);
  }
  let chunkMaxChars = isResume
    ? Math.max(1000, Math.min(12000, Number(latestGenerationProgress?.chunkMaxChars) || 12000))
    : 12000;
  const resumeFrom = isResume ? Number(latestGenerationProgress?.completedChunks) || 0 : 0;
  let segmentCount = useDirectAudio ? audioChunks.length : Keji.splitTranscript(transcript, chunkMaxChars).length;
  const makeProgress = (completedChunks: number, totalChunks: number): GenerationProgress => (
    chunkMaxChars < 12000
      ? { completedChunks, totalChunks, chunkMaxChars }
      : { completedChunks, totalChunks }
  );
  if (isResume && (!latestGenerationProgress || resumeFrom <= 0 || resumeFrom >= segmentCount || !latestModelMarkdown)) {
    if (useDirectAudio) {
      void callBackground('RELEASE_LESSON_AUDIO').catch(() => {});
      workspace.generating = false;
      workspace.generationStageText = '';
      workspace.canGenerate = computeCanGenerate();
      syncGenerationUiFlags();
    }
    return showNotice(useDirectAudio ? '没有可续跑的音频分段，请重新生成笔记。' : '没有可续跑的文字稿分段，请重新生成笔记。', 'error');
  }

  let previousTargetDocMd = '';
  let previousFlashcardReview = fc.getActiveNoteFlashcardReview();
  let previousFlashcardMd = fc.getActiveNoteFlashcardMarkdown();
  let previousQuizRecord = qz.getActiveNoteQuizRecord();
  let previousConversation = disc.getDiscussionItems();
  let hadAnyExistingContent = Boolean(
    Object.keys(latestViews).length || previousFlashcardMd || previousQuizRecord?.generatedMarkdown
  );
  let previousMetaSnapshot = {
    status: previousNoteSnapshot?.generationStatus || latestGenerationStatus,
    error: previousNoteSnapshot?.generationError || latestGenerationError,
    visualAnalysis: previousNoteSnapshot ? Boolean(previousNoteSnapshot.visualAnalysis) : latestVisualAnalysis,
    visualMode: previousNoteSnapshot?.visualAnalysisMode || latestVisualAnalysisMode,
  };

  generationCancelled = false;
  activeGenerationTaskId = crypto.randomUUID();
  activeCaptureAbortController = new AbortController();
  const initialStageText = segmentCount > 1
    ? `${isResume ? `从第 ${resumeFrom + 1}/${segmentCount} 段` : `${useDirectAudio ? '音频' : '文字稿'}共 ${segmentCount} 段`}开始整理，完成一段后会自动保存。`
    : (useDirectAudio ? '正在将音轨直接提交给多模态模型生成笔记…' : '正在发送到配置的模型生成笔记…');

  const txMeta = isSameLesson(currentVideo, video)
    ? tx.getTranscriptionMetadata()
    : { segments: [], detectedLanguages: [] };
  const initialSegments = txMeta.segments.length
    ? txMeta.segments
    : (previousNoteSnapshot?.transcriptSegments || []);
  const initialDetectedLanguages = txMeta.detectedLanguages.length
    ? txMeta.detectedLanguages
    : (previousNoteSnapshot?.detectedLanguages || []);

  let job: GenerationJob;
  if (!isResume) {
    const preservedCourseTitle = previousNoteSnapshot?.courseTitle || (fromOpenedNote ? latestCourseTitle : '') || video.title || '未命名课程';
    const heading = Keji.formatEpisodeHeading({
      title: previousNoteSnapshot?.title || (fromOpenedNote ? latestNoteTitle : ''),
      courseTitle: preservedCourseTitle,
      part: video.part,
      page: video.page,
      pageCount: video.pageCount,
    });
    const preservedTitle = heading.mainTitle;
    const baseViews = previousNoteSnapshot
      ? extractViewsFromNote(previousNoteSnapshot)
      : (fromOpenedNote ? { ...latestViews } : {});
    if (previousNoteSnapshot) {
      previousConversation = Array.isArray(previousNoteSnapshot.conversation) ? previousNoteSnapshot.conversation : [];
      previousFlashcardReview = Array.isArray(previousNoteSnapshot.flashcardReview) ? previousNoteSnapshot.flashcardReview : [];
      const legacyCardMd = (!previousNoteSnapshot.flashcardMarkdown && previousNoteSnapshot.template === 'flashcards' && !isPlaceholderMarkdown(previousNoteSnapshot.markdown))
        ? previousNoteSnapshot.markdown
        : '';
      previousFlashcardMd = String(previousNoteSnapshot.flashcardMarkdown || legacyCardMd);
      const legacyQuizMd = (!previousNoteSnapshot.quizState?.generatedMarkdown && previousNoteSnapshot.template === 'quiz' && !isPlaceholderMarkdown(previousNoteSnapshot.markdown))
        ? previousNoteSnapshot.markdown
        : '';
      previousQuizRecord = legacyQuizMd
        ? { answers: { ...(previousNoteSnapshot.quizState?.answers || {}) }, generatedMarkdown: legacyQuizMd, updatedAt: previousNoteSnapshot.quizState?.updatedAt }
        : previousNoteSnapshot.quizState;
    }
    hadAnyExistingContent = Boolean(
      Object.keys(baseViews).length || previousFlashcardMd || previousQuizRecord?.generatedMarkdown
    );
    previousTargetDocMd = isNoteViewKey(targetTemplate) ? (baseViews[targetTemplate] || '') : '';
    previousMetaSnapshot = {
      status: previousNoteSnapshot?.generationStatus || (hadAnyExistingContent ? 'completed' : ''),
      error: previousNoteSnapshot?.generationError || '',
      visualAnalysis: previousNoteSnapshot ? Boolean(previousNoteSnapshot.visualAnalysis) : (hadAnyExistingContent && latestVisualAnalysis),
      visualMode: previousNoteSnapshot?.visualAnalysisMode || (hadAnyExistingContent ? latestVisualAnalysisMode : 'transcript-only-or-incomplete'),
    };

    const nextViews = { ...baseViews };
    if (isNoteViewKey(targetTemplate)) {
      delete nextViews[targetTemplate];
    }

    job = {
      taskId: activeGenerationTaskId,
      noteId: previousNoteSnapshot?.id || (fromOpenedNote ? latestNoteId : null),
      lessonKey,
      video: { ...video },
      courseTitle: preservedCourseTitle,
      noteTitle: preservedTitle,
      targetTemplate,
      expectedMarkdown: isNoteViewKey(targetTemplate) ? previousTargetDocMd
        : targetTemplate === 'flashcards' ? previousFlashcardMd : (previousQuizRecord?.generatedMarkdown || ''),
      snapshotPending: Boolean(isNoteViewKey(targetTemplate) ? previousTargetDocMd
        : targetTemplate === 'flashcards' ? previousFlashcardMd : previousQuizRecord?.generatedMarkdown),
      customPrompt: activeCustomPrompt,
      transcript,
      transcriptSegments: initialSegments,
      detectedLanguages: initialDetectedLanguages,
      views: nextViews,
      flashcardMarkdown: previousFlashcardMd,
      flashcardReview: previousFlashcardReview,
      quizState: previousQuizRecord,
      conversation: previousConversation,
      modelMarkdown: '',
      generationModels: previousNoteSnapshot ? noteModels(previousNoteSnapshot) : [],
      generationProgress: makeProgress(0, segmentCount),
      generationStatus: 'running',
      generationStartedAt: new Date().toISOString(),
      generationError: '',
      visualAnalysis: isNoteViewKey(targetTemplate) ? false : previousMetaSnapshot.visualAnalysis,
      visualAnalysisMode: isNoteViewKey(targetTemplate) ? 'transcript-only-or-incomplete' : previousMetaSnapshot.visualMode,
      inVisualStage: false,
      stageText: initialStageText,
      generateLabel: '正在请求模型…',
    };
  } else {
    job = {
      taskId: activeGenerationTaskId,
      noteId: latestNoteId,
      lessonKey,
      video: { ...video },
      courseTitle: latestCourseTitle || video.title || '未命名课程',
      noteTitle: latestNoteTitle || video.title || '课程笔记',
      targetTemplate,
      expectedMarkdown: isNoteViewKey(targetTemplate) ? (latestViews[targetTemplate] || '')
        : targetTemplate === 'flashcards' ? fc.getActiveNoteFlashcardMarkdown() : (qz.getActiveNoteQuizRecord()?.generatedMarkdown || ''),
      snapshotPending: false,
      customPrompt: activeCustomPrompt,
      transcript,
      transcriptSegments: txMeta.segments,
      detectedLanguages: txMeta.detectedLanguages,
      views: cleanDocumentViewsMap(latestViews),
      flashcardMarkdown: fc.getActiveNoteFlashcardMarkdown(),
      flashcardReview: fc.getActiveNoteFlashcardReview(),
      quizState: qz.getActiveNoteQuizRecord(),
      conversation: disc.getDiscussionItems(),
      modelMarkdown: latestModelMarkdown,
      generationModels: [...latestGenerationModels],
      generationProgress: makeProgress(resumeFrom, segmentCount),
      generationStatus: 'running',
      generationStartedAt: new Date().toISOString(),
      generationError: '',
      visualAnalysis: latestVisualAnalysis,
      visualAnalysisMode: latestVisualAnalysisMode,
      inVisualStage: false,
      stageText: initialStageText,
      generateLabel: '正在续跑…',
    };
  }

  activeGenJob = job;
  workspace.generating = true;
  workspace.generationError = '';
  latestGeneratingView = targetTemplate;
  latestFailedView = '';
  latestResumableView = targetTemplate;
  workspace.generatingView = targetTemplate;
  workspace.failedView = '';
  workspace.generationStageText = job.stageText;
  if (elements.resumeGeneration) {
    elements.resumeGeneration.disabled = true;
    elements.resumeGeneration.textContent = '正在继续…';
  }
  if (elements.retryVisualAnalysis) elements.retryVisualAnalysis.disabled = true;
  workspace.generateLabel = job.generateLabel;

  const applyTargetOutput = (bodyMd: string) => {
    const formatted = formatNoteMarkdown(job.noteTitle || video.title || '课程笔记', job.video, bodyMd);
    if (isNoteViewKey(targetTemplate)) {
      job.views[targetTemplate] = formatted;
    } else if (targetTemplate === 'flashcards') {
      job.flashcardMarkdown = bodyMd;
      job.flashcardReview = [];
    } else if (targetTemplate === 'quiz') {
      job.quizState = { generatedMarkdown: bodyMd, answers: {}, updatedAt: new Date().toISOString() };
    }
    if (isViewingJob(job)) {
      if (isNoteViewKey(targetTemplate)) {
        latestViews[targetTemplate] = formatted;
        if (workspace.noteTab === targetTemplate) {
          activeDocumentView = targetTemplate;
          latestMarkdown = formatted;
          renderNoteOutput(formatted, latestVideo);
        }
      } else if (targetTemplate === 'flashcards') {
        fc.setActiveNoteFlashcardData([], bodyMd);
        fc.closeFlashcardSessionQuietly();
      } else if (targetTemplate === 'quiz') {
        qz.setActiveNoteQuizRecord(job.quizState);
      }
    }
    return formatted;
  };

  const restoreFallbackTemplateForJob = (views: Partial<Record<NoteViewKey, string>>): TemplateId | null => {
    if (isNoteViewKey(activeDocumentView) && views[activeDocumentView]) return activeDocumentView;
    const docKey = Object.keys(views)[0] as NoteViewKey | undefined;
    if (docKey) return docKey;
    if (previousFlashcardMd) return 'flashcards';
    if (previousQuizRecord?.generatedMarkdown) return 'quiz';
    return null;
  };

  try {
    if (!isResume) {
      disc.setDiscussionItems(job.conversation);
      fc.setActiveNoteFlashcardData(job.flashcardReview, job.flashcardMarkdown);
      fc.closeFlashcardSessionQuietly();
      qz.setActiveNoteQuizRecord(job.quizState);

      if (isNoteViewKey(targetTemplate)) {
        activeDocumentView = targetTemplate;
        latestMarkdown = '';
      } else {
        activeDocumentView = isNoteViewKey(activeDocumentView) && job.views[activeDocumentView]
          ? activeDocumentView
          : ((Object.keys(job.views)[0] as NoteViewKey) || 'study');
        latestMarkdown = job.views[activeDocumentView] || '';
      }
      latestViews = { ...job.views };
      workspace.noteTab = targetTemplate;
      latestNoteId = job.noteId;
      latestModelMarkdown = '';
      latestFrames = framesFromMarkdown(latestMarkdown);
      latestTemplate = targetTemplate;
      latestCustomPrompt = job.customPrompt;
      latestCourseTitle = job.courseTitle;
      latestNoteTitle = job.noteTitle;
      workspace.noteTitle = job.noteTitle;
      latestReviewMark = previousNoteSnapshot?.reviewMark ?? (fromOpenedNote ? latestReviewMark : '');
      workspace.reviewMark = latestReviewMark;
      latestPersonalNote = String(previousNoteSnapshot?.personalNote ?? (fromOpenedNote ? latestPersonalNote : ''));
      workspace.personalNote = latestPersonalNote;
      workspace.personalNoteOpen = Boolean(latestPersonalNote.trim());
      latestVideo = { ...job.video };
      syncNoteEpisodeLabel();
      workspace.noteVideoUrl = safeBilibiliVideoUrl(job.video.url);
      latestTranscript = job.transcript;
      latestGenerationProgress = job.generationProgress;
      latestGenerationStatus = 'running';
      latestGenerationStartedAt = job.generationStartedAt;
      latestGenerationError = '';
      latestGenerationModels = [...job.generationModels];
      latestVisualAnalysis = job.visualAnalysis;
      latestVisualAnalysisMode = job.visualAnalysisMode;
      if (!fromOpenedNote || workspace.activeView !== 'note') workspace.noteReturnView = 'create';
    } else {
      latestGenerationProgress = job.generationProgress;
      latestGenerationStatus = 'running';
      latestGenerationStartedAt = job.generationStartedAt;
      latestGenerationError = '';
      if (workspace.activeView !== 'note') workspace.noteReturnView = 'create';
    }
    syncGenerationProgressState();
    syncGenerationUiFlags();

    if (!previousNoteSnapshot && !job.noteId) {
      await persistGenerationJob(job, false);
      refreshLibraryViewsIfVisible();
    }
    if (isViewingJob(job)) {
      renderNoteOutput(latestMarkdown, latestVideo);
      renderExportActions();
      workspace.resultVisible = true;
      setWorkspaceView('note');
    }

    const MAX_ADAPTIVE_SPLITS = 2;
    let adaptiveSplitCount = 0;
    let accumulatedMarkdown = isResume ? job.modelMarkdown : '';
    let structuredNoteState: StructuredNoteData | null = null;
    const settingsResult = await callBackground('GET_SETTINGS');
    const rawConcurrency = Math.max(1, Math.min(4, Math.floor(Number(settingsResult?.settings?.generationConcurrency) || 2)));
    const generationConcurrency = useDirectAudio ? Math.min(2, rawConcurrency) : rawConcurrency;

    while (true) {
      const generationBatches = Keji.generationBatches(segmentCount, generationConcurrency, resumeFrom);
      let retryWithSmallerChunks = false;

      for (const batchIndexes of generationBatches) {
        if (generationCancelled) throw Object.assign(new Error('已停止生成。'), { cancelled: true });
        const nextChunk = batchIndexes[0]!;
        const batchSize = batchIndexes.length;
        job.stageText = batchSize > 1
          ? `正在并行整理第 ${nextChunk + 1}–${nextChunk + batchSize}/${segmentCount} 段…`
          : (useDirectAudio ? `正在提交第 ${nextChunk + 1}/${segmentCount} 段音轨由模型直接理解…` : `正在整理第 ${nextChunk + 1}/${segmentCount} 段…`);
        if (isViewingJob(job)) workspace.generationStageText = job.stageText;
        const batchResult = await Keji.runGenerationBatch<{ ok?: boolean; error?: string; markdown?: string; model?: string; structured?: StructuredNoteData }>(
          batchIndexes,
          accumulatedMarkdown,
          (index, partialMarkdown) => {
            const partialOutline = structuredNoteState
              ? extractStructuredOutline(structuredNoteState)
              : extractMarkdownOutline(partialMarkdown);
            return callBackground('GENERATE_NOTE', {
              payload: {
                video: job.video,
                transcript: job.transcript,
                ...(useDirectAudio ? { audioChunk: { ...audioChunks[index]!, total: segmentCount } } : { chunkMaxChars }),
                template: job.targetTemplate,
                customPrompt: job.customPrompt,
                singleChunk: true,
                returnChunkOnly: true,
                resumeFrom: index,
                partialMarkdown,
                partialOutline,
                generationTaskId: job.taskId
              }
            });
          },
          (prevMarkdown, chunkMarkdown, value) => {
            if (value?.structured && (structuredNoteState || !prevMarkdown.trim())) {
              structuredNoteState = structuredNoteState
                ? mergeStructuredNoteData(structuredNoteState, value.structured, job.targetTemplate)
                : value.structured;
              return compileStructuredNoteToMarkdown(structuredNoteState, job.targetTemplate);
            }
            structuredNoteState = null;
            return mergeNoteMarkdownChunks(prevMarkdown, chunkMarkdown);
          },
          async ({ markdown, committed, value }) => {
            accumulatedMarkdown = markdown;
            if (value?.model && !job.generationModels.includes(value.model)) job.generationModels.push(value.model);
            const completedThrough = nextChunk + committed;
            const nextProgress = makeProgress(completedThrough, segmentCount);
            job.modelMarkdown = accumulatedMarkdown;
            job.generationProgress = nextProgress;
            job.stageText = `已完成并保存第 ${completedThrough}/${segmentCount} 段。`;
            applyTargetOutput(accumulatedMarkdown);
            if (isViewingJob(job)) {
              latestGenerationModels = [...job.generationModels];
              latestModelMarkdown = job.modelMarkdown;
              latestGenerationProgress = nextProgress;
              syncGenerationProgressState();
              renderExportActions();
              workspace.resultVisible = true;
              workspace.generationStageText = job.stageText;
            }
            await persistGenerationJob(job, false);
            refreshLibraryViewsIfVisible();
          }
        );
        accumulatedMarkdown = batchResult.markdown;
        const failureOffset = batchResult.failureOffset;
        const completedThrough = nextChunk + batchResult.committed;
        const nextProgress = makeProgress(completedThrough, segmentCount);
        job.generationProgress = nextProgress;
        if (isViewingJob(job)) {
          latestGenerationProgress = nextProgress;
          syncGenerationProgressState();
        }
        const failedReason = (failureOffset >= 0 ? batchResult.results[failureOffset] : null) as { reason?: Error & { cancelled?: boolean } } | null;
        if (generationCancelled || failedReason?.reason?.cancelled) {
          job.modelMarkdown = accumulatedMarkdown;
          if (accumulatedMarkdown) applyTargetOutput(accumulatedMarkdown);
          if (isViewingJob(job)) {
            latestModelMarkdown = job.modelMarkdown;
          }
          throw Object.assign(new Error('已停止生成。'), { cancelled: true });
        }
        if (failureOffset >= 0 && !accumulatedMarkdown) {
          const rawErr = failedReason?.reason instanceof Error
            ? failedReason.reason
            : new Error(String(failedReason?.reason || '模型请求失败。'));
          if (!useDirectAudio && !isResume && !generationCancelled) {
            const overflow = Keji.parseContextOverflowError(rawErr.message);
            if (overflow.isOverflow) {
              const nextChunkChars = adaptiveSplitCount < MAX_ADAPTIVE_SPLITS
                ? Keji.computeAdaptiveChunkChars(chunkMaxChars, overflow)
                : null;
              if (nextChunkChars) {
                adaptiveSplitCount += 1;
                chunkMaxChars = nextChunkChars;
                structuredNoteState = null;
                segmentCount = Keji.splitTranscript(transcript, chunkMaxChars).length;
                const resetProgress = makeProgress(0, segmentCount);
                job.generationProgress = resetProgress;
                job.stageText = `模型上下文窗口有限，已自动缩小分段（共 ${segmentCount} 段）并重试…`;
                if (isViewingJob(job)) {
                  latestGenerationProgress = resetProgress;
                  syncGenerationProgressState();
                  workspace.generationStageText = job.stageText;
                }
                retryWithSmallerChunks = true;
                break;
              }
              throw new Error(`${rawErr.message}（当前模型上下文窗口过小；请在模型服务调大上下文长度如 8192+，或切换上下文更大的模型）`);
            }
          }
          throw rawErr;
        }
        job.modelMarkdown = accumulatedMarkdown;
        applyTargetOutput(accumulatedMarkdown);
        if (isViewingJob(job)) {
          latestModelMarkdown = job.modelMarkdown;
          renderExportActions();
          workspace.resultVisible = true;
        }
        await persistGenerationJob(job, false);
        if (failureOffset >= 0) {
          const detail = failedReason?.reason?.message || '模型请求失败。';
          job.generationStatus = 'failed';
          job.generationError = detail;
          job.stageText = '';
          await persistGenerationJob(job, false);
          if (isViewingJob(job)) {
            latestGenerationStatus = 'failed';
            latestGenerationError = detail;
            latestGeneratingView = '';
            latestFailedView = targetTemplate;
            latestResumableView = targetTemplate;
            workspace.generationStageText = '';
            workspace.generationError = `第 ${completedThrough + 1}/${segmentCount} 段失败：${detail}`;
            showNotice(workspace.generationError, 'error');
          } else {
            showNotice(`「${formatJobLabel(job.video, job.noteTitle)}」第 ${completedThrough + 1}/${segmentCount} 段失败：${detail}`, 'error');
          }
          void refreshCourseNotesMap();
          refreshLibraryViewsIfVisible();
          return;
        }
      }

      if (!retryWithSmallerChunks) break;
    }

    if (generationCancelled) throw Object.assign(new Error('已停止生成。'), { cancelled: true });

    if (segmentCount >= 2 && structuredNoteState && (job.targetTemplate === 'study' || job.targetTemplate === 'brief')) {
      job.stageText = '分段提取完成，正在统合全课核心脉络与结论…';
      if (isViewingJob(job)) workspace.generationStageText = job.stageText;
      try {
        const synthesized = await callBackground('SYNTHESIZE_NOTE_OVERVIEW', {
          structured: structuredNoteState,
          video: job.video,
          generationTaskId: job.taskId
        });
        if (generationCancelled || synthesized?.cancelled) {
          throw Object.assign(new Error('已停止生成。'), { cancelled: true });
        }
        if (synthesized?.ok && synthesized.markdown) {
          structuredNoteState = synthesized.structured || structuredNoteState;
          accumulatedMarkdown = synthesized.markdown;
          job.modelMarkdown = accumulatedMarkdown;
          if (synthesized.model && !job.generationModels.includes(synthesized.model)) {
            job.generationModels.push(synthesized.model);
          }
          applyTargetOutput(accumulatedMarkdown);
          if (isViewingJob(job)) {
            latestGenerationModels = [...job.generationModels];
            latestModelMarkdown = job.modelMarkdown;
            renderExportActions();
          }
          await persistGenerationJob(job, false).catch(() => {});
        }
      } catch (error) {
        const err = error as Error & { cancelled?: boolean };
        if (generationCancelled || err?.cancelled || err?.name === 'AbortError') throw error;
      }
    }

    const completedProgress = makeProgress(segmentCount, segmentCount);
    job.generationStatus = 'completed';
    job.generationProgress = completedProgress;
    job.generationError = '';
    job.inVisualStage = true;
    if (isViewingJob(job)) {
      latestGenerationStatus = 'completed';
      latestGenerationProgress = completedProgress;
      syncGenerationProgressState();
      latestResumableView = '';
      latestGenerationError = '';
    }
    let resolvedTabId = currentTabId;
    let sameOpenVideo = Boolean(currentVideo && resolvedTabId
      && Keji.bvidFromUrl(currentVideo.url) === Keji.bvidFromUrl(video.url)
      && Number(currentVideo.page) === Number(video.page));
    const cachedVideo = await getCachedVideo(video, { expectedCid: video.cid }).catch(() => null);
    if (!sameOpenVideo && !cachedVideo?.file) {
      const openTab = await findOpenBilibiliTab(video);
      if (openTab?.id && openTab.url && matchesVideoTarget({ url: openTab.url, page: pageFromBilibiliUrl(openTab.url) }, video)) {
        resolvedTabId = openTab.id;
        sameOpenVideo = true;
      }
    }
    const canAnalyzeVideo = isNoteViewKey(targetTemplate) && (sameOpenVideo || Boolean(cachedVideo?.file));
    if (canAnalyzeVideo) {
      await persistGenerationJob(job, false).catch(() => {});
    }
    const visualResult = canAnalyzeVideo
      ? await runVisualAnalysisPipeline({
        video: job.video,
        transcript: job.transcript,
        initialBodyMarkdown: job.modelMarkdown,
        settings: settingsResult?.settings,
        cachedVideo,
        sameOpenVideo,
        tabId: resolvedTabId,
        generationTaskId: job.taskId,
        signal: activeCaptureAbortController.signal,
        isCancelled: () => generationCancelled,
        fallbackFrames: [],
        revertToInitialOnFullVideoCaptureError: true,
        throwOnFrameEnrichError: false
      })
      : {
        bodyMarkdown: job.modelMarkdown,
        frames: [] as KeyFrameItem[],
        captureFailed: false,
        visualAnalysis: isNoteViewKey(targetTemplate) ? false : previousMetaSnapshot.visualAnalysis,
        visualAnalysisMode: isNoteViewKey(targetTemplate) ? 'transcript-only-or-incomplete' : previousMetaSnapshot.visualMode,
        visualError: ''
      };

    job.visualAnalysis = visualResult.visualAnalysis;
    job.visualAnalysisMode = visualResult.visualAnalysisMode;
    job.generationError = visualResult.visualError || '';
    job.generationStatus = 'completed';
    job.stageText = '';
    const formattedFinal = applyTargetOutput(visualResult.bodyMarkdown);
    if (targetTemplate === 'flashcards') {
      if (isViewingJob(job)) {
        fc.pruneActiveNoteFlashcardReview(visualResult.bodyMarkdown);
        job.flashcardReview = fc.getActiveNoteFlashcardReview();
      }
    } else if (targetTemplate === 'quiz') {
      if (isViewingJob(job)) {
        qz.pruneActiveNoteQuizOnRegenerate(visualResult.bodyMarkdown, 'quiz');
        job.quizState = qz.getActiveNoteQuizRecord();
      }
    }
    await persistGenerationJob(job, Boolean(job.visualAnalysis || !visualResult.visualError));
    if (isViewingJob(job)) {
      latestVisualAnalysis = job.visualAnalysis;
      latestVisualAnalysisMode = job.visualAnalysisMode;
      latestFrames = visualResult.frames;
      latestNoteTitle = job.noteTitle;
      workspace.noteTitle = job.noteTitle;
      latestVideo = { ...job.video };
      latestGenerationError = job.generationError;
      if (isNoteViewKey(targetTemplate) && workspace.noteTab === targetTemplate) {
        latestMarkdown = formattedFinal;
      }
      latestGeneratingView = '';
      latestFailedView = '';
      renderExportActions();
      workspace.resultVisible = true;
      workspace.generationStageText = '';
      if (visualResult.visualError) {
        workspace.generationError = `文字稿笔记已保存，画面分析未完成：${visualResult.visualError}`;
        showNotice('笔记已保存（画面分析未完成）。', 'error');
      } else {
        workspace.generationError = '';
        const targetLabel = getNoteStructure(targetTemplate).label;
        showNotice(latestFrames.length
          ? `「${targetLabel}」已生成并保存，已嵌入 ${latestFrames.length} 张关键帧。`
          : `「${targetLabel}」已生成并保存。`, 'success');
      }
    } else {
      const jobLabel = formatJobLabel(job.video, job.noteTitle);
      const targetLabel = getNoteStructure(targetTemplate).label;
      showNotice(
        visualResult.visualError
          ? `「${jobLabel}」的「${targetLabel}」已保存（画面分析未完成）。`
          : visualResult.frames.length
            ? `「${jobLabel}」的「${targetLabel}」已生成并保存，已嵌入 ${visualResult.frames.length} 张关键帧。`
            : `「${jobLabel}」的「${targetLabel}」已生成并保存。`,
        visualResult.visualError ? 'error' : 'success'
      );
    }
    void refreshCourseNotesMap();
    refreshLibraryViewsIfVisible();
    if (isSameLesson(currentVideo, job.video)) {
      void refreshCurrentLessonCacheStatus(job.video, job.noteId);
    }
    void refreshCacheOverview();
  } catch (error) {
    const err = error as Error & { cancelled?: boolean };
    const wasCancelled = generationCancelled || err?.cancelled || err?.name === 'AbortError';
    const targetLabel = getNoteStructure(targetTemplate).label;
    const jobLabel = formatJobLabel(job.video, job.noteTitle);
    const viewing = isViewingJob(job);
    const hasPreviousTarget = Boolean(
      (isNoteViewKey(targetTemplate) && previousTargetDocMd)
      || (targetTemplate === 'flashcards' && previousFlashcardMd)
      || (targetTemplate === 'quiz' && previousQuizRecord?.generatedMarkdown)
    );

    if (!job.modelMarkdown.trim() && hasPreviousTarget) {
      if (isNoteViewKey(targetTemplate)) {
        job.views[targetTemplate] = previousTargetDocMd;
      } else if (targetTemplate === 'flashcards') {
        job.flashcardMarkdown = previousFlashcardMd;
        job.flashcardReview = previousFlashcardReview;
      } else if (targetTemplate === 'quiz') {
        job.quizState = previousQuizRecord;
      }
      job.generationProgress = null;
      job.generationStatus = previousMetaSnapshot.status || 'completed';
      job.generationError = previousMetaSnapshot.error || '';
      job.visualAnalysis = previousMetaSnapshot.visualAnalysis;
      job.visualAnalysisMode = previousMetaSnapshot.visualMode;
      job.stageText = '';
      await persistGenerationJob(job, previousMetaSnapshot.status === 'completed').catch(() => {});
      void refreshCourseNotesMap();
      if (viewing) {
        if (isNoteViewKey(targetTemplate)) {
          latestViews[targetTemplate] = previousTargetDocMd;
          latestMarkdown = workspace.noteTab === targetTemplate ? previousTargetDocMd : (latestViews[activeDocumentView] || '');
        } else if (targetTemplate === 'flashcards') {
          fc.setActiveNoteFlashcardData(previousFlashcardReview, previousFlashcardMd);
          fc.closeFlashcardSessionQuietly();
        } else if (targetTemplate === 'quiz') {
          qz.setActiveNoteQuizRecord(previousQuizRecord);
        }
        latestGenerationProgress = null;
        latestResumableView = '';
        syncGenerationProgressState();
        latestGenerationStatus = job.generationStatus;
        latestGenerationError = job.generationError;
        latestVisualAnalysis = job.visualAnalysis;
        latestVisualAnalysisMode = job.visualAnalysisMode;
        latestGeneratingView = '';
        latestFailedView = '';
        latestFrames = framesFromMarkdown(latestMarkdown);
        renderNoteOutput();
        renderExportActions();
        workspace.generationStageText = '';
        workspace.generationError = '';
      }
      showNotice(
        wasCancelled
          ? (viewing ? `已取消重新生成，原「${targetLabel}」已保留。` : `「${jobLabel}」已取消重新生成，原「${targetLabel}」已保留。`)
          : (viewing
            ? `重新生成失败（${err.message || '模型请求失败'}），原「${targetLabel}」未受影响。`
            : `「${jobLabel}」重新生成失败（${err.message || '模型请求失败'}），原「${targetLabel}」未受影响。`),
        wasCancelled ? 'info' : 'error'
      );
    } else if (wasCancelled) {
      if (!job.modelMarkdown.trim()) {
        if (hadAnyExistingContent) {
          job.generationProgress = null;
          job.generationStatus = previousMetaSnapshot.status || 'completed';
          job.generationError = '';
          job.visualAnalysis = previousMetaSnapshot.visualAnalysis;
          job.visualAnalysisMode = previousMetaSnapshot.visualMode;
          job.stageText = '';
          await persistGenerationJob(job, previousMetaSnapshot.status === 'completed').catch(() => {});
          void refreshCourseNotesMap();
          if (viewing) {
            latestGenerationProgress = null;
            latestResumableView = '';
            syncGenerationProgressState();
            latestGenerationStatus = job.generationStatus;
            latestGenerationError = '';
            latestVisualAnalysis = job.visualAnalysis;
            latestVisualAnalysisMode = job.visualAnalysisMode;
            latestGeneratingView = '';
            latestFailedView = '';
            const fallback = restoreFallbackTemplateForJob(latestViews);
            if (fallback) latestTemplate = fallback;
            renderNoteOutput(latestMarkdown, latestVideo);
            renderExportActions();
            workspace.generationStageText = '';
            workspace.generationError = '';
          }
          showNotice(viewing ? `已停止生成「${targetLabel}」。` : `「${jobLabel}」已停止生成「${targetLabel}」。`, 'info');
        } else {
          if (job.noteId) {
            await callBackground('DELETE_NOTE', { id: job.noteId }).catch(() => {});
            job.noteId = null;
          }
          if (viewing) {
            latestNoteId = null;
            clearActiveNoteState();
            setWorkspaceView('create');
            showNotice('已停止生成。', 'info');
          } else {
            showNotice(`「${jobLabel}」已停止生成。`, 'info');
          }
        }
      } else {
        job.generationStatus = 'failed';
        job.generationError = '已手动停止生成，已完成分段已保留。';
        job.stageText = '';
        await persistGenerationJob(job, false).catch(() => {});
        void refreshCourseNotesMap();
        if (viewing) {
          latestGeneratingView = '';
          latestGenerationStatus = 'failed';
          latestGenerationError = job.generationError;
          latestFailedView = targetTemplate;
          latestResumableView = targetTemplate;
          workspace.generationStageText = '';
          workspace.generationError = job.generationError;
        }
        showNotice(viewing ? '已停止生成，已完成分段已保留。' : `「${jobLabel}」已停止生成，已完成分段已保留。`, 'info');
      }
    } else if (!job.modelMarkdown.trim() && hadAnyExistingContent) {
      job.generationProgress = null;
      job.generationStatus = previousMetaSnapshot.status || 'completed';
      job.generationError = previousMetaSnapshot.error || '';
      job.visualAnalysis = previousMetaSnapshot.visualAnalysis;
      job.visualAnalysisMode = previousMetaSnapshot.visualMode;
      job.stageText = '';
      await persistGenerationJob(job, previousMetaSnapshot.status === 'completed').catch(() => {});
      void refreshCourseNotesMap();
      const errMsg = err.message || '模型请求失败。';
      if (viewing) {
        latestGenerationProgress = null;
        latestResumableView = '';
        syncGenerationProgressState();
        latestGenerationStatus = job.generationStatus;
        latestGenerationError = job.generationError;
        latestVisualAnalysis = job.visualAnalysis;
        latestVisualAnalysisMode = job.visualAnalysisMode;
        latestGeneratingView = '';
        latestFailedView = targetTemplate;
        const fallback = restoreFallbackTemplateForJob(latestViews);
        if (fallback) latestTemplate = fallback;
        workspace.generationStageText = '';
        workspace.generationError = errMsg;
        showNotice(errMsg, 'error');
        renderNoteOutput();
        workspace.resultVisible = true;
        renderExportActions();
      } else {
        showNotice(`「${jobLabel}」${errMsg}`, 'error');
      }
    } else {
      if (job.generationStatus === 'running') {
        job.generationStatus = 'failed';
        job.generationError = err.message || '模型请求失败。';
        if (!job.modelMarkdown.trim()) {
          job.generationProgress = null;
          if (isNoteViewKey(targetTemplate)) delete job.views[targetTemplate];
        }
        await persistGenerationJob(job, false).catch(() => {});
        void refreshCourseNotesMap();
      }
      const errMsg = err.message || '模型请求失败。';
      if (viewing) {
        latestGeneratingView = '';
        latestGenerationStatus = job.generationStatus;
        latestGenerationError = job.generationError;
        latestGenerationProgress = job.generationProgress;
        latestResumableView = job.generationProgress ? targetTemplate : '';
        syncGenerationProgressState();
        if (!job.modelMarkdown.trim() && isNoteViewKey(targetTemplate)) {
          delete latestViews[targetTemplate];
          latestMarkdown = '';
        }
        latestFailedView = targetTemplate;
        workspace.generationStageText = '';
        workspace.generationError = errMsg;
        showNotice(errMsg, 'error');
        renderNoteOutput();
        workspace.resultVisible = true;
        renderExportActions();
      } else {
        showNotice(`「${jobLabel}」${errMsg}`, 'error');
      }
    }
  } finally {
    if (useDirectAudio) void callBackground('RELEASE_LESSON_AUDIO').catch(() => {});
    activeGenJob = null;
    latestGeneratingView = '';
    workspace.generating = false;
    workspace.generatingView = '';
    activeGenerationTaskId = '';
    activeCaptureAbortController = null;
    syncGenerationUiFlags();
    workspace.canGenerate = computeCanGenerate();
    if (elements.resumeGeneration) {
      elements.resumeGeneration.disabled = false;
      elements.resumeGeneration.textContent = '继续生成剩余分段';
    }
    if (elements.retryVisualAnalysis) elements.retryVisualAnalysis.disabled = false;
    syncCurrentPartNote();
    renderExportActions();
    refreshLibraryViewsIfVisible();
  }
}

export async function copyMarkdown(): Promise<void> {
  const copyState = getCopyableContentForCurrentTab();
  if (!copyState.text.trim()) return;
  try {
    await navigator.clipboard.writeText(copyState.text);
    showNotice(`${copyState.label.replace(/^复制/, '') || '内容'}已复制。`, 'success');
  } catch {
    showNotice('复制失败，请选中预览内容后复制。', 'error');
  }
}

async function renderRecentNotes(): Promise<void> {
  const result = await callBackground('LIST_NOTES');
  if (!result?.ok) throw new Error(result?.error || '读取本机笔记失败。');
  savedNotes = await reconcileOrphanedRunningNotes((result?.notes || []) as NoteSummary[]);
  renderDashboardStats(savedNotes);
  const models = [...new Set(savedNotes.flatMap(noteModels))].sort((a, b) => a.localeCompare(b));
  workspace.availableNoteModels = models;
  if (!models.includes(workspace.notesModelFilter)) workspace.notesModelFilter = '';
  void fc.refreshDueFlashcardCount();
  void refreshCacheOverview();
  await filterSavedNotes();
}

async function filterSavedNotes(): Promise<void> {
  const query = workspace.notesSearch.trim().toLocaleLowerCase();
  const requestId = ++notesSearchRequest;
  const response = query ? await callBackground('LIST_NOTES', { query }) : { ok: true, notes: savedNotes };
  if (requestId !== notesSearchRequest) return;
  if (!response?.ok) throw new Error(response?.error || '搜索笔记失败。');
  const savedById = new Map(savedNotes.map((item) => [item.id, item]));
  const modelFilter = workspace.notesModelFilter;
  const statusFilter = workspace.notesStatusFilter;
  const reviewFilter = workspace.notesReviewFilter;
  filteredSavedNotes = ((response.notes || []) as NoteSummary[])
    .map((item) => savedById.get(item.id) || item)
    .filter((note) => {
      if (modelFilter && !noteModels(note).includes(modelFilter)) return false;
      if (reviewFilter && (note.reviewMark || '') !== reviewFilter) return false;
      const status = savedNoteStatus(note);
      if (statusFilter === 'completed' && !['audiovisual', 'transcript'].includes(status)) return false;
      if (statusFilter === 'processing' && status !== 'processing') return false;
      if (statusFilter === 'incomplete' && !['failed', 'interrupted', 'partial', 'unknown'].includes(status)) return false;
      return true;
    });
  visibleNotesLimit = 100;
  renderNoteRows();
}

function renderNoteRows(): void {
  const filtered = filteredSavedNotes;
  const hasActiveFilter = Boolean(workspace.notesSearch.trim() || workspace.notesStatusFilter || workspace.notesModelFilter || workspace.notesReviewFilter);
  workspace.noteCountLabel = savedNotes.length
    ? (hasActiveFilter ? `${filtered.length} / ${savedNotes.length} 篇` : `共 ${savedNotes.length} 篇`)
    : '0 篇';
  workspace.moreNotes = filtered.length > visibleNotesLimit;
  const rows = filtered.slice(0, visibleNotesLimit).map((note) => {
    const courseBvid = Keji.bvidFromUrl(note.url);
    const coverUrl = safeCoverUrl(note.cover);
    const date = note.updatedAt || note.createdAt;
    const models = noteModels(note);
    const originalVideoUrl = safeBilibiliVideoUrl(note.url);
    const rawStatus = savedNoteStatus(note);
    const statusText = statusLabels[rawStatus] || '已保存';
    const statusTone = savedNoteStatusTone(rawStatus);
    const canExport = note.hasContent !== undefined
      ? Boolean(note.hasContent)
      : ['audiovisual', 'transcript'].includes(rawStatus);
    const dateLabel = formatShortDate(date);
    const heading = Keji.formatEpisodeHeading(note);
    const pageNum = Number(note.page) || 0;
    const partLabel = heading.isMultiPart
      ? heading.mainTitle
      : (note.part ? Keji.cleanPartTitle(note.part, pageNum) : note.title || '未命名视频');
    const modelsLabel = models.length ? models.join('、') : '';
    const badges: string[] = [];
    if (note.duration) badges.push(Keji.formatTime(note.duration));
    if (note.viewKeys?.length) {
      badges.push(note.viewKeys.map((key) => getNoteStructure(key).tabLabel || getNoteStructure(key).label).join('/'));
    }
    if (note.quizSummary?.total) {
      badges.push(note.quizSummary.answered
        ? `自测 ${note.quizSummary.correct}/${note.quizSummary.total}`
        : `自测 ${note.quizSummary.total}题`);
    }
    if (note.flashcardSummary?.total) {
      badges.push(note.flashcardSummary.due
        ? `闪卡 ${note.flashcardSummary.total}·待复习${note.flashcardSummary.due}`
        : `闪卡 ${note.flashcardSummary.total}`);
    }
    return {
      note,
      coverUrl,
      title: heading.isMultiPart ? `${heading.courseTitle} · ${heading.mainTitle}` : heading.mainTitle,
      partLabel,
      compactMeta: [...badges, dateLabel].filter(Boolean).join(' · '),
      meta: [note.pageCount && note.pageCount > 1 ? `第 ${pageNum || 1}/${note.pageCount} 讲` : '', ...badges, dateLabel].filter(Boolean).join(' · '),
      reviewMark: (['star', 'question', 'mastered'].includes(note.reviewMark || '') ? note.reviewMark : '') as ReviewMark,
      hasPersonalNote: Boolean(String(note.personalNote || '').trim()),
      summaryPreview: note.summaryPreview || '',
      badges,
      modelTooltip: modelsLabel ? `生成模型：${modelsLabel}` : '',
      statusText,
      statusTone,
      canExport,
      error: note.generationError || '',
      originalVideoUrl,
      courseBvid,
      updatedAtMs: Date.parse(date || '') || 0,
      updatedLabel: dateLabel,
    };
  });
  workspace.noteRows = rows;

  const groupedByBvid = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.courseBvid) continue;
    const bucket = groupedByBvid.get(row.courseBvid);
    if (bucket) bucket.push(row);
    else groupedByBvid.set(row.courseBvid, [row]);
  }
  const emittedCourses = new Set<string>();
  const groups: typeof workspace.noteGroups = [];
  for (const row of rows) {
    const bucket = row.courseBvid ? groupedByBvid.get(row.courseBvid) : null;
    const shouldGroup = Boolean(bucket && (bucket.length >= 2 || bucket.some((item) => (Number(item.note.pageCount) || 1) > 1)));
    if (shouldGroup && bucket) {
      if (emittedCourses.has(row.courseBvid)) continue;
      emittedCourses.add(row.courseBvid);
      const sortedRows = [...bucket].sort((a, b) => (Number(a.note.page) || Number.MAX_SAFE_INTEGER) - (Number(b.note.page) || Number.MAX_SAFE_INTEGER) || b.updatedAtMs - a.updatedAtMs);
      const latestRow = bucket.reduce((best, item) => item.updatedAtMs > best.updatedAtMs ? item : best, bucket[0]!);
      const maxPageCount = bucket.reduce((max, item) => Math.max(max, Number(item.note.pageCount) || 1), 1);
      groups.push({
        type: 'course',
        key: `course:${row.courseBvid}`,
        bvid: row.courseBvid,
        title: latestRow.note.courseTitle || Keji.formatEpisodeHeading(latestRow.note).courseTitle,
        coverUrl: latestRow.coverUrl,
        progressLabel: maxPageCount > 1 ? `已记 ${bucket.length} / ${maxPageCount} 讲` : `共 ${bucket.length} 节笔记`,
        updatedLabel: latestRow.updatedLabel ? `最近更新 ${latestRow.updatedLabel}` : '',
        rows: sortedRows,
      });
    } else {
      groups.push({ type: 'single', key: `note:${row.note.id}`, row });
    }
  }
  workspace.noteGroups = groups;
}

export function loadMoreNotes(): void {
  visibleNotesLimit += 100;
  renderNoteRows();
}

export async function exportSavedNoteBundle(summary: NoteSummary): Promise<void> {
  try {
    const loaded = await callBackground('GET_NOTE', { id: summary.id });
    if (!loaded?.ok) throw new Error(loaded?.error || '读取笔记失败。');
    if (!hasDocumentContentInRecord(loaded.note)) {
      showNotice('该笔记尚未生成有效内容，请先打开并生成后再导出。', 'info');
      return;
    }
    downloadNoteBundle(loaded.note);
  } catch (error) {
    showNotice((error as Error).message || '资源包导出失败。', 'error');
  }
}

export async function transferRemoteNotesBackup(action: 'upload' | 'download' | 'sync'): Promise<void> {
  const button = action === 'upload' ? elements.remoteNotesUpload
    : action === 'sync' ? elements.remoteNotesSync : elements.remoteNotesDownload;
  await withButtonBusy(
    button,
    null,
    async () => {
      showNotice(action === 'upload' ? '正在上传本机笔记库到远程备份…'
        : action === 'sync' ? '正在合并远程更改，再同步本机笔记…'
          : '正在下载远程备份并与本机笔记合并…', 'info');
      const result = await callBackground('REMOTE_NOTES_BACKUP', { action });
      if (!result?.ok) throw new Error(result?.error || '远程备份操作失败。');
      if (action === 'upload') {
        showNotice(`远程备份已更新，包含 ${result.result.noteCount} 篇笔记。`, 'success');
      } else if (action === 'sync') {
        await renderRecentNotes();
        void refreshCourseNotesMap();
        showNotice(`同步完成：新增 ${result.result.merged?.added || 0} 篇、更新 ${result.result.merged?.updated || 0} 篇；远程现含 ${result.result.noteCount} 篇。`, 'success');
        await refreshRemoteNotesSyncStatus();
      } else {
        await renderRecentNotes();
        void refreshCourseNotesMap();
        showNotice(`远程备份合并完成：新增 ${result.result.added} 篇，更新 ${result.result.updated || 0} 篇，现有 ${result.result.retained} 篇。`, 'success');
      }
    },
    '远程备份操作失败。'
  );
}

export async function exportLocalNotesBackup(): Promise<void> {
  try {
    const result = await callBackground('EXPORT_LOCAL_NOTES_BACKUP');
    if (!result?.ok) throw new Error(result?.error || '导出备份失败。');
    downloadBlob(`keji-notes-${new Date().toISOString().slice(0, 10)}.json`,
      new Blob([result.body], { type: 'application/json;charset=utf-8' }));
  } catch (error) { showNotice((error as Error).message || '导出备份失败。', 'error'); }
}

export async function importLocalNotesBackup(file: File): Promise<void> {
  try {
    if (file.size > 200 * 1024 * 1024) throw new Error('备份超过 200 MiB。');
    const bytes = await file.arrayBuffer();
    const result = await callBackground('IMPORT_LOCAL_NOTES_BACKUP', { bytes });
    if (!result?.ok) throw new Error(result?.error || '导入备份失败。');
    await renderRecentNotes();
    showNotice(`导入完成：新增 ${result.result.added} 篇，更新 ${result.result.updated} 篇。`, 'success');
  } catch (error) { showNotice((error as Error).message || '导入备份失败。', 'error'); }
}

export async function restoreRecentRecoveryNote(): Promise<void> {
  try {
    const listed = await callBackground('LIST_RECOVERY_NOTES');
    if (!listed?.ok) throw new Error(listed?.error || '读取恢复副本失败。');
    const choices = (listed.notes || []).slice(0, 10);
    if (!choices.length) return showNotice('目前没有可恢复的笔记副本。', 'info');
    const menu = choices.map((item: any, index: number) =>
      `${index + 1}. ${item.title} · ${formatShortDate(item.createdAt)} · ${item.reason === 'edit' ? '正文' : '同步前'}`).join('\n');
    const selected = window.prompt(`选择要恢复的副本编号（1-${choices.length}）：\n${menu}`);
    if (!selected) return;
    const index = Number(selected) - 1;
    if (!Number.isInteger(index) || !choices[index]) throw new Error('无效的恢复副本编号。');
    const result = await callBackground('RESTORE_RECOVERY_NOTE', { id: choices[index].id });
    if (!result?.ok) throw new Error(result?.error || '恢复笔记失败。');
    await renderRecentNotes();
    showNotice('已恢复笔记副本。', 'success');
  } catch (error) { showNotice((error as Error).message || '恢复笔记失败。', 'error'); }
}

function renderRemoteNotesSyncStatus(enabled: boolean, state: { status?: string; lastSyncedAt?: number; noteCount?: number; error?: string } = {}): void {
  if (!workspace.remoteBackupConfigured) {
    workspace.remoteBackupStatusText = '';
    return;
  }
  if (!enabled) {
    workspace.remoteBackupStatusText = '自动同步未开启；可在上方「管理与同步」菜单手动同步。';
    return;
  }
  if (state.status === 'pending') workspace.remoteBackupStatusText = '笔记有更新，自动同步将在空闲约两分钟后进行。';
  else if (state.status === 'syncing') workspace.remoteBackupStatusText = '正在合并并同步远程笔记…';
  else if (state.status === 'synced') {
    workspace.remoteBackupStatusText = `最近同步：${state.lastSyncedAt ? new Date(state.lastSyncedAt).toLocaleString() : '刚刚'} · ${Number(state.noteCount) || 0} 篇笔记`;
  } else if (state.status === 'error') {
    workspace.remoteBackupStatusText = `自动同步失败：${state.error || '未知错误'}。可手动重试。`;
  } else {
    workspace.remoteBackupStatusText = '自动同步已开启，等待笔记变更。';
  }
}

async function refreshRemoteNotesSyncStatus(): Promise<void> {
  const result = await callBackground('GET_REMOTE_NOTES_SYNC_STATE').catch(() => null);
  if (result?.ok) renderRemoteNotesSyncStatus(result.enabled, result.state);
}

export function startInlineRename(note: NoteSummary, renamePart = false): void {
  workspace.renamingNoteId = note.id;
  renamingField = renamePart && Boolean(note.part) ? 'part' : 'title';
  workspace.renamingTitle = renamingField === 'part' ? (note.part || note.title || '未命名小节') : (note.title || '未命名视频');
}

export function cancelInlineRename(): void {
  workspace.renamingNoteId = null;
  workspace.renamingTitle = '';
  renamingField = 'title';
}

export async function commitInlineRename(note: NoteSummary): Promise<void> {
  const field = renamingField;
  const normalized = workspace.renamingTitle.trim();
  const previousValue = field === 'part' ? (note.part || '') : (note.title || '');
  if (!normalized) return showNotice(field === 'part' ? '小节名称不能为空。' : '笔记名称不能为空。', 'error');
  if (normalized === previousValue) return cancelInlineRename();
  try {
    const patch = field === 'part' ? { id: note.id, part: normalized } : { id: note.id, title: normalized };
    const result = await callBackground('UPDATE_NOTE', { note: patch });
    if (!result?.ok) throw new Error(result?.error || '重命名失败。');
    savedNotes = savedNotes.map((item) => item.id === note.id ? result.note : item);
    if (latestNoteId === note.id) {
      if (field === 'part') {
        if (latestVideo) latestVideo = { ...latestVideo, part: normalized };
      } else {
        latestNoteTitle = normalized;
        workspace.noteTitle = normalized;
      }
      syncNoteEpisodeLabel();
      renderExportActions();
    }
    cancelInlineRename();
    await filterSavedNotes();
    void refreshCourseNotesMap(savedNotes);
    showNotice(field === 'part' ? '小节名称已更新。' : '笔记已重命名。', 'success');
  } catch (error) {
    showNotice((error as Error).message || '重命名失败。', 'error');
  }
}

async function flushPendingDelete(): Promise<void> {
  if (!pendingDelete) return;
  const task = pendingDelete;
  pendingDelete = null;
  clearTimeout(task.timer);
  try {
    const result = await callBackground('DELETE_NOTE', { id: task.note.id });
    if (!result?.ok) throw new Error(result?.error || '删除失败。');
    if (latestNoteId === task.note.id) latestNoteId = null;
    void refreshCacheOverview();
    void fc.refreshDueFlashcardCount();
  } catch (error) {
    savedNotes = [task.note, ...savedNotes.filter((item) => item.id !== task.note.id)];
    renderDashboardStats(savedNotes);
    await filterSavedNotes().catch(() => {});
    void refreshCourseNotesMap(savedNotes);
    showNotice((error as Error).message || '删除失败。', 'error');
  }
}

export async function deleteSavedNote(note: NoteSummary): Promise<void> {
  if (isActivelyGeneratingNoteId(note.id)) {
    return showNotice('该笔记正在生成中，请先停止生成后再删除。', 'info');
  }
  if (latestNoteId === note.id && !confirmDiscardMarkdownEdits()) return;
  await flushPendingDelete();
  const label = `${note.title || '未命名视频'}${note.part ? ` · ${note.part}` : ''}`;
  savedNotes = savedNotes.filter((item) => item.id !== note.id);
  renderDashboardStats(savedNotes);
  if (workspace.renamingNoteId === note.id) cancelInlineRename();
  await filterSavedNotes();
  void refreshCourseNotesMap(savedNotes);

  const timer = setTimeout(() => { void flushPendingDelete(); }, 5500);
  pendingDelete = { note, timer };
  showNotice(`已删除“${label}”`, 'info', {
    actionLabel: '撤销',
    durationMs: 5500,
    onAction() {
      if (!pendingDelete || pendingDelete.note.id !== note.id) return;
      clearTimeout(pendingDelete.timer);
      pendingDelete = null;
      savedNotes = [note, ...savedNotes];
      renderDashboardStats(savedNotes);
      void filterSavedNotes();
      void refreshCourseNotesMap(savedNotes);
      showNotice('已撤销删除。', 'success');
    },
  });
}

export async function openSavedNote(
  summary: NoteSummary,
  { scroll = true, returnView = null }: { scroll?: boolean; returnView?: ReturnView | null } = {}
): Promise<boolean> {
  if (!confirmDiscardMarkdownEdits()) return false;
  let loaded: any;
  try {
    loaded = await callBackground('GET_NOTE', { id: summary.id });
  } catch (error) {
    showNotice((error as Error).message || '读取笔记失败。', 'error');
    return false;
  }
  if (!loaded?.ok) {
    showNotice(loaded?.error || '读取笔记失败。', 'error');
    return false;
  }
  const note: NoteRecord = loaded.note;
  workspace.noteReturnView = returnView || (workspace.activeView === 'create' ? 'create' : 'library');
  markdownEditing = false;
  markdownEditOriginal = '';
  markdownEditMode = 'preview';
  workspace.markdownDraft = '';
  workspace.hasUnsavedMarkdown = false;
  latestViews = extractViewsFromNote(note);
  const fallbackDocKey = (Object.keys(latestViews)[0] as NoteViewKey) || 'study';
  const initialTab: NoteTab = isNoteViewKey(note.template)
    ? note.template
    : note.template === 'quiz'
      ? 'quiz'
      : note.template === 'flashcards'
        ? 'flashcards'
        : fallbackDocKey;
  activeDocumentView = isNoteViewKey(initialTab) ? initialTab : fallbackDocKey;
  workspace.noteTab = initialTab;
  latestMarkdown = latestViews[activeDocumentView] || '';
  const inferredPageCount = Number(note.pageCount)
    || Number((latestViews[activeDocumentView] || note.markdown)?.match(/第\s*\d+\/(\d+)\s*[节讲]/)?.[1])
    || Math.max(1, Number(note.page) || 1);
  const noteBvid = Keji.bvidFromUrl(note.url);
  const inferredCourseTitle = note.courseTitle
    || (noteBvid && currentVideo && Keji.bvidFromUrl(currentVideo.url) === noteBvid ? currentVideo.title : '')
    || note.title
    || '课程笔记';
  const episodeHeading = Keji.formatEpisodeHeading({
    title: note.title,
    courseTitle: inferredCourseTitle,
    part: note.part,
    page: note.page,
    pageCount: inferredPageCount,
  });
  latestCourseTitle = episodeHeading.courseTitle;
  latestNoteTitle = episodeHeading.mainTitle;
  workspace.noteTitle = latestNoteTitle;
  latestReviewMark = note.reviewMark || '';
  workspace.reviewMark = latestReviewMark;
  latestPersonalNote = String(note.personalNote || '');
  workspace.personalNote = latestPersonalNote;
  workspace.personalNoteOpen = Boolean(latestPersonalNote.trim());
  latestVideo = {
    bvid: noteBvid,
    title: episodeHeading.courseTitle,
    url: note.url,
    part: note.part,
    page: note.page,
    pageCount: inferredPageCount,
    duration: note.duration,
    cover: note.cover || ''
  };
  workspace.noteVideoUrl = safeBilibiliVideoUrl(note.url);
  syncNoteEpisodeLabel();
  latestTemplate = isNoteStructureId(note.template) ? note.template : activeDocumentView;
  workspace.selectedTemplate = latestTemplate;
  latestCustomPrompt = String(note.customPrompt || '');
  workspace.customPrompt = latestCustomPrompt;
  latestNoteId = note.id || null;
  latestGenerationModels = noteModels(note);
  latestTranscript = String(note.transcript || '');
  if (!latestTranscript && isSameLesson(currentVideo, latestVideo) && workspace.transcript.trim()) {
    latestTranscript = workspace.transcript;
  }
  const cachedFallback = !latestTranscript && latestVideo.bvid
    ? await getCachedTranscription(latestVideo).catch(() => null)
    : null;
  if (!latestTranscript && cachedFallback?.text?.trim()) {
    latestTranscript = cachedFallback.text;
  }
  if (!currentVideo || isSameLesson(currentVideo, latestVideo)) {
    tx.setSavedNoteTranscriptionState({
      transcriptSegments: note.transcriptSegments,
      detectedLanguages: note.detectedLanguages,
      cachedFallback,
    });
  }
  latestModelMarkdown = String(note.modelMarkdown || '');
  const progress = note.generationProgress;
  const savedChunkMaxChars = Number(progress?.chunkMaxChars);
  const effectiveChunkMaxChars = Number.isFinite(savedChunkMaxChars) && savedChunkMaxChars >= 1000 && savedChunkMaxChars <= 12000
    ? Math.floor(savedChunkMaxChars)
    : 12000;
  const savedTotalChunks = Number(progress?.totalChunks);
  const totalChunks = latestTranscript.trim()
    ? Keji.splitTranscript(latestTranscript, effectiveChunkMaxChars).length
    : (Number.isInteger(savedTotalChunks) && savedTotalChunks > 0 ? savedTotalChunks : 0);
  const completedChunks = Number(progress?.completedChunks);
  latestGenerationProgress = progress
    && Number(progress.totalChunks) === totalChunks
    && Number.isInteger(completedChunks)
    && completedChunks > 0
    && completedChunks < totalChunks
    && latestModelMarkdown.trim()
    ? (effectiveChunkMaxChars < 12000
      ? { completedChunks, totalChunks, chunkMaxChars: effectiveChunkMaxChars }
      : { completedChunks, totalChunks })
    : null;
  const isActivelyGeneratingThisNote = isActivelyGeneratingNoteId(note.id);
  const matchingGenJob = isActivelyGeneratingThisNote && activeGenJob && activeGenJob.noteId === note.id
    ? activeGenJob
    : null;
  const matchingVisualJob = isActivelyGeneratingThisNote && activeVisualJob && activeVisualJob.noteId === note.id
    ? activeVisualJob
    : null;
  if (matchingGenJob) {
    latestViews = { ...latestViews, ...matchingGenJob.views };
    latestModelMarkdown = matchingGenJob.modelMarkdown || latestModelMarkdown;
    latestMarkdown = latestViews[activeDocumentView] || '';
    latestGenerationProgress = matchingGenJob.generationProgress
      ? { ...matchingGenJob.generationProgress }
      : latestGenerationProgress;
    latestGenerationStatus = 'running';
    latestGenerationError = '';
    latestGeneratingView = matchingGenJob.targetTemplate || '';
    latestFailedView = '';
    latestResumableView = matchingGenJob.generationProgress && isNoteStructureId(matchingGenJob.targetTemplate)
      ? matchingGenJob.targetTemplate
      : '';
    latestGenerationStartedAt = note.generationStartedAt || '';
    syncGenerationProgressState();
    workspace.generationStageText = matchingGenJob.stageText || '正在生成课程笔记…';
    workspace.generationError = '';
  } else if (matchingVisualJob) {
    latestGenerationStatus = note.generationStatus || '';
    latestGenerationError = note.generationError || '';
    latestGenerationStartedAt = note.generationStartedAt || '';
    latestGeneratingView = isNoteViewKey(note.template) ? note.template : activeDocumentView;
    latestFailedView = '';
    latestResumableView = latestGenerationProgress
      ? (isNoteStructureId(note.template) ? note.template : activeDocumentView)
      : '';
    syncGenerationProgressState();
    workspace.generationStageText = matchingVisualJob.stageText || '正在补全关键帧截图…';
    workspace.generationError = '';
  } else {
    if (note.generationStatus === 'running') {
      const hasDoc = hasDocumentContentInRecord({ ...note, views: latestViews });
      if (hasDoc && !latestGenerationProgress) {
        latestGenerationStatus = 'completed';
        latestGenerationError = '';
        if (note.id) {
          void callBackground('UPDATE_NOTE', {
            note: { id: note.id, generationStatus: 'completed', complete: true, generationError: '' }
          }).catch(() => {});
        }
      } else {
        latestGenerationStatus = 'failed';
        latestGenerationError = note.generationError || '上次生成已中断，点击按钮可重试或继续生成剩余分段。';
        if (note.id) {
          void callBackground('UPDATE_NOTE', {
            note: { id: note.id, generationStatus: 'failed', complete: false, generationError: latestGenerationError }
          }).catch(() => {});
        }
      }
    } else {
      latestGenerationStatus = note.generationStatus || '';
      latestGenerationError = note.generationError || '';
    }
    latestGenerationStartedAt = note.generationStartedAt || '';
    latestGeneratingView = '';
    latestFailedView = latestGenerationStatus === 'failed'
      ? (isNoteStructureId(note.template) ? note.template : 'study')
      : '';
    latestResumableView = latestGenerationProgress
      ? (isNoteStructureId(note.template) ? note.template : activeDocumentView)
      : '';
    syncGenerationProgressState();
    workspace.generationStageText = '';
    workspace.generationError = (latestGenerationStatus === 'failed' && latestGenerationError) ? latestGenerationError : '';
  }
  disc.setDiscussionItems(Array.isArray(note.conversation) ? note.conversation : []);
  const legacyCardMd = (!note.flashcardMarkdown && note.template === 'flashcards' && !isPlaceholderMarkdown(note.markdown))
    ? note.markdown
    : '';
  fc.setActiveNoteFlashcardData(Array.isArray(note.flashcardReview) ? note.flashcardReview : [], String(note.flashcardMarkdown || legacyCardMd));
  fc.closeFlashcardSessionQuietly();
  const legacyQuizMd = (!note.quizState?.generatedMarkdown && note.template === 'quiz' && !isPlaceholderMarkdown(note.markdown))
    ? note.markdown
    : '';
  qz.setActiveNoteQuizRecord(
    legacyQuizMd
      ? { answers: { ...(note.quizState?.answers || {}) }, generatedMarkdown: legacyQuizMd, updatedAt: note.quizState?.updatedAt }
      : note.quizState
  );
  latestVisualAnalysis = Boolean(note.visualAnalysis);
  latestVisualAnalysisMode = note.visualAnalysisMode || (note.visualAnalysis ? 'keyframes' : 'transcript-only-or-incomplete');
  latestFrames = framesFromMarkdown(latestMarkdown);
  if (matchingGenJob) {
    if (Object.prototype.hasOwnProperty.call(matchingGenJob, 'flashcardMarkdown')) {
      fc.setActiveNoteFlashcardData(
        Array.isArray(matchingGenJob.flashcardReview) ? matchingGenJob.flashcardReview : [],
        String(matchingGenJob.flashcardMarkdown || '')
      );
    }
    if (matchingGenJob.quizState) {
      qz.setActiveNoteQuizRecord(matchingGenJob.quizState);
    }
    if (Array.isArray(matchingGenJob.conversation) && matchingGenJob.conversation.length) {
      disc.setDiscussionItems(matchingGenJob.conversation);
    }
    latestVisualAnalysis = matchingGenJob.visualAnalysis;
    latestVisualAnalysisMode = matchingGenJob.visualAnalysisMode;
    latestFrames = framesFromMarkdown(latestMarkdown);
  }
  syncGenerationUiFlags();
  renderNoteOutput();
  syncCurrentPartNote();
  renderExportActions();
  workspace.resultVisible = true;
  setWorkspaceView('note');
  void refreshCurrentLessonCacheStatus(latestVideo, latestNoteId);
  if (scroll) window.scrollTo({ top: 0 });
  return true;
}

async function refreshCurrentLessonCacheStatus(target: VideoTarget | null = latestVideo || currentVideo, noteId: string | null = latestNoteId) {
  const lessonKey = target ? Keji.lessonKey(target) : '';
  if (!lessonKey && !noteId) {
    workspace.currentLessonHasCachedAudio = false;
    workspace.currentLessonCacheBytes = 0;
    workspace.currentLessonCacheLabel = '';
    return null;
  }
  const result = await callBackground('GET_LESSON_CACHE_STATUS', { lessonKey, noteId: noteId || '' }).catch(() => null);
  if (!result?.ok || !result.status) return null;
  const activeKey = Keji.lessonKey(workspace.activeView === 'note' ? (latestVideo || currentVideo) : (currentVideo || latestVideo));
  if (lessonKey && activeKey && lessonKey !== activeKey) return result.status;
  workspace.currentLessonHasCachedAudio = Boolean(result.status.hasAudio);
  workspace.currentLessonCacheBytes = Number(result.status.totalBytes) || 0;
  workspace.currentLessonCacheLabel = workspace.currentLessonCacheBytes ? formatBytes(workspace.currentLessonCacheBytes) : '';
  return result.status;
}

export async function refreshCacheOverview() {
  const result = await callBackground('GET_CACHE_OVERVIEW').catch(() => null);
  if (!result?.ok || !result.overview) return null;
  workspace.cacheOverview = result.overview;
  workspace.totalCacheBytes = Number(result.overview.totalBytes) || 0;
  workspace.totalCacheLabel = workspace.totalCacheBytes ? formatBytes(workspace.totalCacheBytes) : '';
  return result.overview;
}

function activeMediaTarget(): VideoTarget | null {
  return workspace.activeView === 'note' ? (latestVideo || currentVideo) : (currentVideo || latestVideo);
}

export async function downloadCurrentLessonMedia(kind: 'audio' | 'video' | 'audiovisual'): Promise<void> {
  if (workspace.currentLessonMediaBusy || workspace.generating) return;
  const target = activeMediaTarget();
  if (!target) {
    showNotice('请先载入一个 B 站视频。', 'error');
    return;
  }
  const cid = Number(target.cid) || 0;
  const needAudio = kind === 'audio' || kind === 'audiovisual';
  const needVideo = kind === 'video' || kind === 'audiovisual';
  workspace.currentLessonMediaBusy = true;
  try {
    let cachedAudio = needAudio ? await getCachedAudio(target, { expectedCid: cid }) : null;
    let cachedVideo = needVideo ? await getCachedVideo(target, { expectedCid: cid }) : null;
    let cachedCombined = kind === 'audiovisual' ? await getCachedMuxedVideo(target, { expectedCid: cid }) : null;
    if ((needAudio && !cachedAudio) || (needVideo && !cachedVideo)) {
      const granted = await chrome.permissions.request({ permissions: ['offscreen'], origins: BILIBILI_CDN_ORIGINS });
      if (!granted) throw new Error('需要音频处理和 B 站 CDN 权限才能下载本节媒体文件。');
    }
    if (needAudio && !cachedAudio) {
      showNotice('正在获取并缓存音轨…', 'info');
      const response = await callBackground('CACHE_LESSON_AUDIO', { tabId: currentTabId, lesson: target });
      if (!response?.ok) throw new Error(response?.error || '下载音轨失败。');
      cachedAudio = await getCachedAudio(target, { expectedCid: cid });
    }
    if (needVideo && !cachedVideo) {
      showNotice('正在获取并缓存视频画面…', 'info');
      const prepared = await callBackground('PREPARE_VIDEO_CAPTURE');
      if (!prepared?.ok) throw new Error(prepared?.error || '无法准备视频轨下载。');
      const response = await callBackground('READ_VIDEO_SOURCE', { tabId: currentTabId, lesson: target });
      const source = response?.source;
      if (!response?.ok || !source?.url) throw new Error(response?.error || '无法读取 B 站视频轨。');
      if (String(source.bvid || '').toUpperCase() !== String(target.bvid || Keji.bvidFromUrl(target.url)).toUpperCase()
        || Number(source.page) !== Number(target.page)
        || !source.expectedCid || Number(source.expectedCid) !== Number(source.streamCid)
        || (cid && cid !== Number(source.expectedCid))) {
        throw new Error('读取视频轨期间分 P 发生切换，请重新载入课程后重试。');
      }
      await downloadAndCacheVideo(target, source.url, {
        expectedCid: Number(source.expectedCid),
        meta: { cid: Number(source.expectedCid), title: target.title || '', part: target.part || '', duration: target.duration || 0 },
        onProgress: (loaded, total) => {
          showNotice(`正在下载纯画面：${formatBytes(loaded)}${total ? ` / ${formatBytes(total)}` : ''}`, 'info');
        }
      });
      cachedVideo = await getCachedVideo(target, { expectedCid: cid });
    }
    if (kind === 'audiovisual' && !cachedCombined) {
      showNotice('正在封装音画视频…', 'info');
      await putCachedMuxedVideo(target, {
        expectedCid: cid,
        onProgress: (fraction) => {
          showNotice(`正在封装音画视频：${Math.round(fraction * 100)}%`, 'info');
        }
      });
      cachedCombined = await getCachedMuxedVideo(target, { expectedCid: cid });
    }
    const blob = kind === 'audio' ? cachedAudio?.file
      : kind === 'video' ? cachedVideo?.file
      : cachedCombined?.file;
    if (!blob) throw new Error('未能准备好媒体文件。');
    const bvid = target.bvid || Keji.bvidFromUrl(target.url);
    const name = `${bvid}_p${Number(target.page) || 1}.${kind === 'audio' ? 'audio.m4a' : kind === 'video' ? 'video.mp4' : 'audiovisual.mp4'}`;
    downloadBlob(name, blob);
    showNotice('已开始下载媒体文件。', 'success');
    void refreshCurrentLessonCacheStatus(target, workspace.activeView === 'note' ? latestNoteId : null);
    void refreshCacheOverview();
  } catch (error) {
    showNotice((error as Error).message || '下载媒体文件失败。', 'error');
  } finally {
    workspace.currentLessonMediaBusy = false;
  }
}

function clearActiveNoteProcessState(clearCurrentAudioFlag = false, clearCreateTranscript = false): void {
  latestTranscript = '';
  latestModelMarkdown = '';
  latestGenerationProgress = null;
  tx.clearTranscriptProcessMetadata(clearCreateTranscript);
  if (clearCreateTranscript) updateCharacterCount();
  if (clearCurrentAudioFlag) {
    workspace.currentLessonHasCachedAudio = false;
  }
  workspace.currentLessonCacheBytes = 0;
  workspace.currentLessonCacheLabel = '';
}

export async function clearCurrentLessonCache(): Promise<void> {
  if (workspace.clearingCache || workspace.generating) return;
  const target = latestVideo || currentVideo;
  const lessonKey = target ? Keji.lessonKey(target) : '';
  if (!lessonKey && !latestNoteId) return;
  const sizeHint = workspace.currentLessonCacheLabel ? `（${workspace.currentLessonCacheLabel}）` : '';
  if (!window.confirm(`清理本节课的媒体缓存${sizeHint}？缓存的音轨、原视频流与转写缓存将被删除，已生成的笔记正文、截图、闪卡/自测记录与互动会话会完整保留。`)) {
    return;
  }
  workspace.clearingCache = true;
  try {
    tx.clearPendingTranscriptCacheTimer();
    const result = await callBackground('CLEAR_LESSON_CACHE', { lessonKey, noteId: latestNoteId || '' });
    if (!result?.ok) throw new Error(result?.error || '清理本节媒体缓存失败。');

    const sameAsCurrentVideo = Boolean(currentVideo && (!lessonKey || Keji.lessonKey(currentVideo) === lessonKey));
    clearActiveNoteProcessState(sameAsCurrentVideo, sameAsCurrentVideo);
    renderExportActions();
    await Promise.all([refreshCurrentLessonCacheStatus(target, latestNoteId), refreshCacheOverview()]);
    const freed = Number(result.freedBytes) || 0;
    showNotice(freed ? `已清理本节媒体缓存（释放 ${formatBytes(freed)}），笔记结果已保留。` : '已清理本节媒体缓存。', 'success');
  } catch (error) {
    showNotice((error as Error).message || '清理本节媒体缓存失败。', 'error');
  } finally {
    workspace.clearingCache = false;
  }
}

export async function clearAllProcessCache(): Promise<void> {
  if (workspace.clearingCache || workspace.generating) return;
  let totalBytes = Number(workspace.totalCacheBytes) || 0;
  if (!totalBytes) {
    const overview = await refreshCacheOverview();
    totalBytes = Number(overview?.totalBytes) || 0;
  }
  if (!totalBytes) return showNotice('当前没有可清理的媒体缓存。', 'info');
  if (!window.confirm(`清理全部课程的媒体缓存（共 ${formatBytes(totalBytes)}）？所有缓存的音轨、原视频流与转写缓存将被删除，已保存的笔记正文、截图、闪卡/自测记录与互动会话均会完整保留。`)) {
    return;
  }
  workspace.clearingCache = true;
  try {
    tx.clearPendingTranscriptCacheTimer();
    const result = await callBackground('CLEAR_ALL_CACHES');
    if (!result?.ok) throw new Error(result?.error || '清理媒体缓存失败。');

    clearActiveNoteProcessState(true, true);
    renderExportActions();
    await refreshCacheOverview();
    if (workspace.activeView === 'library') await renderRecentNotes().catch(() => {});
    const freed = Number(result.freedBytes) || 0;
    showNotice(freed ? `已清理全部媒体缓存（释放 ${formatBytes(freed)}），笔记结果均已保留。` : '已清理全部媒体缓存。', 'success');
  } catch (error) {
    showNotice((error as Error).message || '清理媒体缓存失败。', 'error');
  } finally {
    workspace.clearingCache = false;
  }
}

export function initWorkspace(): void {
  if (initialized) return;
  initialized = true;

  fc.configureFlashcardHost({
    enterCrossNoteReviewView() {
      clearActiveNoteState();
      workspace.noteReturnView = 'library';
      workspace.noteTitle = '到期闪卡复习';
      workspace.canEditTitle = false;
      workspace.noteTab = 'flashcards';
      workspace.resultVisible = true;
      setWorkspaceView('note');
    },
    exitCrossNoteReviewView() {
      workspace.resultVisible = false;
      workspace.noteTitle = '';
      setWorkspaceView('library');
    },
  });

  tx.configureTranscriptionHost({
    getCurrentVideo: () => currentVideo,
    getLatestVideo: () => latestVideo,
    getLatestNoteTitle: () => latestNoteTitle,
    getCurrentTabId: () => currentTabId,
    requestAudioPermissions,
    onTranscriptChanged: updateCharacterCount,
    onInvalidateGeneratedDraft() {
      if (!isSameLesson(currentVideo, latestVideo)) return;
      latestModelMarkdown = '';
      latestGenerationProgress = null;
      latestResumableView = '';
      syncGenerationProgressState();
    },
    onCacheUpdated: (target) => void refreshCurrentLessonCacheStatus(target, latestNoteId),
  });

  disc.configureDiscussionHost({
    getContext: () => {
      const targetKey = latestViews[activeDocumentView] ? activeDocumentView : getPrimaryDocumentView().key;
      const markdown = latestViews[targetKey] || '';
      return {
        noteId: latestNoteId,
        markdown,
        targetViewKey: targetKey,
        targetViewLabel: getNoteStructure(targetKey).label,
        transcript: getEffectiveActiveTranscript(),
        videoUrl: workspace.noteVideoUrl || latestVideo?.url || '',
        frames: framesFromMarkdown(markdown),
      };
    },
    async resolveTranscript() {
      const activeTranscript = getEffectiveActiveTranscript();
      if (activeTranscript) return activeTranscript;
      if (!latestVideo) return '';
      const cached = await getCachedTranscription(latestVideo).catch(() => null);
      return cached?.text?.trim() || '';
    },
    async applyNoteRevision(input) {
      const { noteId, viewKey, baseMarkdown, revisedMarkdown, messages, requestId } = input;
      if (!noteId || !isNoteViewKey(viewKey)) throw new Error('无法确定待修订的笔记和视图。');
      const result = await callBackground('REVISE_NOTE_VIEW', {
        input: { id: noteId, viewKey, expectedMarkdown: baseMarkdown, markdown: revisedMarkdown, messages, requestId }
      });
      if (!result?.ok) throw new Error(result?.error || '保存笔记修订失败。');
      if (activeGenJob?.noteId === noteId) activeGenJob.views[viewKey] = revisedMarkdown;
      if (latestNoteId === noteId) {
        latestViews[viewKey] = revisedMarkdown;
        if (activeDocumentView === viewKey) {
          latestMarkdown = revisedMarkdown;
          latestFrames = framesFromMarkdown(revisedMarkdown);
          renderNoteOutput();
          renderExportActions();
        }
      }
      refreshLibraryViewsIfVisible();
      return { noteId, viewKey, label: getNoteStructure(viewKey).label,
        previousMarkdown: baseMarkdown, revisedMarkdown };
    },
    async undoNoteRevision(snapshot) {
      if (!isNoteViewKey(snapshot.viewKey)) throw new Error('无法确定待撤销的视图。');
      const { noteId, viewKey, previousMarkdown, revisedMarkdown } = snapshot;
      const result = await callBackground('REVISE_NOTE_VIEW', {
        input: { id: noteId, viewKey, expectedMarkdown: revisedMarkdown, markdown: previousMarkdown }
      });
      if (!result?.ok) throw new Error(result?.error || '撤销笔记修订失败。');
      if (activeGenJob?.noteId === noteId) activeGenJob.views[viewKey] = previousMarkdown;
      if (latestNoteId === noteId) {
        latestViews[viewKey] = previousMarkdown;
        if (activeDocumentView === viewKey) {
          latestMarkdown = previousMarkdown;
          latestFrames = framesFromMarkdown(previousMarkdown);
          renderNoteOutput();
          renderExportActions();
        }
      }
      refreshLibraryViewsIfVisible();
    },
    async saveConversationOnly(conversation: ConversationItem[], requestedNoteId) {
      const targetId = requestedNoteId !== undefined ? requestedNoteId : latestNoteId;
      if (!targetId) return;
      const result = await callBackground('UPDATE_NOTE', { note: { id: targetId, conversation } });
      if (!result?.ok) throw new Error(result?.error || '保存互动记录失败。');
      if (activeGenJob && activeGenJob.noteId === targetId) {
        activeGenJob.conversation = conversation;
      }
    },
  });

  history.replaceState({ ...history.state, workspaceIndex: historyIndex }, '');
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.transcription) tx.handleTranscriptionStorageChange(changes.transcription.newValue);
    if (area === 'local' && changes.remoteBackupSyncState) void refreshRemoteNotesSyncStatus();
    const videoProgressKey = getActiveVideoProgressStorageKey();
    if (area === 'session' && videoProgressKey) {
      const progress = changes[videoProgressKey]?.newValue;
      if (progress) renderVideoProgress(progress);
    }
  });
  void callBackground('GET_SETTINGS').then((result) => {
    if (result?.ok) applyWorkspaceSettings(result.settings || {});
  }).catch(() => {});

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeTabAccessId) activeTabAccessId = null;
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== activeTabAccessId || !changeInfo.url) return;
    try {
      if (new URL(changeInfo.url).origin !== launchOrigin) activeTabAccessId = null;
    } catch {
      activeTabAccessId = null;
    }
  });

  window.addEventListener('pagehide', () => {
    if (pendingDelete) void flushPendingDelete();
  });

  if (launchVideoUrl) {
    setWorkspaceView('create');
    workspace.videoUrl = launchVideoUrl;
    if (currentTabId) void loadCurrentVideo(launchVideoUrl);
    else {
      workspace.videoTitle = '准备载入 B 站视频';
      workspace.videoMeta = '确认链接后载入视频。';
      workspace.captionStatus = '点击“载入视频”后，课记会请求读取该页面所需的权限。';
    }
  } else {
    const hashView = location.hash.slice(1);
    setWorkspaceView(hashView === 'home' ? 'create' : (hashView || 'create'), { record: false });
    workspace.videoTitle = '还没有连接到 B 站视频';
    workspace.videoMeta = '粘贴 B 站视频链接后载入课程。';
    workspace.captionStatus = '载入视频后，课记会自动读取当前小节字幕。';
    workspace.courseTitle = '等待载入视频';
    workspace.hasCaptions = false;
  }
}
