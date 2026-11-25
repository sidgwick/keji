import { createNoteBundleZip } from '../bundle-zip.ts';
import {
  Keji,
  type ConversationItem,
  type GenerationProgress,
  type KejiSettings,
  type KeyFrameItem,
  type NoteRecord,
  type NoteSummary,
  type TemplateId,
  type VideoPart,
  type VideoTarget,
} from '../keji.ts';
import { BILIBILI_CDN_ORIGINS, downloadAndCacheVideo, formatBytes, getCachedAudio, getCachedMuxedVideo, getCachedTranscription, getCachedVideo, putCachedMuxedVideo } from '../lesson-cache.ts';
import {
  formatNoteMarkdown,
  mergeMarkdownSections,
  noteBodyMarkdown,
  renderMarkdownPreview,
  restoreScreenshotEmbeds,
} from '../markdown.ts';
import { getNoteStructure, isNoteStructureId } from '../note-structures.ts';
import * as disc from './discussion.svelte.ts';
import * as fc from './flashcards.svelte.ts';
import * as qz from './quiz.svelte.ts';
import { workspace, type LibraryViewMode, type MarkdownMode, type ReturnView, type WorkspaceView } from './state.svelte.ts';
import * as tx from './transcription.svelte.ts';
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
let markdownEditing = false;
let markdownEditOriginal = '';
let markdownEditMode: MarkdownMode = 'preview';
let latestNoteTitle = '';
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

function savedNoteStatus(note: Partial<NoteSummary>): string {
  if (note.generationStatus === 'failed') return 'failed';
  if (note.generationStatus === 'running') {
    const activityAt = Date.parse(note.updatedAt || note.generationStartedAt || '');
    const age = Date.now() - activityAt;
    return Number.isFinite(activityAt) && age >= 0 && age < 30 * 60 * 1000 ? 'processing' : 'interrupted';
  }
  if (note.visualAnalysis === true) return 'audiovisual';
  const completed = Number(note.generationProgress?.completedChunks);
  const total = Number(note.generationProgress?.totalChunks);
  if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) return completed >= total ? 'transcript' : 'partial';
  if (note.complete === true) return 'transcript';
  if (note.complete === false) return 'partial';
  return 'unknown';
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
  ].map(([value, label]) => ({ value, label }));
}

async function renderDashboard(): Promise<void> {
  const response = await callBackground('LIST_NOTES', { previewLimit: 5 });
  if (!response?.ok) throw new Error(response?.error || '读取最近笔记失败。');
  renderDashboardStats(response.allNotes || []);
  workspace.dashboardRows = ((response.notes || []) as NoteSummary[]).slice(0, 5).map((note) => {
    const models = noteModels(note);
    const status = statusLabels[savedNoteStatus(note)] || '已保存';
    return {
      note,
      coverUrl: safeCoverUrl(note.cover),
      title: `${note.title || '未命名视频'}${note.part ? ` · ${note.part}` : ''}`,
      meta: [status, models.length ? models.join('、') : '模型未记录', formatShortDate(note.updatedAt || note.createdAt)].filter(Boolean).join(' · '),
      error: note.generationError || '',
      excerpt: note.excerpt || '',
    };
  });
}

function setWorkspaceView(view: string, { record = true } = {}): void {
  const activeView: WorkspaceView = (['home', 'create', 'library', 'note', 'settings'].includes(view) ? view : 'home') as WorkspaceView;
  const previousView = workspace.activeView;
  workspace.activeView = activeView;
  if (previousView === 'note' && activeView !== 'note') {
    fc.closeFlashcardSessionQuietly();
    qz.closeQuizPanelQuietly();
    if (!latestMarkdown && workspace.resultVisible) {
      workspace.resultVisible = false;
      workspace.noteTitle = '';
    }
  }
  if (record && location.hash !== `#${activeView}`) {
    history.pushState({ view: activeView, workspaceIndex: ++historyIndex }, '', `#${activeView}`);
  }
  if (previousView !== activeView) window.scrollTo(0, 0);
  if (activeView === 'home') {
    workspace.dashboardError = '';
    void renderDashboard().catch((error: Error) => {
      workspace.dashboardError = error.message || '读取最近笔记失败。';
    });
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

export function showDashboard(): void {
  navigateView('home');
}

export function showNoteLibrary(): void {
  navigateView('library');
}

export function showCompletedNotes(): void {
  if (!confirmDiscardMarkdownEdits()) return;
  workspace.notesSearch = '';
  workspace.notesModelFilter = '';
  workspace.notesStatusFilter = 'completed';
  navigateView('library', { guard: false });
}

export function openCreateView(): void {
  if (!navigateView('create')) return;
  if (!workspace.currentVideo) requestAnimationFrame(() => elements.videoUrl?.focus());
}

export function openSettingsView(group = ''): void {
  navigateView('settings', { group });
}

function computeCanGenerate(): boolean {
  return Boolean(
    currentVideo
    && !tx.hasUnresolvedTranscriptionConflict()
    && (workspace.transcript.trim() || workspace.modelCapability === 'video_audio')
  );
}

export function applyWorkspaceSettings(settings: Partial<KejiSettings> & Record<string, unknown> = {}): void {
  workspace.modelConfigured = Boolean(
    String(settings?.baseUrl || '').trim() && String(settings?.model || '').trim()
  );
  workspace.currentModelLabel = String(settings?.model || '').trim();
  workspace.apiProtocol = Keji.normalizeProtocol(settings?.apiProtocol, String(settings?.baseUrl || ''));
  workspace.modelCapability = Keji.normalizeCapability(settings?.modelCapability, settings?.videoInputMode);
  workspace.remoteBackupConfigured = Boolean(String(settings?.remoteBackupUrl || '').trim());
  workspace.canGenerate = computeCanGenerate();
  renderExportActions();
  void refreshRemoteNotesSyncStatus();
}

export function goBackFromNote(): void {
  navigateView(['home', 'create'].includes(workspace.noteReturnView) ? workspace.noteReturnView : 'library');
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
    workspace.generateLabel = existing ? '重新生成（覆盖本节笔记）' : '生成学习笔记';
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
  workspace.markdownDraft = '';
  workspace.hasUnsavedMarkdown = false;
  workspace.resultVisible = false;
  latestMarkdown = '';
  latestNoteTitle = '';
  workspace.noteTitle = '';
  latestVideo = video;
  workspace.noteVideoUrl = video ? safeBilibiliVideoUrl(video.url) : '';
  workspace.generationStageText = '';
  workspace.generationError = '';
  latestCustomPrompt = '';
  latestModelMarkdown = '';
  latestGenerationProgress = null;
  latestGenerationModels = [];
  latestFrames = [];
  latestNoteId = null;
  latestTranscript = '';
  disc.setDiscussionItems([]);
  fc.setActiveNoteFlashcardReview([]);
  fc.closeFlashcardSessionQuietly();
  qz.setActiveNoteQuizRecord(undefined);
  qz.closeQuizPanelQuietly();
  tx.resetTranscriptionForNewVideo(false);
  latestVisualAnalysis = false;
  latestVisualAnalysisMode = 'transcript-only-or-incomplete';
  renderFrameGallery([]);
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
    workspace.currentLessonHasCachedVideo = false;
    workspace.currentLessonHasCachedMuxedVideo = false;
    workspace.currentLessonMediaSizes = { audio: 0, video: 0, audiovisual: 0 };
    workspace.currentLessonMediaStatus = '';
    resetActiveNoteFields(currentVideo);
    tx.resetTranscriptionForNewVideo(true);
  }
  if (!markdownEditing) workspace.noteTitle = currentVideo!.title || '';
  workspace.videoTitle = currentVideo!.title || '未命名视频';
  workspace.videoMeta = `${currentVideo!.part || '当前分 P'}  ·  第 ${currentVideo!.page || 1}/${currentVideo!.pageCount || 1} 节${currentVideo!.duration ? `  ·  ${Keji.formatTime(currentVideo!.duration)}` : ''}`;
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

function matchesVideoTarget(video: VideoTarget | null, url: string | URL | null): boolean {
  if (!video || !url) return false;
  try {
    const parsed = url instanceof URL ? url : new URL(url);
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
      tab = await chrome.tabs.update(tab.id, { url: requestedUrl.toString(), active: false });
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
  workspace.captionStatus = '正在检查当前分 P 字幕…';
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

function renderFrameGallery(frames: KeyFrameItem[]): void {
  workspace.frames = [...frames];
}

async function persistCurrentNote(complete: boolean): Promise<void> {
  const txMeta = tx.getTranscriptionMetadata();
  const note: Partial<NoteRecord> = {
    title: latestNoteTitle,
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
    flashcardReview: fc.getActiveNoteFlashcardReview(),
    quizState: qz.getActiveNoteQuizRecord(),
    conversation: disc.getDiscussionItems(),
    markdown: latestMarkdown
  };
  if (latestNoteId) note.id = latestNoteId;
  const result = latestNoteId
    ? await callBackground('UPDATE_NOTE', { note })
    : await callBackground('SAVE_NOTE', { note });
  if (!result?.ok) throw new Error(result?.error || '笔记保存失败。');
  latestNoteId = result.note?.id || latestNoteId;
}

function renderExportActions(): void {
  const transcriptUnchanged = workspace.transcript.trim() === latestTranscript.trim();
  const hasTranscriptOrAudioCapability = Boolean(
    latestTranscript.trim() || workspace.modelCapability === 'video_audio'
  );
  workspace.canResumeGeneration = Boolean(latestGenerationProgress
    && latestGenerationProgress.completedChunks < latestGenerationProgress.totalChunks
    && latestModelMarkdown
    && transcriptUnchanged);
  const textGenerationComplete = !latestGenerationProgress
    || latestGenerationProgress.completedChunks >= latestGenerationProgress.totalChunks;
  workspace.hasMarkdown = Boolean(latestMarkdown);
  workspace.resultVisible = Boolean(latestMarkdown);
  workspace.markdownEditing = markdownEditing;
  workspace.markdownMode = markdownEditMode;
  workspace.canEditTitle = Boolean(latestMarkdown && textGenerationComplete && !workspace.generating);
  workspace.showResultActions = !markdownEditing;
  workspace.showDiscussion = !markdownEditing;
  workspace.canRegenerateNote = Boolean(
    latestMarkdown && latestVideo && textGenerationComplete && !workspace.generating && hasTranscriptOrAudioCapability
  );
  const hasUncapturedKeyframes = /关键时刻\s*·[^\n]*（截图未能捕获/.test(latestMarkdown);
  workspace.showRetryVisualAnalysis = !(
    !Keji.supportsImage(workspace.modelCapability)
    || (latestVisualAnalysis && !hasUncapturedKeyframes)
    || !textGenerationComplete
    || !latestMarkdown
    || !latestVideo
    || !hasTranscriptOrAudioCapability
    || !transcriptUnchanged
  );
  fc.syncActiveNoteFlashcards({
    noteId: latestNoteId,
    title: latestNoteTitle || latestVideo?.title || '',
    markdown: latestMarkdown,
    template: latestTemplate,
    videoUrl: latestVideo?.url || '',
    editing: markdownEditing,
  });
  qz.syncActiveNoteQuiz({
    noteId: latestNoteId,
    title: latestNoteTitle || latestVideo?.title || '',
    markdown: latestMarkdown,
    transcript: latestTranscript,
    frames: latestFrames,
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
  if (mode === 'edit' && !markdownEditing) {
    markdownEditOriginal = latestMarkdown;
    workspace.markdownDraft = latestMarkdown;
    workspace.hasUnsavedMarkdown = false;
    markdownEditing = true;
  } else if (mode === 'preview' && markdownEditing && workspace.markdownDraft === markdownEditOriginal) {
    markdownEditing = false;
    workspace.markdownDraft = '';
    workspace.hasUnsavedMarkdown = false;
    renderNoteOutput();
  }
  markdownEditMode = mode;
  workspace.markdownMode = mode;
  workspace.markdownEditing = markdownEditing;
  renderExportActions();
  if (markdownEditing && mode === 'preview') renderNoteOutput(workspace.markdownDraft);
  if (mode === 'edit') requestAnimationFrame(() => elements.markdownEditor?.focus());
}

function discardMarkdownEditing(): void {
  renderNoteOutput();
  markdownEditing = false;
  markdownEditOriginal = '';
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
  const updated = workspace.markdownDraft.trim();
  if (!updated) return showNotice('Markdown 笔记不能为空。', 'error');
  const previousMarkdown = latestMarkdown;
  const previousModelMarkdown = latestModelMarkdown;
  latestMarkdown = updated;
  latestModelMarkdown = noteBodyMarkdown(updated);
  workspace.markdownSaving = true;
  try {
    await persistCurrentNote(latestVisualAnalysis);
    markdownEditing = false;
    markdownEditOriginal = '';
    workspace.markdownDraft = '';
    workspace.hasUnsavedMarkdown = false;
    markdownEditMode = 'preview';
    workspace.markdownEditing = false;
    workspace.markdownMode = 'preview';
    latestFrames = framesFromMarkdown(latestMarkdown);
    renderNoteOutput();
    renderFrameGallery(latestFrames);
    renderExportActions();
    showNotice('笔记修改已保存到本机。', 'success');
  } catch (error) {
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
  if (!latestNoteId) return;
  workspace.titleSaving = true;
  try {
    await persistCurrentNote(latestVisualAnalysis);
    savedNotes = savedNotes.map((item) => item.id === latestNoteId ? { ...item, title: nextTitle } : item);
    void refreshCourseNotesMap();
    renderExportActions();
    showNotice('标题已保存。', 'success');
  } catch (error) {
    latestNoteTitle = previousTitle;
    workspace.noteTitle = previousTitle;
    showNotice(`标题保存失败：${(error as Error).message || '存储空间不足'}`, 'error');
  } finally {
    workspace.titleSaving = false;
  }
}

export function revertNoteTitleInline(inputElement: HTMLInputElement | null = null): void {
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

export function resetNotesFilters(): void {
  workspace.notesSearch = '';
  workspace.notesModelFilter = '';
  workspace.notesStatusFilter = '';
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
  if (!latestMarkdown || !latestVideo) return;
  if (!Keji.supportsImage(workspace.modelCapability)) {
    return showNotice('当前模型能力为「仅支持文本」，请在设置中开启图片或视频能力后再补充画面分析。', 'info');
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
    showNotice('本节暂无缓存的原视频流；请先在浏览器标签页打开这篇笔记对应的 B 站分 P，再重试画面分析。', 'error');
    return;
  }
  if (workspace.transcript.trim() !== latestTranscript.trim()) {
    showNotice('文字稿已修改。请先重新生成笔记，再进行画面分析。', 'error');
    return;
  }

  if (elements.retryVisualAnalysis) elements.retryVisualAnalysis.disabled = true;
  workspace.generating = true;
  generationCancelled = false;
  activeGenerationTaskId = crypto.randomUUID();
  activeCaptureAbortController = new AbortController();
  const originalMarkdown = latestMarkdown;
  const initialBodyMarkdown = noteBodyMarkdown(latestMarkdown)
    .replace(/!\[([^\]]*)\]\(data:image\/[^;]+;base64,[^)]+\)/g, '[视频关键帧：$1]');
  const previouslyCapturedFrames = [...latestFrames];
  try {
    workspace.generationError = '';
    const settingsResult = await callBackground('GET_SETTINGS');
    const result = await runVisualAnalysisPipeline({
      video: latestVideo,
      transcript: latestTranscript,
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
    if (!result.visualAnalysis) throw new Error(result.visualError || '笔记中没有可用的关键帧标记，无法重试画面分析。');

    latestVisualAnalysis = true;
    latestVisualAnalysisMode = result.visualAnalysisMode;
    latestFrames = result.frames;
    latestGenerationError = '';
    const finalTitle = latestNoteTitle || latestVideo.title || '课程笔记';
    latestMarkdown = restoreScreenshotEmbeds(
      formatNoteMarkdown(finalTitle, latestVideo, result.bodyMarkdown),
      originalMarkdown
    );
    renderNoteOutput();
    renderFrameGallery(latestFrames);
    renderExportActions();
    await persistCurrentNote(true);
    workspace.generationStageText = '';
    showNotice(result.captureFailed
      ? '画面分析已完成，部分截图未能捕获。'
      : `画面分析已完成，已嵌入 ${latestFrames.length} 张关键帧。`, 'success');
  } catch (error) {
    const err = error as Error & { cancelled?: boolean };
    latestMarkdown = originalMarkdown;
    latestVisualAnalysis = false;
    latestVisualAnalysisMode = 'transcript-only-or-incomplete';
    latestFrames = previouslyCapturedFrames;
    renderNoteOutput();
    renderFrameGallery(latestFrames);
    renderExportActions();
    await persistCurrentNote(false).catch(() => {});
    workspace.generationStageText = '';
    if (generationCancelled || err?.cancelled || err?.name === 'AbortError') {
      showNotice('已停止画面分析。', 'info');
    } else {
      const message = `画面分析未完成：${err.message || '未知错误'}`;
      workspace.generationError = message;
      showNotice(message, 'error');
    }
  } finally {
    workspace.generating = false;
    activeGenerationTaskId = '';
    activeCaptureAbortController = null;
    if (elements.retryVisualAnalysis) elements.retryVisualAnalysis.disabled = false;
    renderExportActions();
    void refreshCurrentLessonCacheStatus(latestVideo, latestNoteId);
  }
}

function downloadNoteBundle(note: Pick<NoteRecord, 'title' | 'markdown'>): void {
  const bundle = createNoteBundleZip(note);
  downloadBlob(bundle.filename, new Blob([bundle.zip.buffer as ArrayBuffer], { type: 'application/zip' }));
  showNotice(bundle.imageCount ? `已导出资源包（含 ${bundle.imageCount} 张截图）。` : '已导出资源包。', 'success');
}

export async function exportCurrentNoteBundle(): Promise<void> {
  if (!latestMarkdown) return;
  try {
    downloadNoteBundle({ title: latestNoteTitle || latestVideo?.title || '课程笔记', markdown: latestMarkdown });
  } catch (error) {
    showNotice((error as Error).message || '资源包导出失败。', 'error');
  }
}

export async function cancelGeneration(): Promise<void> {
  if (!workspace.generating || generationCancelled) return;
  generationCancelled = true;
  workspace.generationStageText = '正在停止生成…';
  activeCaptureAbortController?.abort();
  if (activeGenerationTaskId) {
    await callBackground('CANCEL_GENERATION', { taskId: activeGenerationTaskId }).catch(() => {});
  }
}

export async function regenerateOpenedNote(templateId: TemplateId): Promise<void> {
  if (workspace.generating || !latestVideo || (Keji.requiresTranscript(workspace.modelCapability) && !latestTranscript.trim())) return;
  if (!confirmDiscardMarkdownEdits()) return;
  if (markdownEditing) discardMarkdownEditing();
  const template = getNoteStructure(templateId);
  if (template.id === 'custom' && !latestCustomPrompt.trim() && !workspace.customPrompt.trim()) {
    if (!currentVideo || Keji.lessonKey(currentVideo) !== Keji.lessonKey(latestVideo)) {
      currentVideo = { ...latestVideo };
      workspace.currentVideo = currentVideo;
      workspace.videoTitle = latestVideo.title || '未命名视频';
      workspace.videoMeta = `${latestVideo.part || '当前分 P'}${latestVideo.page ? `  ·  第 ${latestVideo.page} 节` : ''}`;
      workspace.videoUrl = latestVideo.url || '';
      workspace.transcript = latestTranscript;
      updateCharacterCount();
      void refreshCourseNotesMap();
    }
    workspace.selectedTemplate = 'custom';
    setWorkspaceView('create');
    requestAnimationFrame(() => elements.customPrompt?.focus());
    showNotice('请填写自定义要求后点击重新生成。', 'info');
    return;
  }
  if (!window.confirm(`按「${template.label}」重新生成将覆盖本节现有笔记，确定继续吗？`)) return;
  workspace.selectedTemplate = template.id;
  if (template.id === 'custom' && !workspace.customPrompt.trim()) workspace.customPrompt = latestCustomPrompt;
  await generate(false, { skipConfirm: true, fromOpenedNote: true });
}

export async function generate(resume = false, options: { skipConfirm?: boolean; fromOpenedNote?: boolean } = {}): Promise<void> {
  const isResume = Boolean(resume);
  const fromOpenedNote = Boolean(options?.fromOpenedNote);
  const skipConfirm = Boolean(options?.skipConfirm);
  if (!isResume && !fromOpenedNote && tx.hasUnresolvedTranscriptionConflict()) {
    return showNotice('请先查看本次识别稿，并选择替换文字稿或继续使用当前稿。', 'error');
  }
  if (!isResume && !confirmDiscardMarkdownEdits()) return;
  const transcript = (isResume || fromOpenedNote) ? latestTranscript.trim() : workspace.transcript.trim();
  const video = (isResume || fromOpenedNote) ? latestVideo : currentVideo;
  if (isResume && workspace.transcript.trim() !== transcript) {
    return showNotice('文字稿已修改，不能用旧分段进度续跑；请重新生成以确保内容一致。', 'error');
  }
  const useDirectAudio = !transcript && workspace.modelCapability === 'video_audio';
  if (!transcript && !useDirectAudio) {
    showNotice('先读取字幕，或粘贴课程文字稿。', 'error');
    elements.transcript?.focus();
    return;
  }
  if (!video) return showNotice('请先载入 B 站视频。', 'error');
  if (!isResume && workspace.selectedTemplate === 'custom' && !workspace.customPrompt.trim()) {
    showNotice('请先填写自定义 Prompt。', 'error');
    elements.customPrompt?.focus();
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
  if (!isResume) {
    const lessonKey = Keji.lessonKey(video);
    let existingSummary: NoteSummary | null = fromOpenedNote && latestNoteId
      ? { id: latestNoteId, title: latestNoteTitle }
      : workspace.currentPartNote;
    if (!existingSummary && lessonKey) {
      const listed = await callBackground('LIST_NOTES').catch(() => null);
      if (listed?.ok) existingSummary = ((listed.notes || []) as NoteSummary[]).find((item) => Keji.lessonKey(item) === lessonKey) || null;
    }
    if (existingSummary) {
      if (!skipConfirm && !window.confirm('本节已有保存的笔记，重新生成将覆盖现有内容。确定继续吗？')) return;
      if (existingSummary.id) {
        const loaded = await callBackground('GET_NOTE', { id: existingSummary.id }).catch(() => null);
        if (loaded?.ok && loaded.note) previousNoteSnapshot = loaded.note;
      }
    }
  }

  let audioChunks: Array<{ index: number; start: number; end: number }> = [];
  if (useDirectAudio) {
    workspace.generationStageText = '正在获取并准备课程音轨用于直接理解…';
    const prepared = await callBackground('PREPARE_LESSON_AUDIO', { tabId: currentTabId, lesson: video });
    if (!prepared?.ok) {
      showNotice(prepared?.error || '准备课程音轨失败。', 'error');
      return;
    }
    audioChunks = Keji.audioChunkRanges(Number(prepared.duration) || Number(video.duration) || 0, 600);
  }
  const resumeFrom = isResume ? Number(latestGenerationProgress?.completedChunks) || 0 : 0;
  const segmentCount = useDirectAudio ? audioChunks.length : Keji.splitTranscript(transcript).length;
  if (isResume && (!latestGenerationProgress || resumeFrom <= 0 || resumeFrom >= segmentCount || !latestModelMarkdown)) {
    if (useDirectAudio) void callBackground('RELEASE_LESSON_AUDIO').catch(() => {});
    return showNotice(useDirectAudio ? '没有可续跑的音频分段，请重新生成笔记。' : '没有可续跑的文字稿分段，请重新生成笔记。', 'error');
  }

  generationCancelled = false;
  activeGenerationTaskId = crypto.randomUUID();
  activeCaptureAbortController = new AbortController();
  workspace.generationProgress = { completedChunks: resumeFrom, totalChunks: segmentCount };
  workspace.generating = true;
  workspace.generationError = '';
  workspace.generationStageText = segmentCount > 1
    ? `${isResume ? `从第 ${resumeFrom + 1}/${segmentCount} 段` : `${useDirectAudio ? '音频' : '文字稿'}共 ${segmentCount} 段`}开始整理，完成一段后会自动保存。`
    : (useDirectAudio ? '正在将音轨直接提交给多模态模型生成笔记…' : '正在发送到配置的模型生成笔记…');
  if (elements.resumeGeneration) {
    elements.resumeGeneration.disabled = true;
    elements.resumeGeneration.textContent = '正在继续…';
  }
  if (elements.retryVisualAnalysis) elements.retryVisualAnalysis.disabled = true;
  workspace.generateLabel = isResume ? '正在续跑…' : '正在请求模型…';

  try {
    if (!isResume) {
      const preservedTitle = previousNoteSnapshot?.title || video.title || '课程笔记';
      disc.setDiscussionItems([]);
      fc.setActiveNoteFlashcardReview(
        Array.isArray(previousNoteSnapshot?.flashcardReview) ? previousNoteSnapshot.flashcardReview : []
      );
      fc.closeFlashcardSessionQuietly();
      qz.setActiveNoteQuizRecord(previousNoteSnapshot?.quizState);
      qz.closeQuizPanelQuietly();
      latestNoteId = previousNoteSnapshot?.id || null;
      latestModelMarkdown = '';
      latestFrames = [];
      latestTemplate = workspace.selectedTemplate;
      latestCustomPrompt = workspace.customPrompt;
      latestNoteTitle = preservedTitle;
      workspace.noteTitle = preservedTitle;
      latestVideo = { ...video };
      workspace.noteVideoUrl = safeBilibiliVideoUrl(video.url);
      latestTranscript = transcript;
      latestGenerationProgress = { completedChunks: 0, totalChunks: segmentCount };
      latestGenerationStatus = 'running';
      latestGenerationStartedAt = new Date().toISOString();
      latestGenerationError = '';
      latestGenerationModels = [];
      latestVisualAnalysis = false;
      latestVisualAnalysisMode = 'transcript-only-or-incomplete';
      latestMarkdown = `# ${preservedTitle}\n\n> 正在生成笔记，请稍候…`;
      renderFrameGallery([]);
      if (!fromOpenedNote || workspace.activeView !== 'note') workspace.noteReturnView = 'create';
    } else {
      latestGenerationStatus = 'running';
      latestGenerationStartedAt = new Date().toISOString();
      latestGenerationError = '';
      if (workspace.activeView !== 'note') workspace.noteReturnView = 'create';
    }
    if (!previousNoteSnapshot) await persistCurrentNote(false);
    renderNoteOutput(latestMarkdown, latestVideo);
    renderExportActions();
    workspace.hasMarkdown = true;
    workspace.resultVisible = true;
    setWorkspaceView('note');

    let accumulatedMarkdown = isResume ? latestModelMarkdown : '';
    const settingsResult = await callBackground('GET_SETTINGS');
    const rawConcurrency = Math.max(1, Math.min(4, Math.floor(Number(settingsResult?.settings?.generationConcurrency) || 2)));
    const generationConcurrency = useDirectAudio ? Math.min(2, rawConcurrency) : rawConcurrency;
    const generationBatches = Keji.generationBatches(segmentCount, generationConcurrency, resumeFrom);
    for (const batchIndexes of generationBatches) {
      if (generationCancelled) throw Object.assign(new Error('已停止生成。'), { cancelled: true });
      const nextChunk = batchIndexes[0]!;
      const batchSize = batchIndexes.length;
      workspace.generationStageText = batchSize > 1
        ? `正在并行整理第 ${nextChunk + 1}–${nextChunk + batchSize}/${segmentCount} 段…`
        : (useDirectAudio ? `正在提交第 ${nextChunk + 1}/${segmentCount} 段音轨由模型直接理解…` : `正在整理第 ${nextChunk + 1}/${segmentCount} 段…`);
      const batchResult = await Keji.runGenerationBatch<{ ok?: boolean; error?: string; markdown?: string; model?: string }>(
        batchIndexes,
        accumulatedMarkdown,
        (index, partialMarkdown) => callBackground('GENERATE_NOTE', {
          payload: {
            video,
            transcript,
            ...(useDirectAudio ? { audioChunk: { ...audioChunks[index]!, total: segmentCount } } : {}),
            template: latestTemplate,
            customPrompt: latestCustomPrompt,
            singleChunk: true,
            returnChunkOnly: true,
            resumeFrom: index,
            partialMarkdown,
            generationTaskId: activeGenerationTaskId
          }
        }),
        (prevMarkdown, chunkMarkdown) => mergeMarkdownSections([prevMarkdown, chunkMarkdown]),
        async ({ markdown, committed, value }) => {
          accumulatedMarkdown = markdown;
          if (value?.model && !latestGenerationModels.includes(value.model)) latestGenerationModels.push(value.model);
          const completedThrough = nextChunk + committed;
          workspace.generationProgress = { completedChunks: completedThrough, totalChunks: segmentCount };
          latestModelMarkdown = accumulatedMarkdown;
          latestGenerationProgress = { completedChunks: completedThrough, totalChunks: segmentCount };
          latestMarkdown = formatNoteMarkdown(latestNoteTitle || video.title || '课程笔记', video, accumulatedMarkdown);
          renderNoteOutput();
          renderExportActions();
          workspace.resultVisible = true;
          workspace.generationStageText = `已完成并保存第 ${completedThrough}/${segmentCount} 段。`;
          await persistCurrentNote(false);
        }
      );
      accumulatedMarkdown = batchResult.markdown;
      const failureOffset = batchResult.failureOffset;
      const completedThrough = nextChunk + batchResult.committed;
      workspace.generationProgress = { completedChunks: completedThrough, totalChunks: segmentCount };
      const failedReason = (failureOffset >= 0 ? batchResult.results[failureOffset] : null) as { reason?: Error & { cancelled?: boolean } } | null;
      if (generationCancelled || failedReason?.reason?.cancelled) {
        latestModelMarkdown = accumulatedMarkdown;
        latestGenerationProgress = { completedChunks: completedThrough, totalChunks: segmentCount };
        if (accumulatedMarkdown) {
          latestMarkdown = formatNoteMarkdown(latestNoteTitle || video.title || '课程笔记', video, accumulatedMarkdown);
        }
        throw Object.assign(new Error('已停止生成。'), { cancelled: true });
      }
      if (failureOffset >= 0 && !accumulatedMarkdown) {
        throw failedReason?.reason || new Error('模型请求失败。');
      }
      latestModelMarkdown = accumulatedMarkdown;
      latestGenerationProgress = { completedChunks: completedThrough, totalChunks: segmentCount };
      latestMarkdown = formatNoteMarkdown(latestNoteTitle || video.title || '课程笔记', video, accumulatedMarkdown);
      renderNoteOutput();
      renderExportActions();
      workspace.resultVisible = true;
      await persistCurrentNote(false);
      if (failureOffset >= 0) {
        const detail = failedReason?.reason?.message || '模型请求失败。';
        latestGenerationStatus = 'failed';
        latestGenerationError = detail;
        await persistCurrentNote(false);
        void refreshCourseNotesMap();
        workspace.generationStageText = '';
        workspace.generationError = `第 ${completedThrough + 1}/${segmentCount} 段失败：${detail}`;
        showNotice(workspace.generationError, 'error');
        return;
      }
    }

    if (generationCancelled) throw Object.assign(new Error('已停止生成。'), { cancelled: true });

    latestGenerationStatus = 'completed';
    workspace.generationProgress = { completedChunks: segmentCount, totalChunks: segmentCount };
    latestGenerationError = '';
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
    const canAnalyzeVideo = sameOpenVideo || Boolean(cachedVideo?.file);
    const visualResult = canAnalyzeVideo
      ? await runVisualAnalysisPipeline({
        video,
        transcript,
        initialBodyMarkdown: latestModelMarkdown,
        settings: settingsResult?.settings,
        cachedVideo,
        sameOpenVideo,
        tabId: resolvedTabId,
        generationTaskId: activeGenerationTaskId,
        signal: activeCaptureAbortController.signal,
        isCancelled: () => generationCancelled,
        fallbackFrames: [],
        revertToInitialOnFullVideoCaptureError: true,
        throwOnFrameEnrichError: false
      })
      : {
        bodyMarkdown: latestModelMarkdown,
        frames: [] as KeyFrameItem[],
        captureFailed: false,
        visualAnalysis: false,
        visualAnalysisMode: 'transcript-only-or-incomplete',
        visualError: ''
      };

    latestVisualAnalysis = visualResult.visualAnalysis;
    latestVisualAnalysisMode = visualResult.visualAnalysisMode;
    latestFrames = visualResult.frames;
    const finalTitle = latestNoteTitle || video.title || '课程笔记';
    latestMarkdown = formatNoteMarkdown(finalTitle, video, visualResult.bodyMarkdown);
    latestNoteTitle = finalTitle;
    workspace.noteTitle = finalTitle;
    latestVideo = { ...video };
    latestGenerationError = visualResult.visualError || '';
    renderNoteOutput();
    renderFrameGallery(latestFrames);
    fc.pruneActiveNoteFlashcardReview(latestMarkdown);
    qz.pruneActiveNoteQuizOnRegenerate(latestMarkdown, latestTemplate);
    renderExportActions();
    workspace.resultVisible = true;
    await persistCurrentNote(latestVisualAnalysis || !visualResult.visualError);
    void refreshCourseNotesMap();
    void refreshCurrentLessonCacheStatus(video, latestNoteId);
    void refreshCacheOverview();
    workspace.generationStageText = '';
    if (visualResult.visualError) {
      workspace.generationError = `文字稿笔记已保存，画面分析未完成：${visualResult.visualError}`;
      showNotice('笔记已保存（画面分析未完成）。', 'error');
    } else {
      workspace.generationError = '';
      showNotice(latestFrames.length
        ? `笔记已生成并保存，已嵌入 ${latestFrames.length} 张关键帧。`
        : '学习笔记已生成并保存。', 'success');
    }
  } catch (error) {
    const err = error as Error & { cancelled?: boolean };
    const wasCancelled = generationCancelled || err?.cancelled || err?.name === 'AbortError';
    if (!latestModelMarkdown.trim() && previousNoteSnapshot) {
      await openSavedNote(previousNoteSnapshot, { scroll: false, returnView: workspace.noteReturnView });
      showNotice(
        wasCancelled
          ? '已取消重新生成，原笔记已保留。'
          : `重新生成失败（${err.message || '模型请求失败'}），原笔记未受影响。`,
        wasCancelled ? 'info' : 'error'
      );
    } else if (wasCancelled) {
      if (!latestModelMarkdown.trim()) {
        if (latestNoteId) {
          await callBackground('DELETE_NOTE', { id: latestNoteId }).catch(() => {});
          latestNoteId = null;
        }
        clearActiveNoteState();
        setWorkspaceView('create');
        showNotice('已停止生成。', 'info');
      } else {
        latestGenerationStatus = 'failed';
        latestGenerationError = '已手动停止生成，已完成分段已保留。';
        await persistCurrentNote(false).catch(() => {});
        void refreshCourseNotesMap();
        workspace.generationStageText = '';
        workspace.generationError = latestGenerationError;
        showNotice('已停止生成，已完成分段已保留。', 'info');
      }
    } else {
      if (latestGenerationStatus === 'running') {
        latestGenerationStatus = 'failed';
        latestGenerationError = err.message || '模型请求失败。';
        await persistCurrentNote(false).catch(() => {});
        void refreshCourseNotesMap();
      }
      workspace.generationStageText = '';
      workspace.generationError = err.message || '模型请求失败。';
      showNotice(workspace.generationError, 'error');
      if (!latestModelMarkdown.trim()) {
        latestMarkdown = `# ${video.title || '课程笔记'}\n\n> 生成失败：${err.message || '模型请求失败。'}`;
        renderNoteOutput();
        workspace.hasMarkdown = true;
        workspace.resultVisible = true;
        renderExportActions();
      }
    }
  } finally {
    if (useDirectAudio) void callBackground('RELEASE_LESSON_AUDIO').catch(() => {});
    workspace.generating = false;
    activeGenerationTaskId = '';
    activeCaptureAbortController = null;
    workspace.canGenerate = computeCanGenerate();
    if (elements.resumeGeneration) {
      elements.resumeGeneration.disabled = false;
      elements.resumeGeneration.textContent = '继续生成剩余分段';
    }
    if (elements.retryVisualAnalysis) elements.retryVisualAnalysis.disabled = false;
    syncCurrentPartNote();
    renderExportActions();
  }
}

export async function copyMarkdown(): Promise<void> {
  if (!latestMarkdown) return;
  try {
    await navigator.clipboard.writeText(latestMarkdown);
    showNotice('Markdown 已复制。', 'success');
  } catch {
    showNotice('复制失败，请选中预览内容后复制。', 'error');
  }
}

async function renderRecentNotes(): Promise<void> {
  const result = await callBackground('LIST_NOTES');
  if (!result?.ok) throw new Error(result?.error || '读取本机笔记失败。');
  savedNotes = (result?.notes || []) as NoteSummary[];
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
  const modelFilter = workspace.notesModelFilter;
  const statusFilter = workspace.notesStatusFilter;
  filteredSavedNotes = ((response.notes || []) as NoteSummary[]).filter((note) => {
    if (modelFilter && !noteModels(note).includes(modelFilter)) return false;
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
  workspace.noteCountLabel = savedNotes.length ? `${filtered.length}/${savedNotes.length}` : '0 篇';
  workspace.moreNotes = filtered.length > visibleNotesLimit;
  const rows = filtered.slice(0, visibleNotesLimit).map((note) => {
    const courseBvid = Keji.bvidFromUrl(note.url);
    const coverUrl = safeCoverUrl(note.cover);
    const date = note.updatedAt || note.createdAt;
    const models = noteModels(note);
    const originalVideoUrl = safeBilibiliVideoUrl(note.url);
    const status = statusLabels[savedNoteStatus(note)] || '已保存';
    const dateLabel = formatShortDate(date);
    return {
      note,
      coverUrl,
      title: `${note.title || '未命名视频'}${note.part ? ` · ${note.part}` : ''}`,
      partLabel: note.part ? `${note.page ? `P${note.page} · ` : ''}${note.part}` : (note.page ? `第 ${note.page} 节` : note.title || '未命名视频'),
      meta: [status, models.length ? models.join('、') : '模型未记录', note.page ? `第 ${note.page} 节` : '', dateLabel].filter(Boolean).join(' · '),
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
    if (bucket && bucket.length >= 2) {
      if (emittedCourses.has(row.courseBvid)) continue;
      emittedCourses.add(row.courseBvid);
      const sortedRows = [...bucket].sort((a, b) => (Number(a.note.page) || Number.MAX_SAFE_INTEGER) - (Number(b.note.page) || Number.MAX_SAFE_INTEGER) || b.updatedAtMs - a.updatedAtMs);
      const latestRow = bucket.reduce((best, item) => item.updatedAtMs > best.updatedAtMs ? item : best, bucket[0]!);
      groups.push({
        type: 'course',
        key: `course:${row.courseBvid}`,
        bvid: row.courseBvid,
        title: latestRow.note.title || row.courseBvid,
        coverUrl: latestRow.coverUrl,
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

function renderRemoteNotesSyncStatus(enabled: boolean, state: { status?: string; lastSyncedAt?: number; noteCount?: number; error?: string } = {}): void {
  if (!workspace.remoteBackupConfigured) {
    workspace.remoteBackupStatusText = '';
    return;
  }
  if (!enabled) {
    workspace.remoteBackupStatusText = '自动同步未开启；可在“远程同步”菜单手动同步。';
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

export function startInlineRename(note: NoteSummary): void {
  workspace.renamingNoteId = note.id;
  workspace.renamingTitle = note.title || '未命名视频';
}

export function cancelInlineRename(): void {
  workspace.renamingNoteId = null;
  workspace.renamingTitle = '';
}

export async function commitInlineRename(note: NoteSummary): Promise<void> {
  const normalized = workspace.renamingTitle.trim();
  if (!normalized) return showNotice('笔记名称不能为空。', 'error');
  if (normalized === (note.title || '')) return cancelInlineRename();
  try {
    const result = await callBackground('UPDATE_NOTE', { note: { id: note.id, title: normalized } });
    if (!result?.ok) throw new Error(result?.error || '改名失败。');
    savedNotes = savedNotes.map((item) => item.id === note.id ? result.note : item);
    if (latestNoteId === note.id) {
      latestNoteTitle = normalized;
      workspace.noteTitle = normalized;
      renderExportActions();
    }
    cancelInlineRename();
    await filterSavedNotes();
    void refreshCourseNotesMap(savedNotes);
    showNotice('笔记已改名。', 'success');
  } catch (error) {
    showNotice((error as Error).message || '改名失败。', 'error');
  }
}

export async function deleteSavedNote(note: NoteSummary): Promise<void> {
  if (latestNoteId === note.id && !confirmDiscardMarkdownEdits()) return;
  const label = `${note.title || '未命名视频'}${note.part ? ` · ${note.part}` : ''}`;
  if (!window.confirm(`删除“${label}”？此操作会从本机笔记库移除笔记、文字稿和讨论记录。`)) return;
  try {
    const result = await callBackground('DELETE_NOTE', { id: note.id });
    if (!result?.ok) throw new Error(result?.error || '删除失败。');
    savedNotes = savedNotes.filter((item) => item.id !== note.id);
    if (latestNoteId === note.id) latestNoteId = null;
    if (workspace.renamingNoteId === note.id) cancelInlineRename();
    await filterSavedNotes();
    void refreshCourseNotesMap(savedNotes);
    void refreshCacheOverview();
    void fc.refreshDueFlashcardCount();
    showNotice('笔记已删除。', 'success');
  } catch (error) {
    showNotice((error as Error).message || '删除失败。', 'error');
  }
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
  workspace.noteReturnView = returnView || (
    workspace.activeView === 'home' ? 'home'
      : workspace.activeView === 'create' ? 'create'
        : 'library'
  );
  markdownEditing = false;
  markdownEditOriginal = '';
  markdownEditMode = 'preview';
  workspace.markdownDraft = '';
  workspace.hasUnsavedMarkdown = false;
  latestMarkdown = String(note.markdown || '');
  latestNoteTitle = note.title || '课程笔记';
  workspace.noteTitle = latestNoteTitle;
  latestVideo = {
    bvid: Keji.bvidFromUrl(note.url),
    title: note.title,
    url: note.url,
    part: note.part,
    page: note.page,
    pageCount: Number(note.pageCount) || Number(note.markdown?.match(/第\s*\d+\/(\d+)\s*节/)?.[1]) || Math.max(1, Number(note.page) || 1),
    duration: note.duration,
    cover: note.cover || ''
  };
  workspace.noteVideoUrl = safeBilibiliVideoUrl(note.url);
  latestTemplate = isNoteStructureId(note.template) ? note.template : 'study';
  workspace.selectedTemplate = latestTemplate;
  latestCustomPrompt = String(note.customPrompt || '');
  workspace.customPrompt = latestCustomPrompt;
  latestNoteId = note.id || null;
  latestGenerationModels = noteModels(note);
  latestTranscript = String(note.transcript || '');
  const cachedFallback = !latestTranscript && latestVideo.bvid
    ? await getCachedTranscription(latestVideo).catch(() => null)
    : null;
  if (!latestTranscript && cachedFallback?.text?.trim()) {
    latestTranscript = cachedFallback.text;
  }
  tx.setSavedNoteTranscriptionState({
    transcriptSegments: note.transcriptSegments,
    detectedLanguages: note.detectedLanguages,
    cachedFallback,
  });
  latestModelMarkdown = String(note.modelMarkdown || '');
  const progress = note.generationProgress;
  const savedTotalChunks = Number(progress?.totalChunks);
  const totalChunks = latestTranscript.trim()
    ? Keji.splitTranscript(latestTranscript).length
    : (Number.isInteger(savedTotalChunks) && savedTotalChunks > 0 ? savedTotalChunks : 0);
  const completedChunks = Number(progress?.completedChunks);
  latestGenerationProgress = progress
    && Number(progress.totalChunks) === totalChunks
    && Number.isInteger(completedChunks)
    && completedChunks > 0
    && completedChunks < totalChunks
    && latestModelMarkdown.trim()
    ? { completedChunks, totalChunks }
    : null;
  latestGenerationStatus = note.generationStatus || '';
  latestGenerationStartedAt = note.generationStartedAt || '';
  latestGenerationError = note.generationError || '';
  workspace.generationStageText = '';
  workspace.generationError = (latestGenerationStatus === 'failed' && latestGenerationError) ? latestGenerationError : '';
  workspace.transcript = latestTranscript;
  updateCharacterCount();
  disc.setDiscussionItems(Array.isArray(note.conversation) ? note.conversation : []);
  fc.setActiveNoteFlashcardReview(Array.isArray(note.flashcardReview) ? note.flashcardReview : []);
  fc.closeFlashcardSessionQuietly();
  qz.setActiveNoteQuizRecord(note.quizState);
  qz.closeQuizPanelQuietly();
  latestVisualAnalysis = Boolean(note.visualAnalysis);
  latestVisualAnalysisMode = note.visualAnalysisMode || (note.visualAnalysis ? 'keyframes' : 'transcript-only-or-incomplete');
  latestFrames = framesFromMarkdown(latestMarkdown);
  renderNoteOutput();
  renderFrameGallery(latestFrames);
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
    workspace.currentLessonHasCachedVideo = false;
    workspace.currentLessonHasCachedMuxedVideo = false;
    workspace.currentLessonMediaSizes = { audio: 0, video: 0, audiovisual: 0 };
    workspace.currentLessonCacheBytes = 0;
    workspace.currentLessonCacheLabel = '';
    return null;
  }
  const result = await callBackground('GET_LESSON_CACHE_STATUS', { lessonKey, noteId: noteId || '' }).catch(() => null);
  if (!result?.ok || !result.status) return null;
  const activeKey = Keji.lessonKey(workspace.activeView === 'note' ? (latestVideo || currentVideo) : (currentVideo || latestVideo));
  if (lessonKey && activeKey && lessonKey !== activeKey) return result.status;
  workspace.currentLessonHasCachedAudio = Boolean(result.status.hasAudio);
  workspace.currentLessonHasCachedVideo = Boolean(result.status.hasVideo);
  workspace.currentLessonHasCachedMuxedVideo = Boolean(result.status.hasMuxedVideo);
  workspace.currentLessonMediaSizes = {
    audio: Number(result.status.audioBytes) || 0,
    video: Number(result.status.videoBytes) || 0,
    audiovisual: Number(result.status.muxedVideoBytes) || 0
  };
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

export async function prepareCurrentLessonMedia(): Promise<void> {
  if (workspace.currentLessonMediaBusy || workspace.generating) return;
  const target = activeMediaTarget();
  if (!target) { showNotice('请先载入一个 B 站视频。', 'error'); return; }
  workspace.currentLessonMediaBusy = true;
  try {
    const cid = Number(target.cid) || 0;
    const [cachedAudio, cachedVideo, cachedCombined] = await Promise.all([
      getCachedAudio(target, { expectedCid: cid }),
      getCachedVideo(target, { expectedCid: cid }),
      getCachedMuxedVideo(target, { expectedCid: cid })
    ]);
    if (!cachedAudio || !cachedVideo) {
      workspace.currentLessonMediaStatus = '正在请求 B 站媒体访问权限…';
      const granted = await chrome.permissions.request({ permissions: ['offscreen'], origins: BILIBILI_CDN_ORIGINS });
      if (!granted) throw new Error('需要音频处理和 B 站 CDN 权限才能缓存媒体文件。');
    }
    if (!cachedAudio) {
      workspace.currentLessonMediaStatus = '正在下载音轨…';
      const response = await callBackground('CACHE_LESSON_AUDIO', { tabId: currentTabId, lesson: target });
      if (!response?.ok) throw new Error(response?.error || '下载音轨失败。');
      await refreshCurrentLessonCacheStatus(target, workspace.activeView === 'note' ? latestNoteId : null);
    }
    if (!cachedVideo) {
      workspace.currentLessonMediaStatus = '正在读取视频轨…';
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
          workspace.currentLessonMediaStatus = `正在下载纯画面：${formatBytes(loaded)}${total ? ` / ${formatBytes(total)}` : ''}`;
        }
      });
      await refreshCurrentLessonCacheStatus(target, workspace.activeView === 'note' ? latestNoteId : null);
    }
    if (!cachedCombined) {
      workspace.currentLessonMediaStatus = '正在封装带声音的视频…';
      await putCachedMuxedVideo(target, {
        expectedCid: cid,
        onProgress: (fraction) => {
          workspace.currentLessonMediaStatus = `正在封装带声音的视频：${Math.round(fraction * 100)}%`;
        }
      });
    }
    await Promise.all([refreshCurrentLessonCacheStatus(target, workspace.activeView === 'note' ? latestNoteId : null), refreshCacheOverview()]);
    workspace.currentLessonMediaStatus = '三种文件已缓存，可分别下载。';
    showNotice('三种媒体文件已保存到浏览器本地缓存。', 'success');
  } catch (error) {
    workspace.currentLessonMediaStatus = (error as Error).message || '准备媒体文件失败。';
    showNotice(workspace.currentLessonMediaStatus, 'error');
  } finally {
    workspace.currentLessonMediaBusy = false;
  }
}

export async function downloadCurrentLessonMedia(kind: 'audio' | 'video' | 'audiovisual'): Promise<void> {
  const target = activeMediaTarget();
  if (!target) return;
  const cid = Number(target.cid) || 0;
  const cached = kind === 'audio' ? await getCachedAudio(target, { expectedCid: cid })
    : kind === 'video' ? await getCachedVideo(target, { expectedCid: cid })
    : await getCachedMuxedVideo(target, { expectedCid: cid });
  if (!cached) { showNotice('该文件尚未缓存，请先准备媒体文件。', 'error'); return; }
  const bvid = target.bvid || Keji.bvidFromUrl(target.url);
  const name = `${bvid}_p${Number(target.page) || 1}.${kind === 'audio' ? 'audio.m4a' : kind === 'video' ? 'video.mp4' : 'audiovisual.mp4'}`;
  downloadBlob(name, cached.file);
}

function clearActiveNoteProcessState(clearCurrentAudioFlag = false): void {
  latestTranscript = '';
  latestModelMarkdown = '';
  latestGenerationProgress = null;
  tx.clearTranscriptProcessMetadata();
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
  if (!window.confirm(`清理本节课的过程缓存${sizeHint}？缓存的音轨、原视频流与转写过程稿将被删除，已生成的笔记正文、截图、闪卡/自测记录与互动会话会完整保留。`)) {
    return;
  }
  workspace.clearingCache = true;
  try {
    tx.clearPendingTranscriptCacheTimer();
    const result = await callBackground('CLEAR_LESSON_CACHE', { lessonKey, noteId: latestNoteId || '' });
    if (!result?.ok) throw new Error(result?.error || '清理本节缓存失败。');

    clearActiveNoteProcessState(Boolean(currentVideo && (!lessonKey || Keji.lessonKey(currentVideo) === lessonKey)));
    renderExportActions();
    await Promise.all([refreshCurrentLessonCacheStatus(target, latestNoteId), refreshCacheOverview()]);
    const freed = Number(result.freedBytes) || 0;
    showNotice(freed ? `已清理本节过程缓存（释放 ${formatBytes(freed)}），笔记结果已保留。` : '已清理本节过程缓存。', 'success');
  } catch (error) {
    showNotice((error as Error).message || '清理本节缓存失败。', 'error');
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
  if (!totalBytes) return showNotice('当前没有可清理的过程文件缓存。', 'info');
  if (!window.confirm(`清理全部课程的过程文件缓存（共 ${formatBytes(totalBytes)}）？所有缓存的音轨、原视频流与转写结果将被删除，已保存的笔记正文、截图、闪卡/自测记录与互动会话均会完整保留。`)) {
    return;
  }
  workspace.clearingCache = true;
  try {
    tx.clearPendingTranscriptCacheTimer();
    const result = await callBackground('CLEAR_ALL_CACHES');
    if (!result?.ok) throw new Error(result?.error || '清理过程缓存失败。');

    clearActiveNoteProcessState(true);
    renderExportActions();
    await refreshCacheOverview();
    if (workspace.activeView === 'library') await renderRecentNotes().catch(() => {});
    const freed = Number(result.freedBytes) || 0;
    showNotice(freed ? `已清理全部过程缓存（释放 ${formatBytes(freed)}），笔记结果均已保留。` : '已清理全部过程缓存。', 'success');
  } catch (error) {
    showNotice((error as Error).message || '清理过程缓存失败。', 'error');
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
      workspace.showResultActions = false;
      workspace.showDiscussion = false;
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
      latestModelMarkdown = '';
      latestGenerationProgress = null;
    },
    onCacheUpdated: (target) => void refreshCurrentLessonCacheStatus(target, latestNoteId),
  });

  disc.configureDiscussionHost({
    getContext: () => ({
      noteId: latestNoteId,
      markdown: latestMarkdown,
      transcript: latestTranscript,
      videoUrl: workspace.noteVideoUrl || latestVideo?.url || '',
      frames: latestFrames,
    }),
    async resolveTranscript() {
      if (latestTranscript) return latestTranscript;
      if (!latestVideo) return '';
      const cached = await getCachedTranscription(latestVideo).catch(() => null);
      return cached?.text?.trim() || '';
    },
    async applyNoteRevision(revisedMarkdown) {
      const previousMarkdown = latestMarkdown;
      latestMarkdown = revisedMarkdown;
      try {
        await persistCurrentNote(latestVisualAnalysis);
      } catch (error) {
        latestMarkdown = previousMarkdown;
        throw error;
      }
      renderNoteOutput();
      renderFrameGallery(latestFrames);
      renderExportActions();
    },
    async saveConversationOnly(conversation: ConversationItem[]) {
      if (!latestNoteId) return;
      const result = await callBackground('UPDATE_NOTE', { note: { id: latestNoteId, conversation } });
      if (!result?.ok) throw new Error(result?.error || '保存互动记录失败。');
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
    setWorkspaceView(location.hash.slice(1) || 'home', { record: false });
    workspace.videoTitle = '还没有连接到 B 站视频';
    workspace.videoMeta = '粘贴 B 站视频链接后载入课程。';
    workspace.captionStatus = '载入视频后，课记会读取当前分 P 的字幕。';
    workspace.courseTitle = '等待载入视频';
    workspace.hasCaptions = false;
  }
}
