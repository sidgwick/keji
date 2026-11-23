import type {
  ApiProtocol,
  CacheOverview,
  CaptionTrack,
  GenerationProgress,
  KeyFrameItem,
  ModelCapability,
  NoteSummary,
  TemplateId,
  VideoPart,
  VideoTarget,
} from '../keji.ts';

interface NoteRowItem {
  note: NoteSummary;
  coverUrl: string;
  title: string;
  partLabel: string;
  meta: string;
  error: string;
  originalVideoUrl: string;
  courseBvid: string;
  updatedAtMs: number;
  updatedLabel: string;
}

type NoteGroupItem =
  | { type: 'course'; key: string; bvid: string; title: string; coverUrl: string; updatedLabel: string; rows: NoteRowItem[] }
  | { type: 'single'; key: string; row: NoteRowItem };

interface DashboardNoteRow {
  note: NoteSummary;
  coverUrl: string;
  title: string;
  meta: string;
  error: string;
  excerpt: string;
}

export type WorkspaceView = 'home' | 'create' | 'library' | 'note' | 'settings';
export type ReturnView = 'home' | 'create' | 'library';
export type MarkdownMode = 'preview' | 'edit';
export type LibraryViewMode = 'grouped' | 'flat';

interface WorkspaceState {
  activeView: WorkspaceView;
  settingsGroup: string;
  modelConfigured: boolean;
  currentModelLabel: string;
  apiProtocol: ApiProtocol;
  modelCapability: ModelCapability;
  currentVideo: VideoTarget | null;
  editingVideoUrl: boolean;
  courseDrawerOpen: boolean;
  partSearch: string;
  currentPartNote: NoteSummary | null;
  currentPartNoteMeta: string;
  sameCourseLoaded: boolean;
  canRegenerateNote: boolean;
  courseNotesByPage: Record<number, NoteSummary>;
  videoTitle: string;
  videoMeta: string;
  videoUrl: string;
  captionStatus: string;
  captionLanguage: string;
  captionTracks: CaptionTrack[];
  selectedCaptionTrack: string;
  hasCaptions: boolean;
  frames: KeyFrameItem[];
  courseTitle: string;
  parts: VideoPart[];
  currentPage: number;
  loadingVideo: boolean;
  canReloadCaptions: boolean;
  notesSearch: string;
  notesStatusFilter: string;
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
  dashboardRows: DashboardNoteRow[];
  dashboardError: string;
  hasMarkdown: boolean;
  resultVisible: boolean;
  markdownEditing: boolean;
  markdownMode: MarkdownMode;
  markdownDraft: string;
  hasUnsavedMarkdown: boolean;
  markdownSaving: boolean;
  noteTitle: string;
  canEditTitle: boolean;
  titleSaving: boolean;
  noteReturnView: ReturnView;
  noteVideoUrl: string;
  showResultActions: boolean;
  showDiscussion: boolean;
  selectedTemplate: TemplateId;
  customPrompt: string;
  transcript: string;
  transcriptExpanded: boolean;
  characterCount: number;
  canGenerate: boolean;
  generating: boolean;
  generateLabel: string;
  generationStageText: string;
  generationError: string;
  generationProgress: GenerationProgress;
  currentLessonHasCachedAudio: boolean;
  currentLessonCacheBytes: number;
  currentLessonCacheLabel: string;
  totalCacheBytes: number;
  totalCacheLabel: string;
  cacheOverview: CacheOverview;
  clearingCache: boolean;
  notice: { message: string; kind: 'info' | 'success' | 'error' };
  canResumeGeneration: boolean;
  showRetryVisualAnalysis: boolean;
}

export const workspace = $state<WorkspaceState>({
  activeView: 'home',
  settingsGroup: 'connection',
  modelConfigured: true,
  currentModelLabel: '',
  apiProtocol: 'openai',
  modelCapability: 'text',
  currentVideo: null,
  editingVideoUrl: false,
  courseDrawerOpen: false,
  partSearch: '',
  currentPartNote: null,
  currentPartNoteMeta: '',
  sameCourseLoaded: false,
  canRegenerateNote: false,
  courseNotesByPage: {},
  videoTitle: '正在读取 B 站页面…',
  videoMeta: '',
  videoUrl: '',
  captionStatus: '正在检查当前分 P 字幕…',
  captionLanguage: '',
  captionTracks: [],
  selectedCaptionTrack: '',
  hasCaptions: false,
  frames: [],
  courseTitle: '等待载入视频',
  parts: [],
  currentPage: 1,
  loadingVideo: false,
  canReloadCaptions: false,
  notesSearch: '',
  notesStatusFilter: '',
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
  dashboardRows: [],
  dashboardError: '',
  hasMarkdown: false,
  resultVisible: false,
  markdownEditing: false,
  markdownMode: 'preview',
  markdownDraft: '',
  hasUnsavedMarkdown: false,
  markdownSaving: false,
  noteTitle: '',
  canEditTitle: false,
  titleSaving: false,
  noteReturnView: 'library',
  noteVideoUrl: '',
  showResultActions: true,
  showDiscussion: true,
  selectedTemplate: 'study',
  customPrompt: '',
  transcript: '',
  transcriptExpanded: false,
  characterCount: 0,
  canGenerate: false,
  generating: false,
  generateLabel: '生成学习笔记',
  generationStageText: '',
  generationError: '',
  generationProgress: { completedChunks: 0, totalChunks: 0 },
  currentLessonHasCachedAudio: false,
  currentLessonCacheBytes: 0,
  currentLessonCacheLabel: '',
  totalCacheBytes: 0,
  totalCacheLabel: '',
  cacheOverview: {
    audioBytes: 0,
    videoBytes: 0,
    transcriptBytes: 0,
    noteIntermediateBytes: 0,
    totalBytes: 0,
    lessonCount: 0,
  },
  clearingCache: false,
  notice: { message: '', kind: 'info' },
  canResumeGeneration: false,
  showRetryVisualAnalysis: false,
});
