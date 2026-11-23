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
  visible: false,
  generating: false,
  saving: false,
  showButton: false,
  buttonLabel: '随堂自测',
  hasQuestions: false,
  isTemplateQuiz: false,
  wrongOnly: false,
  progressLabel: '',
  hasWrong: false,
  questions: [] as QuizQuestion[],
  answers: {} as Record<string, string>,
  focusTrigger: 0,
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

function refreshQuizViewState(): void {
  if (activeContext.editing || !activeContext.markdown) {
    quizState.showButton = false;
    quizState.visible = false;
    return;
  }
  const isTemplateQuiz = Boolean(getNoteStructure(activeContext.template).supportsQuiz);
  const quizMarkdown = isTemplateQuiz ? activeContext.markdown : (activeRecord?.generatedMarkdown || '');
  allQuestions = quizMarkdown ? parseQuizQuestions(quizMarkdown) : [];
  const answers = { ...(activeRecord?.answers || {}) };
  const score = scoreQuizQuestions(allQuestions, answers);

  quizState.showButton = true;
  quizState.isTemplateQuiz = isTemplateQuiz;
  quizState.hasQuestions = allQuestions.length > 0;
  quizState.answers = answers;
  quizState.wrongOnly = Boolean(wrongFilterIds);
  quizState.questions = wrongFilterIds
    ? allQuestions.filter((q) => wrongFilterIds!.has(q.id))
    : allQuestions;
  quizState.hasWrong = score.wrongIds.length > 0;
  quizState.buttonLabel = allQuestions.length
    ? (score.answered ? `随堂自测 · ${score.correct}/${score.total}` : `随堂自测 · ${score.total} 题`)
    : '生成随堂自测';
  quizState.progressLabel = allQuestions.length
    ? (score.answered
      ? `已作答 ${score.answered}/${score.total} 题 · 正确 ${score.correct} 题${score.wrongIds.length ? ` · 错题 ${score.wrongIds.length} 题` : ''}`
      : `共 ${score.total} 道单选题，点击选项即可即时判分与查看解析`)
    : '围绕本节重点生成 5 到 8 道理解检测题';
}

async function persistActiveQuizRecord(): Promise<void> {
  if (!activeContext.noteId || !activeRecord) return;
  quizState.saving = true;
  try {
    const result = await callBackground('UPDATE_NOTE_QUIZ', {
      id: activeContext.noteId,
      quizState: activeRecord
    });
    if (!result?.ok) throw new Error(result?.error || '无法保存自测进度。');
    if (result.quizState) activeRecord = result.quizState;
  } finally {
    quizState.saving = false;
  }
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

export function closeQuizPanelQuietly(): void {
  quizState.visible = false;
  wrongFilterIds = null;
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
  if (context.editing) closeQuizPanelQuietly();
  refreshQuizViewState();
}

export function toggleOrOpenQuiz(): void {
  if (quizState.visible) {
    closeQuizPanel();
    return;
  }
  if (allQuestions.length) {
    wrongFilterIds = null;
    refreshQuizViewState();
    quizState.visible = true;
    quizState.focusTrigger += 1;
    return;
  }
  void generateQuizForActiveNote();
}

export async function generateQuizForActiveNote(): Promise<void> {
  if (!activeContext.markdown || quizState.generating) return;
  quizState.generating = true;
  showNotice('正在结合本节笔记生成随堂自测题…', 'info');
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
    activeRecord = {
      generatedMarkdown: result.result.markdown,
      answers: {},
      updatedAt: new Date().toISOString()
    };
    wrongFilterIds = null;
    if (activeContext.noteId) await persistActiveQuizRecord();
    refreshQuizViewState();
    quizState.visible = true;
    quizState.focusTrigger += 1;
    showNotice(`已生成 ${result.result.count} 道随堂自测题。`, 'success');
  } catch (error) {
    showNotice((error as Error).message || '生成随堂自测失败。', 'error');
  } finally {
    quizState.generating = false;
  }
}

export async function selectQuizOption(questionId: string, optionKey: string): Promise<void> {
  if (!questionId || !optionKey || quizState.saving || quizState.answers[questionId]) return;
  const previousRecord = getActiveNoteQuizRecord();
  const nextAnswers = { ...(activeRecord?.answers || {}), [questionId]: optionKey.toUpperCase() };
  activeRecord = {
    ...(activeRecord?.generatedMarkdown ? { generatedMarkdown: activeRecord.generatedMarkdown } : {}),
    answers: nextAnswers,
    updatedAt: new Date().toISOString()
  };
  refreshQuizViewState();
  if (!activeContext.noteId) return;
  try {
    await persistActiveQuizRecord();
  } catch (error) {
    activeRecord = previousRecord;
    refreshQuizViewState();
    showNotice((error as Error).message || '保存自测作答失败。', 'error');
  }
}

export async function retryWrongQuizQuestions(): Promise<void> {
  const score = scoreQuizQuestions(allQuestions, activeRecord?.answers || {});
  if (!score.wrongIds.length || quizState.saving) return;
  const previousRecord = getActiveNoteQuizRecord();
  const nextAnswers = { ...(activeRecord?.answers || {}) };
  for (const id of score.wrongIds) delete nextAnswers[id];
  wrongFilterIds = new Set(score.wrongIds);
  activeRecord = {
    ...(activeRecord?.generatedMarkdown ? { generatedMarkdown: activeRecord.generatedMarkdown } : {}),
    answers: nextAnswers,
    updatedAt: new Date().toISOString()
  };
  refreshQuizViewState();
  quizState.focusTrigger += 1;
  if (!activeContext.noteId) return;
  try {
    await persistActiveQuizRecord();
  } catch (error) {
    activeRecord = previousRecord;
    wrongFilterIds = null;
    refreshQuizViewState();
    showNotice((error as Error).message || '重置错题失败。', 'error');
  }
}

export async function resetAllQuizAnswers(): Promise<void> {
  if (quizState.saving) return;
  const previousRecord = getActiveNoteQuizRecord();
  wrongFilterIds = null;
  activeRecord = {
    ...(activeRecord?.generatedMarkdown ? { generatedMarkdown: activeRecord.generatedMarkdown } : {}),
    answers: {},
    updatedAt: new Date().toISOString()
  };
  refreshQuizViewState();
  if (!activeContext.noteId) return;
  try {
    await persistActiveQuizRecord();
  } catch (error) {
    activeRecord = previousRecord;
    refreshQuizViewState();
    showNotice((error as Error).message || '清空自测记录失败。', 'error');
  }
}

export function closeQuizPanel(): void {
  closeQuizPanelQuietly();
}

export function videoLinkForQuizTimestamp(timestamp: string): string {
  return buildQuizVideoUrl(timestamp, activeContext.videoUrl, Keji.parseTime(timestamp));
}
