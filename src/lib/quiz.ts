import { getNoteStructure } from "./note-structures.ts";

interface QuizOption {
  key: string;
  text: string;
}

export interface QuizQuestion {
  id: string;
  question: string;
  options: QuizOption[];
  answer: string;
  explanation: string;
  timestamp: string;
}

export interface QuizRecordState {
  generatedMarkdown?: string;
  answers: Record<string, string>;
  updatedAt?: string;
}

interface DraftQuestion {
  questionLines: string[];
  options: QuizOption[];
  answer: string;
  explanationLines: string[];
}

function quizIdFor(question: string, options: QuizOption[]): string {
  const source = `${question}\u0000${options.map((opt) => `${opt.key}:${opt.text}`).join("\u0001")}`;
  let left = 2166136261;
  let right = 2246822519;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ (code + index), 3266489917);
  }
  return `qz-${(left >>> 0).toString(36)}-${(right >>> 0).toString(36)}`;
}

function cleanQuizText(value: string): string {
  return String(value || "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseQuizQuestions(markdown: string): QuizQuestion[] {
  const lines = String(markdown || "").split(/\r?\n/);
  const questions: QuizQuestion[] = [];
  const seenIds = new Set<string>();
  let fence: string | null = null;
  let current: DraftQuestion | null = null;
  let readingExplanation = false;

  const finalize = () => {
    if (!current) return;
    const rawQuestion = cleanQuizText(current.questionLines.join(" "));
    const explanation = cleanQuizText(current.explanationLines.join(" "));
    const timestamp = rawQuestion.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/)?.[1]
      || explanation.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/)?.[1]
      || "";
    const question = rawQuestion.replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/g, " ").replace(/\s+/g, " ").trim();
    const answer = current.answer.toUpperCase();
    const valid = Boolean(
      question
      && current.options.length >= 2
      && answer
      && current.options.some((opt) => opt.key === answer)
    );
    if (valid) {
      const id = quizIdFor(question, current.options);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        questions.push({
          id,
          question,
          options: current.options,
          answer,
          explanation: explanation.replace(/\s*\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/g, " ").replace(/\s+/g, " ").trim(),
          timestamp,
        });
      }
    }
    current = null;
    readingExplanation = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence) continue;

    const headingMatch = line.match(/^#{1,6}\s+(?:(?:Q|第)?\s*\d+\s*[题.、:：)\]]?\s*)?(.+)$/i);
    const plainQuestionMatch = !headingMatch
      ? line.match(/^(?:\*\*)?Q\s*\d+\s*[.、:：)\]]\s*(.+?)(?:\*\*)?$/i)
      : null;
    if (headingMatch || plainQuestionMatch) {
      finalize();
      current = {
        questionLines: [(headingMatch?.[1] || plainQuestionMatch?.[1] || "").trim()],
        options: [],
        answer: "",
        explanationLines: [],
      };
      readingExplanation = false;
      continue;
    }
    if (!current) continue;
    if (!line) {
      readingExplanation = false;
      continue;
    }

    const optionMatch = line.match(/^(?:[-*+]\s+)?(?:\*\*)?\(?([A-D])\)?[.)、:：](?:\*\*)?\s*(.+)$/i);
    if (optionMatch) {
      readingExplanation = false;
      const key = optionMatch[1]!.toUpperCase();
      if (!current.options.some((opt) => opt.key === key)) {
        current.options.push({ key, text: cleanQuizText(optionMatch[2]!) });
      }
      continue;
    }

    const answerMatch = line.match(/^(?:>\s*)?(?:\*\*)?(?:正确)?(?:答案|Answer)(?:\*\*)?\s*[：:]\s*(?:\*\*)?(?:选项\s*)?([A-D])\b/i);
    if (answerMatch) {
      readingExplanation = false;
      current.answer = answerMatch[1]!.toUpperCase();
      continue;
    }

    const explanationMatch = line.match(/^(?:>\s*)?(?:\*\*)?(?:答案)?(?:解析|解释|Explanation)(?:\*\*)?\s*[：:]\s*(.*)$/i);
    if (explanationMatch) {
      readingExplanation = true;
      if (explanationMatch[1]!.trim()) current.explanationLines.push(explanationMatch[1]!.trim());
      continue;
    }

    if (readingExplanation && /^>\s*/.test(line)) {
      current.explanationLines.push(line.replace(/^>\s*/, "").trim());
    } else if (!current.options.length && !current.answer) {
      current.questionLines.push(line);
    }
  }
  finalize();
  return questions;
}

export function scoreQuizQuestions(
  questions: QuizQuestion[],
  answers: Record<string, string> = {}
): { total: number; answered: number; correct: number; wrongIds: string[] } {
  let answered = 0;
  let correct = 0;
  const wrongIds: string[] = [];
  for (const question of questions) {
    const selected = String(answers[question.id] || "").toUpperCase();
    if (!selected) continue;
    answered += 1;
    if (selected === question.answer) correct += 1;
    else wrongIds.push(question.id);
  }
  return { total: questions.length, answered, correct, wrongIds };
}

export function retainMatchingQuizState(
  markdown: string,
  state?: QuizRecordState | null,
  templateId = ""
): QuizRecordState | undefined {
  if (!state) return undefined;
  const isQuizTemplate = Boolean(getNoteStructure(templateId).supportsQuiz);
  if (!isQuizTemplate) {
    // Regenerating a regular note invalidates its previously generated companion quiz.
    return undefined;
  }
  const validIds = new Set(parseQuizQuestions(markdown).map((q) => q.id));
  const retainedAnswers: Record<string, string> = {};
  for (const [id, choice] of Object.entries(state.answers || {})) {
    if (validIds.has(id) && choice) retainedAnswers[id] = choice;
  }
  return Object.keys(retainedAnswers).length
    ? { answers: retainedAnswers, updatedAt: state.updatedAt || new Date().toISOString() }
    : undefined;
}

export function buildQuizVideoUrl(
  timestamp: string,
  videoUrl: string | undefined,
  seconds: number | null
): string {
  if (!timestamp || seconds === null) return "";
  try {
    const parsed = new URL(videoUrl || "");
    if (/(^|\.)bilibili\.com$/i.test(parsed.hostname)) {
      parsed.searchParams.set("t", String(seconds));
      return parsed.toString();
    }
  } catch {
    // Ignore missing or invalid URL.
  }
  return "";
}
