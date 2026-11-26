import type {
  CacheOverview,
  CaptionTrack,
  GenerationProgress,
  ModelCapability,
  ModelPreset,
  NoteSummary,
  ReviewMark,
  TemplateId,
  VideoPart,
  VideoTarget,
} from '../keji.ts';
import type { NoteViewKey } from '../note-structures.ts';

interface NoteRowItem {
  note: NoteSummary;
  coverUrl: string;
  title: string;
  partLabel: string;
  compactMeta: string;
  meta: string;
  reviewMark: ReviewMark;
  hasPersonalNote: boolean;
  summaryPreview: string;
  badges: string[];
  modelTooltip: string;
  statusText: string;
  statusTone: 'completed' | 'processing' | 'failed' | 'incomplete';
  canExport: boolean;
  error: string;
  originalVideoUrl: string;
  courseBvid: string;
  updatedAtMs: number;
  updatedLabel: string;
}

type NoteGroupItem =
  | { type: 'course'; key: string; bvid: string; title: string; coverUrl: string; progressLabel: string; updatedLabel: string; rows: NoteRowItem[] }
  | { type: 'single'; key: string; row: NoteRowItem };

export type WorkspaceView = 'create' | 'library' | 'note' | 'settings';
export type ReturnView = 'create' | 'library';
export type NoteTab = NoteViewKey | 'quiz' | 'flashcards';
export type MarkdownMode = 'preview' | 'edit';
export type LibraryViewMode = 'grouped' | 'flat';

interface WorkspaceState {
  activeView: WorkspaceView;
  noteTab: NoteTab;
  assistantOpen: boolean;
  settingsGroup: string;
  modelConfigured: boolean;
  currentModelLabel: string;
  modelCapability: ModelCapability;
  modelPresets: ModelPreset[];
  activePresetId: string;
  currentVideo: VideoTarget | null;
  openBilibiliTabs: Array<{ tabId: number; title: string; url: string; bvid: string }>;
  recentNotes: Array<{ note: NoteSummary; coverUrl: string; title: string; meta: string }>;
  editingVideoUrl: boolean;
  courseDrawerOpen: boolean;
  partSearch: string;
  currentPartNote: NoteSummary | null;
  currentPartNoteMeta: string;
  sameCourseLoaded: boolean;
  canRegenerateActiveTab: boolean;
  canCopyCurrentTab: boolean;
  copyButtonLabel: string;
  canExportBundle: boolean;
  generatedViews: Record<NoteViewKey, boolean>;
  generatingView: TemplateId | '';
  failedView: TemplateId | '';
  courseNotesByPage: Record<number, NoteSummary>;
  videoTitle: string;
  videoMeta: string;
  videoUrl: string;
  captionStatus: string;
  captionLanguage: string;
  captionTracks: CaptionTrack[];
  selectedCaptionTrack: string;
  hasCaptions: boolean;
  courseTitle: string;
  parts: VideoPart[];
  currentPage: number;
  loadingVideo: boolean;
  canReloadCaptions: boolean;
  notesSearch: string;
  notesStatusFilter: string;
  notesReviewFilter: ReviewMark;
  notesModelFilter: string;
  availableNoteModels: string[];
  libraryViewMode: LibraryViewMode;
  noteRows: NoteRowItem[];
  noteGroups: NoteGroupItem[];
  noteCountLabel: string;
  moreNotes: boolean;
  remoteBackupConfigured: boolean;
  remoteBackupStatusText: string;
  renamingNoteId: string | null;
  renamingTitle: string;
  dashboardStats: Array<{ value: string; label: string }>;
  hasMarkdown: boolean;
  resultVisible: boolean;
  markdownEditing: boolean;
  markdownMode: MarkdownMode;
  markdownDraft: string;
  hasUnsavedMarkdown: boolean;
  markdownSaving: boolean;
  noteTitle: string;
  noteEpisodeLabel: string;
  noteCourseLabel: string;
  reviewMark: ReviewMark;
  personalNote: string;
  personalNoteOpen: boolean;
  personalNoteSaving: boolean;
  canEditTitle: boolean;
  titleSaving: boolean;
  noteReturnView: ReturnView;
  noteVideoUrl: string;
  selectedTemplate: TemplateId;
  customPrompt: string;
  transcript: string;
  transcriptExpanded: boolean;
  characterCount: number;
  canGenerate: boolean;
  generating: boolean;
  activeNoteGenerating: boolean;
  backgroundGeneratingTitle: string;
  generateLabel: string;
  generationStageText: string;
  generationError: string;
  generationProgress: GenerationProgress;
  currentLessonHasCachedAudio: boolean;
  currentLessonMediaBusy: boolean;
  currentLessonCacheBytes: number;
  currentLessonCacheLabel: string;
  totalCacheBytes: number;
  totalCacheLabel: string;
  cacheOverview: CacheOverview;
  clearingCache: boolean;
  notice: { message: string; kind: 'info' | 'success' | 'error'; actionLabel: string };
  canResumeGeneration: boolean;
  showRetryVisualAnalysis: boolean;
}

export const workspace = $state<WorkspaceState>({
  activeView: 'create',
  noteTab: 'study',
  assistantOpen: false,
  settingsGroup: 'connection',
  modelConfigured: true,
  currentModelLabel: '',
  modelCapability: 'text',
  modelPresets: [],
  activePresetId: '',
  currentVideo: null,
  openBilibiliTabs: [],
  recentNotes: [],
  editingVideoUrl: false,
  courseDrawerOpen: false,
  partSearch: '',
  currentPartNote: null,
  currentPartNoteMeta: '',
  sameCourseLoaded: false,
  canRegenerateActiveTab: false,
  canCopyCurrentTab: false,
  copyButtonLabel: '复制笔记',
  canExportBundle: false,
  generatedViews: { study: false, brief: false, tutorial: false, timeline: false, custom: false },
  generatingView: '',
  failedView: '',
  courseNotesByPage: {},
  videoTitle: '正在读取 B 站页面…',
  videoMeta: '',
  videoUrl: '',
  captionStatus: '正在检查本节字幕…',
  captionLanguage: '',
  captionTracks: [],
  selectedCaptionTrack: '',
  hasCaptions: false,
  courseTitle: '等待载入视频',
  parts: [],
  currentPage: 1,
  loadingVideo: false,
  canReloadCaptions: false,
  notesSearch: '',
  notesStatusFilter: '',
  notesReviewFilter: '',
  notesModelFilter: '',
  availableNoteModels: [],
  libraryViewMode: 'grouped',
  noteRows: [],
  noteGroups: [],
  noteCountLabel: '0 篇',
  moreNotes: false,
  remoteBackupConfigured: false,
  remoteBackupStatusText: '',
  renamingNoteId: null,
  renamingTitle: '',
  dashboardStats: [],
  hasMarkdown: false,
  resultVisible: false,
  markdownEditing: false,
  markdownMode: 'preview',
  markdownDraft: '',
  hasUnsavedMarkdown: false,
  markdownSaving: false,
  noteTitle: '',
  noteEpisodeLabel: '',
  noteCourseLabel: '',
  reviewMark: '',
  personalNote: '',
  personalNoteOpen: false,
  personalNoteSaving: false,
  canEditTitle: false,
  titleSaving: false,
  noteReturnView: 'library',
  noteVideoUrl: '',
  selectedTemplate: 'study',
  customPrompt: '',
  transcript: '',
  transcriptExpanded: false,
  characterCount: 0,
  canGenerate: false,
  generating: false,
  activeNoteGenerating: false,
  backgroundGeneratingTitle: '',
  generateLabel: '生成学习笔记',
  generationStageText: '',
  generationError: '',
  generationProgress: { completedChunks: 0, totalChunks: 0 },
  currentLessonHasCachedAudio: false,
  currentLessonMediaBusy: false,
  currentLessonCacheBytes: 0,
  currentLessonCacheLabel: '',
  totalCacheBytes: 0,
  totalCacheLabel: '',
  cacheOverview: {
    audioBytes: 0,
    videoBytes: 0,
    muxedVideoBytes: 0,
    transcriptBytes: 0,
    noteIntermediateBytes: 0,
    totalBytes: 0,
    lessonCount: 0,
  },
  clearingCache: false,
  notice: { message: '', kind: 'info', actionLabel: '' },
  canResumeGeneration: false,
  showRetryVisualAnalysis: false,
});
