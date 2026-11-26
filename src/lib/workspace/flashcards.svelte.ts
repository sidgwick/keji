import { safeFilename } from '../bundle-zip.ts';
import {
  buildFlashcardVideoUrl,
  computeNextReviewState,
  formatAnkiTsv,
  formatFlashcardInterval,
  getDueFlashcards,
  getFlashcardReviewState,
  mergeFlashcardReviewState,
  nextFlashcardInterval,
  parseFlashcards,
  retainMatchingFlashcardReviews,
  type FlashcardGrade,
  type FlashcardItem,
  type FlashcardReviewState,
} from '../flashcards.ts';
import { Keji, type KeyFrameItem } from '../keji.ts';
import { callBackground, downloadText, showNotice } from './ui.ts';

interface FlashcardSession {
  allCards: FlashcardItem[];
  queue: FlashcardItem[];
  cursor: number;
  missed: FlashcardItem[];
  retryCounts: Map<string, number>;
  reviewed: number;
  crossNote: boolean;
  sourceMarkdown: string;
}

interface FlashcardHostHooks {
  enterCrossNoteReviewView: () => void;
  exitCrossNoteReviewView: () => void;
}

interface ActiveNoteContext {
  noteId: string | null;
  title: string;
  markdown: string;
  transcript: string;
  frames: KeyFrameItem[];
  template: string;
  videoUrl: string;
  editing: boolean;
  reviewStates: FlashcardReviewState[];
  flashcardMarkdown: string;
}

export const flashcardState = $state({
  showAnkiExport: false,
  hasCards: false,
  canGenerate: false,
  generating: false,
  tabBadge: '',
  dueCount: 0,
  loadingDue: false,
  dueButtonLabel: '复习到期闪卡',
  dueButtonTitle: '复习笔记库中所有已到期的闪卡',
  crossNote: false,
  cardVisible: true,
  finished: false,
  answerRevealed: false,
  ratingsVisible: false,
  saving: false,
  front: '',
  back: '',
  progress: '',
  finishedCopy: '',
  hasMissed: false,
  sourceUrl: '',
  sourceLabel: '',
  hardInterval: '1 天',
  goodInterval: '1 天',
});

const activeNote: ActiveNoteContext = {
  noteId: null,
  title: '',
  markdown: '',
  transcript: '',
  frames: [],
  template: 'study',
  videoUrl: '',
  editing: false,
  reviewStates: [],
  flashcardMarkdown: '',
};

let session: FlashcardSession | null = null;
let generatingCardsNoteId: string | null = null;
let host: FlashcardHostHooks = {
  enterCrossNoteReviewView: () => {},
  exitCrossNoteReviewView: () => {},
};

function flashcardContextKey(noteId: string | null): string {
  return noteId ?? '__unsaved__';
}

function sessionKeyFor(card: FlashcardItem): string {
  return `${card.noteId || activeNote.noteId || ''}:${card.id}`;
}

function activeCardSourceMarkdown(): string {
  if (activeNote.flashcardMarkdown) return activeNote.flashcardMarkdown;
  return activeNote.markdown;
}

export function getActiveFlashcardCopyMarkdown(): string {
  const source = activeCardSourceMarkdown();
  return parseFlashcards(source).length ? source : '';
}

function updateNoteButtonVisibility(): void {
  if (activeNote.editing) {
    flashcardState.generating = false;
    flashcardState.showAnkiExport = false;
    flashcardState.hasCards = false;
    flashcardState.canGenerate = false;
    flashcardState.tabBadge = '';
    return;
  }
  flashcardState.generating = Boolean(
    generatingCardsNoteId && generatingCardsNoteId === flashcardContextKey(activeNote.noteId)
  );
  const cards = parseFlashcards(activeCardSourceMarkdown());
  flashcardState.canGenerate = Boolean(activeNote.markdown.trim() || activeNote.transcript.trim());
  flashcardState.hasCards = cards.length > 0;
  flashcardState.showAnkiExport = cards.length > 0;
  if (cards.length) {
    const dueCount = getDueFlashcards(cards, activeNote.reviewStates, Date.now()).length;
    flashcardState.tabBadge = dueCount ? `${dueCount} 待复习` : `${cards.length} 张`;
  } else {
    flashcardState.tabBadge = '';
  }
}

function setDueCount(count: number): void {
  const dueCount = Math.max(0, Number(count) || 0);
  flashcardState.dueCount = dueCount;
  flashcardState.dueButtonLabel = `复习到期闪卡 · ${dueCount}`;
  flashcardState.dueButtonTitle = dueCount
    ? `笔记库中有 ${dueCount} 张已到期闪卡`
    : '笔记库中目前没有到期闪卡';
}

function renderCurrentCard(): void {
  if (!session) return;
  const card = session.queue[session.cursor];
  if (!card) {
    flashcardState.cardVisible = false;
    flashcardState.finished = true;
    flashcardState.progress = `本轮完成 · 已复习 ${session.reviewed} 张`;
    flashcardState.finishedCopy = session.missed.length
      ? `有 ${session.missed.length} 张标记为「重来」，建议再巩固一遍。复习记录已保存在本机。`
      : '这轮全部完成。复习记录已保存在本机。';
    flashcardState.hasMissed = Boolean(session.missed.length);
    if (session.crossNote) void refreshDueFlashcardCount();
    return;
  }
  flashcardState.cardVisible = true;
  flashcardState.finished = false;
  flashcardState.front = card.front;
  flashcardState.back = card.back;
  flashcardState.answerRevealed = false;
  flashcardState.ratingsVisible = false;
  flashcardState.hasMissed = false;
  flashcardState.progress = `${card.noteTitle ? `${card.noteTitle} · ` : ''}第 ${session.cursor + 1} / ${session.queue.length} 张`;
  const sourceUrl = buildFlashcardVideoUrl(card, activeNote.videoUrl, Keji.parseTime(card.timestamp));
  flashcardState.sourceUrl = sourceUrl;
  flashcardState.sourceLabel = sourceUrl ? `回看视频 · ${card.timestamp}` : '';
  const state = getFlashcardReviewState(card, activeNote.reviewStates);
  flashcardState.hardInterval = formatFlashcardInterval(nextFlashcardInterval('hard', state));
  flashcardState.goodInterval = formatFlashcardInterval(nextFlashcardInterval('good', state));
}

function exportCardsToAnki(cards: FlashcardItem[], title: string, addCourseTag: boolean): void {
  const safeTitle = safeFilename(title, '课程闪卡');
  const tsv = formatAnkiTsv(cards, { addCourseTag });
  downloadText(`${safeTitle}-anki.tsv`, tsv, 'text/tab-separated-values;charset=utf-8');
  showNotice(`已导出 ${cards.length} 张 Anki 闪卡（.tsv）。`, 'success');
}

export function configureFlashcardHost(hooks: FlashcardHostHooks): void {
  host = hooks;
}

export function setActiveNoteFlashcardData(review: FlashcardReviewState[] = [], flashcardMarkdown = ''): void {
  activeNote.reviewStates = Array.isArray(review) ? [...review] : [];
  activeNote.flashcardMarkdown = String(flashcardMarkdown || '');
}

export function getActiveNoteFlashcardReview(): FlashcardReviewState[] {
  return [...activeNote.reviewStates];
}

export function getActiveNoteFlashcardMarkdown(): string {
  return activeNote.flashcardMarkdown;
}

export function pruneActiveNoteFlashcardReview(markdown: string): void {
  activeNote.reviewStates = retainMatchingFlashcardReviews(markdown, activeNote.reviewStates);
  updateNoteButtonVisibility();
}

export function closeFlashcardSessionQuietly(): void {
  session = null;
  flashcardState.crossNote = false;
  flashcardState.finished = false;
  flashcardState.answerRevealed = false;
  flashcardState.ratingsVisible = false;
}

export function syncActiveNoteFlashcards(context: Omit<ActiveNoteContext, 'reviewStates' | 'flashcardMarkdown'>): void {
  activeNote.noteId = context.noteId;
  activeNote.title = context.title;
  activeNote.markdown = context.markdown;
  activeNote.transcript = context.transcript;
  activeNote.frames = [...context.frames];
  activeNote.template = context.template;
  activeNote.videoUrl = context.videoUrl;
  activeNote.editing = context.editing;
  if (context.editing) closeFlashcardSessionQuietly();
  updateNoteButtonVisibility();
  if (!context.editing && flashcardState.hasCards && (!session || (!session.crossNote && session.sourceMarkdown !== activeCardSourceMarkdown()))) {
    startFlashcardReviewSession();
  }
}

export async function refreshDueFlashcardCount(): Promise<void> {
  const result = await callBackground('GET_DUE_FLASHCARDS').catch(() => null);
  if (result?.ok) setDueCount(result.cards?.length || 0);
}

function startFlashcardReviewSession(cards: FlashcardItem[] | null = null): void {
  const crossNoteSeed = Boolean(cards?.some((card) => Boolean(card.noteId)));
  const sourceMarkdown = crossNoteSeed ? '' : activeCardSourceMarkdown();
  const allNoteCards = parseFlashcards(activeCardSourceMarkdown());
  const dueCards = getDueFlashcards(allNoteCards, activeNote.reviewStates);
  const queue = cards || (dueCards.length ? dueCards : allNoteCards);
  if (!queue.length) return;
  const crossNote = queue.some((card) => Boolean(card.noteId));
  session = {
    allCards: [...queue],
    queue: [...queue],
    cursor: 0,
    missed: [],
    retryCounts: new Map(),
    reviewed: 0,
    crossNote,
    sourceMarkdown,
  };
  flashcardState.crossNote = crossNote;
  renderCurrentCard();
}

export async function generateFlashcardsForActiveNote(): Promise<void> {
  if ((!activeNote.markdown.trim() && !activeNote.transcript.trim()) || generatingCardsNoteId) return;
  const targetNoteId = activeNote.noteId;
  const targetKey = flashcardContextKey(targetNoteId);
  generatingCardsNoteId = targetKey;
  updateNoteButtonVisibility();
  showNotice('正在提炼本节记忆闪卡…', 'info');
  try {
    const result = await callBackground('GENERATE_NOTE_FLASHCARDS', {
      payload: {
        title: activeNote.title,
        markdown: activeNote.markdown,
        transcript: activeNote.transcript,
        frames: activeNote.frames.slice(0, 6),
      },
    });
    if (!result?.ok) throw new Error(result?.error || '生成记忆闪卡失败。');
    const generatedMd = String(result.result.markdown || '');
    if (targetNoteId) {
      await callBackground('UPDATE_NOTE_FLASHCARDS', {
        id: targetNoteId,
        flashcardMarkdown: generatedMd,
        flashcardReview: [],
      });
    }
    if (activeNote.noteId === targetNoteId) {
      activeNote.flashcardMarkdown = generatedMd;
      activeNote.reviewStates = [];
      updateNoteButtonVisibility();
      startFlashcardReviewSession();
      showNotice(`已生成 ${result.result.count} 张记忆闪卡。`, 'success');
    } else {
      showNotice(`原笔记的 ${result.result.count} 张记忆闪卡已在后台保存。`, 'success');
    }
  } catch (error) {
    showNotice((error as Error).message || '生成记忆闪卡失败。', 'error');
  } finally {
    if (generatingCardsNoteId === targetKey) generatingCardsNoteId = null;
    updateNoteButtonVisibility();
  }
}

export function closeFlashcardReview(): void {
  const wasCrossNote = Boolean(session?.crossNote);
  closeFlashcardSessionQuietly();
  if (wasCrossNote) host.exitCrossNoteReviewView();
}

export function revealFlashcard(): void {
  flashcardState.answerRevealed = true;
  flashcardState.ratingsVisible = true;
}

export function retryMissedFlashcards(): void {
  startFlashcardReviewSession(session?.missed || []);
}

export function restartFlashcards(): void {
  startFlashcardReviewSession(session?.allCards || parseFlashcards(activeCardSourceMarkdown()));
}

export function handleFlashcardKeydown(event: KeyboardEvent, activeTabIsFlashcards = false): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (!flashcardState.crossNote && !activeTabIsFlashcards) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
  if (event.key === 'Escape' && flashcardState.crossNote) closeFlashcardReview();
  else if (event.code === 'Space' && flashcardState.hasCards && !flashcardState.answerRevealed && !flashcardState.finished) {
    event.preventDefault();
    revealFlashcard();
  } else if (!flashcardState.ratingsVisible) return;
  else if (event.key === '1') void gradeFlashcard('again');
  else if (event.key === '2') void gradeFlashcard('hard');
  else if (event.key === '3') void gradeFlashcard('good');
}

export async function gradeFlashcard(grade: FlashcardGrade): Promise<void> {
  const currentSession = session;
  const card = currentSession?.queue[currentSession.cursor];
  if (!currentSession || !card || flashcardState.saving) return;
  const noteId = card.noteId || activeNote.noteId;
  if (!noteId) {
    showNotice('请先保存笔记，再保存闪卡复习进度。', 'error');
    return;
  }

  const previousReview = activeNote.reviewStates;
  const oldState = getFlashcardReviewState(card, activeNote.reviewStates);
  const nextState = computeNextReviewState(card.id, grade, oldState);
  if (noteId === activeNote.noteId) {
    activeNote.reviewStates = mergeFlashcardReviewState(previousReview, nextState);
  }
  flashcardState.saving = true;
  try {
    const result = await callBackground('UPDATE_FLASHCARD_REVIEW_ITEM', { id: noteId, state: nextState });
    if (!result?.ok) throw new Error(result?.error || '无法保存闪卡复习进度。');
    if (noteId === activeNote.noteId && Array.isArray(result.review)) {
      activeNote.reviewStates = result.review;
    }
    card.reviewState = nextState;
  } catch (error) {
    if (noteId === activeNote.noteId) activeNote.reviewStates = previousReview;
    showNotice((error as Error).message || '无法保存闪卡复习进度。', 'error');
    return;
  } finally {
    flashcardState.saving = false;
  }

  currentSession.reviewed += 1;
  if (grade === 'again') {
    const key = sessionKeyFor(card);
    if (!currentSession.missed.some((item) => sessionKeyFor(item) === key)) {
      currentSession.missed.push(card);
    }
    const retries = currentSession.retryCounts.get(key) || 0;
    if (retries < 1) {
      currentSession.retryCounts.set(key, retries + 1);
      currentSession.queue.push(card);
    }
  }
  currentSession.cursor += 1;
  renderCurrentCard();
  updateNoteButtonVisibility();
}

export async function startDueFlashcardReview(): Promise<void> {
  if (flashcardState.loadingDue) return;
  flashcardState.loadingDue = true;
  try {
    const result = await callBackground('GET_DUE_FLASHCARDS');
    if (!result?.ok) throw new Error(result?.error || '读取到期闪卡失败。');
    if (!result.cards?.length) {
      setDueCount(0);
      showNotice('笔记库中目前没有到期闪卡。', 'info');
      return;
    }
    host.enterCrossNoteReviewView();
    startFlashcardReviewSession(result.cards);
  } catch (error) {
    showNotice((error as Error).message || '读取到期闪卡失败。', 'error');
  } finally {
    flashcardState.loadingDue = false;
  }
}

export function exportAnkiTsv(): void {
  const cards = parseFlashcards(activeCardSourceMarkdown());
  if (!cards.length) {
    showNotice('没有找到闪卡表格，请重新生成或检查笔记格式。', 'error');
    return;
  }
  exportCardsToAnki(cards, activeNote.title || '课程闪卡', false);
}

export async function exportAllFlashcardsToAnki(): Promise<void> {
  try {
    const result = await callBackground('GET_ALL_FLASHCARDS');
    if (!result?.ok) throw new Error(result?.error || '读取笔记库闪卡失败。');
    if (!result.cards?.length) {
      showNotice('笔记库中还没有可导出的闪卡。', 'info');
      return;
    }
    exportCardsToAnki(result.cards, '课记-全部课程闪卡', true);
  } catch (error) {
    showNotice((error as Error).message || '导出全部闪卡失败。', 'error');
  }
}
