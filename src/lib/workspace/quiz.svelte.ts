import { Keji, type KeyFrameItem } from '../keji.ts';
import { getNoteStructure } from '../note-structures.ts';
import {
  buildQuizVideoUrl,
  parseQuizQuestions,
  retainMatchingQuizState,
  scoreQuizQuestions,
  type QuizQuestion,
  type QuizRecordState,
} from '../quiz.ts';
import { callBackground, showNotice } from './ui.ts';

interface ActiveQuizContext {
  noteId: string | null;
  title: string;
  markdown: string;
  transcript: string;
  frames: KeyFrameItem[];
  template: string;
  videoUrl: string;
  editing: boolean;
}

export const quizState = $state({
  generating: false,
  saving: false,
  hasQuestions: false,
  canGenerate: false,
  wrongOnly: false,
  progressLabel: '',
  tabBadge: '',
  hasWrong: false,
  questions: [] as QuizQuestion[],
  answers: {} as Record<string, string>,
});

const activeContext: ActiveQuizContext = {
  noteId: null,
  title: '',
  markdown: '',
  transcript: '',
  frames: [],
  template: 'study',
  videoUrl: '',
  editing: false,
};

let allQuestions: QuizQuestion[] = [];
let activeRecord: QuizRecordState | undefined;
let wrongFilterIds: Set<string> | null = null;
let generatingQuizNoteId: string | null = null;

function quizContextKey(noteId: string | null): string {
  return noteId ?? '__unsaved__';
}

function refreshQuizViewState(): void {
  if (activeContext.editing) {
    quizState.generating = false;
    quizState.hasQuestions = false;
    quizState.canGenerate = false;
    quizState.questions = [];
    quizState.tabBadge = '';
    return;
  }
  quizState.generating = Boolean(
    generatingQuizNoteId && generatingQuizNoteId === quizContextKey(activeContext.noteId)
  );
  const isTemplateQuiz = Boolean(getNoteStructure(activeContext.template).supportsQuiz);
  const quizMarkdown = activeRecord?.generatedMarkdown || (isTemplateQuiz ? activeContext.markdown : '');
  allQuestions = quizMarkdown ? parseQuizQuestions(quizMarkdown) : [];
  const answers = { ...(activeRecord?.answers || {}) };
  const score = scoreQuizQuestions(allQuestions, answers);

  quizState.canGenerate = Boolean(activeContext.markdown.trim() || activeContext.transcript.trim());
  quizState.hasQuestions = allQuestions.length > 0;
  quizState.answers = answers;
  quizState.wrongOnly = Boolean(wrongFilterIds);
  quizState.questions = wrongFilterIds
    ? allQuestions.filter((q) => wrongFilterIds!.has(q.id))
    : allQuestions;
  quizState.hasWrong = score.wrongIds.length > 0;
  quizState.tabBadge = allQuestions.length
    ? (score.answered ? `${score.correct}/${score.total}` : `${score.total} 题`)
    : '';
  quizState.progressLabel = allQuestions.length
    ? (score.answered
      ? `已作答 ${score.answered}/${score.total} 题 · 正确 ${score.correct} 题${score.wrongIds.length ? ` · 错题 ${score.wrongIds.length} 题` : ''}`
      : `共 ${score.total} 道单选题，点击选项即可即时判分与查看解析`)
    : '围绕本节重点生成 5 到 8 道理解检测题';
}

async function persistQuizRecordForNote(
  noteId: string | null,
  record: QuizRecordState
): Promise<QuizRecordState | undefined> {
  if (!noteId) return undefined;
  quizState.saving = true;
  try {
    const result = await callBackground('UPDATE_NOTE_QUIZ', {
      id: noteId,
      quizState: record
    });
    if (!result?.ok) throw new Error(result?.error || '无法保存自测进度。');
    return result.quizState;
  } finally {
    quizState.saving = false;
  }
}

export function getActiveQuizCopyMarkdown(): string {
  if (!allQuestions.length) return '';
  const isTemplateQuiz = Boolean(getNoteStructure(activeContext.template).supportsQuiz);
  return activeRecord?.generatedMarkdown || (isTemplateQuiz ? activeContext.markdown : '');
}

export function setActiveNoteQuizRecord(record?: QuizRecordState): void {
  activeRecord = record
    ? {
      answers: { ...(record.answers || {}) },
      ...(record.generatedMarkdown ? { generatedMarkdown: record.generatedMarkdown } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {})
    }
    : undefined;
  wrongFilterIds = null;
}

export function getActiveNoteQuizRecord(): QuizRecordState | undefined {
  return activeRecord
    ? {
      answers: { ...(activeRecord.answers || {}) },
      ...(activeRecord.generatedMarkdown ? { generatedMarkdown: activeRecord.generatedMarkdown } : {}),
      ...(activeRecord.updatedAt ? { updatedAt: activeRecord.updatedAt } : {})
    }
    : undefined;
}

export function pruneActiveNoteQuizOnRegenerate(markdown: string, template: string): void {
  activeRecord = retainMatchingQuizState(markdown, activeRecord, template);
  wrongFilterIds = null;
  refreshQuizViewState();
}

export function syncActiveNoteQuiz(context: ActiveQuizContext): void {
  activeContext.noteId = context.noteId;
  activeContext.title = context.title;
  activeContext.markdown = context.markdown;
  activeContext.transcript = context.transcript;
  activeContext.frames = [...context.frames];
  activeContext.template = context.template;
  activeContext.videoUrl = context.videoUrl;
  activeContext.editing = context.editing;
  if (context.editing) wrongFilterIds = null;
  refreshQuizViewState();
}

export async function generateQuizForActiveNote(): Promise<void> {
  if ((!activeContext.markdown.trim() && !activeContext.transcript.trim()) || generatingQuizNoteId) return;
  const targetNoteId = activeContext.noteId;
  const targetKey = quizContextKey(targetNoteId);
  generatingQuizNoteId = targetKey;
  refreshQuizViewState();
  showNotice('正在生成本节随堂自测题…', 'info');
  try {
    const result = await callBackground('GENERATE_NOTE_QUIZ', {
      payload: {
        title: activeContext.title,
        markdown: activeContext.markdown,
        transcript: activeContext.transcript,
        frames: activeContext.frames.slice(0, 6)
      }
    });
    if (!result?.ok) throw new Error(result?.error || '生成随堂自测失败。');
    const nextRecord: QuizRecordState = {
      generatedMarkdown: result.result.markdown,
      answers: {},
      updatedAt: new Date().toISOString()
    };
    const saved = targetNoteId ? await persistQuizRecordForNote(targetNoteId, nextRecord) : undefined;
    if (activeContext.noteId === targetNoteId) {
      activeRecord = saved || nextRecord;
      wrongFilterIds = null;
      refreshQuizViewState();
      showNotice(`已生成 ${result.result.count} 道随堂自测题。`, 'success');
    } else {
      showNotice(`原笔记的 ${result.result.count} 道随堂自测已在后台保存。`, 'success');
    }
  } catch (error) {
    showNotice((error as Error).message || '生成随堂自测失败。', 'error');
  } finally {
    if (generatingQuizNoteId === targetKey) generatingQuizNoteId = null;
    refreshQuizViewState();
  }
}

export async function selectQuizOption(questionId: string, optionKey: string): Promise<void> {
  if (!questionId || !optionKey || quizState.saving || quizState.answers[questionId]) return;
  const targetNoteId = activeContext.noteId;
  const previousRecord = getActiveNoteQuizRecord();
  const nextAnswers = { ...(activeRecord?.answers || {}), [questionId]: optionKey.toUpperCase() };
  const nextRecord: QuizRecordState = {
    ...(activeRecord?.generatedMarkdown ? { generatedMarkdown: activeRecord.generatedMarkdown } : {}),
    answers: nextAnswers,
    updatedAt: new Date().toISOString()
  };
  activeRecord = nextRecord;
  refreshQuizViewState();
  if (!targetNoteId) return;
  try {
    const saved = await persistQuizRecordForNote(targetNoteId, nextRecord);
    if (saved && activeContext.noteId === targetNoteId) activeRecord = saved;
  } catch (error) {
    if (activeContext.noteId === targetNoteId) {
      activeRecord = previousRecord;
      refreshQuizViewState();
    }
    showNotice((error as Error).message || '保存自测作答失败。', 'error');
  }
}

export async function retryWrongQuizQuestions(): Promise<void> {
  const score = scoreQuizQuestions(allQuestions, activeRecord?.answers || {});
  if (!score.wrongIds.length || quizState.saving) return;
  const targetNoteId = activeContext.noteId;
  const previousRecord = getActiveNoteQuizRecord();
  const nextAnswers = { ...(activeRecord?.answers || {}) };
  for (const id of score.wrongIds) delete nextAnswers[id];
  wrongFilterIds = new Set(score.wrongIds);
  const nextRecord: QuizRecordState = {
    ...(activeRecord?.generatedMarkdown ? { generatedMarkdown: activeRecord.generatedMarkdown } : {}),
    answers: nextAnswers,
    updatedAt: new Date().toISOString()
  };
  activeRecord = nextRecord;
  refreshQuizViewState();
  if (!targetNoteId) return;
  try {
    const saved = await persistQuizRecordForNote(targetNoteId, nextRecord);
    if (saved && activeContext.noteId === targetNoteId) activeRecord = saved;
  } catch (error) {
    if (activeContext.noteId === targetNoteId) {
      activeRecord = previousRecord;
      wrongFilterIds = null;
      refreshQuizViewState();
    }
    showNotice((error as Error).message || '重置错题失败。', 'error');
  }
}

export async function resetAllQuizAnswers(): Promise<void> {
  if (quizState.saving) return;
  const targetNoteId = activeContext.noteId;
  const previousRecord = getActiveNoteQuizRecord();
  wrongFilterIds = null;
  const nextRecord: QuizRecordState = {
    ...(activeRecord?.generatedMarkdown ? { generatedMarkdown: activeRecord.generatedMarkdown } : {}),
    answers: {},
    updatedAt: new Date().toISOString()
  };
  activeRecord = nextRecord;
  refreshQuizViewState();
  if (!targetNoteId) return;
  try {
    const saved = await persistQuizRecordForNote(targetNoteId, nextRecord);
    if (saved && activeContext.noteId === targetNoteId) activeRecord = saved;
  } catch (error) {
    if (activeContext.noteId === targetNoteId) {
      activeRecord = previousRecord;
      refreshQuizViewState();
    }
    showNotice((error as Error).message || '清空自测记录失败。', 'error');
  }
}

export function videoLinkForQuizTimestamp(timestamp: string): string {
  return buildQuizVideoUrl(timestamp, activeContext.videoUrl, Keji.parseTime(timestamp));
}
