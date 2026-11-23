import { getNoteStructure } from "./note-structures.ts";

export type FlashcardGrade = "again" | "hard" | "good";

export interface FlashcardReviewState {
  id: string;
  ease: number;
  intervalDays: number;
  repetitions: number;
  dueAt: number;
  lastReviewedAt?: string;
}

export interface FlashcardItem {
  id: string;
  front: string;
  back: string;
  tags: string;
  timestamp: string;
  noteId?: string;
  noteTitle?: string;
  videoUrl?: string;
  reviewState?: FlashcardReviewState;
}

interface FlashcardSourceNote {
  id: string;
  title?: string;
  url?: string;
  template?: string;
  markdown: string;
  flashcardReview?: FlashcardReviewState[];
}

const DEFAULT_EASE = 2.3;
const DAY_MS = 24 * 60 * 60 * 1000;

function splitTableRow(line: string): string[] {
  const source = String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "\\" && source[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function cleanCell(value?: string): string {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\\\|/g, "|")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

function flashcardIdFor(front: string, back: string): string {
  const source = `${front}\u0000${back}`;
  let left = 2166136261;
  let right = 2246822519;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ (code + index), 3266489917);
  }
  return `fc-${(left >>> 0).toString(36)}-${(right >>> 0).toString(36)}`;
}

function hasFlashcardTableCandidate(markdown?: string): boolean {
  return /\|[^\n]*(?:front|question|问题|正面)[^\n]*\|/i.test(String(markdown || ""));
}

/**
 * Parse Markdown flashcard tables across the whole note, skipping fenced code blocks
 * and deduplicating identical cards by deterministic content hash.
 */
export function parseFlashcards(markdown: string): FlashcardItem[] {
  const lines = String(markdown || "").split(/\r?\n/);
  const cards: FlashcardItem[] = [];
  const seenIds = new Set<string>();
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fenceLine = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceLine) {
      const marker = fenceLine[1]![0]!;
      if (!fence) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence || index + 1 >= lines.length) continue;

    const nextLine = lines[index + 1]!;
    if (!/^\s*\|/.test(line) || !/^\s*\|/.test(nextLine) || /^\s*(`{3,}|~{3,})/.test(nextLine)) continue;

    const headers = splitTableRow(line).map((value) => cleanCell(value).toLowerCase());
    const rule = splitTableRow(nextLine);
    if (!rule.length || !rule.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")))) continue;

    const frontIndex = headers.findIndex((value) => /front|question|问题|正面/.test(value));
    const backIndex = headers.findIndex((value) => /back|answer|答案|背面/.test(value));
    if (frontIndex < 0 || backIndex < 0) continue;

    const tagsIndex = headers.findIndex((value) => /tags?|标签/.test(value));
    const timestampIndex = headers.findIndex((value) => /timestamp|time|时间戳|时间/.test(value));

    let row = index + 2;
    for (; row < lines.length; row += 1) {
      const rowLine = lines[row]!;
      if (/^\s*(`{3,}|~{3,})/.test(rowLine) || !/^\s*\|/.test(rowLine)) break;
      const cells = splitTableRow(rowLine);
      const front = cleanCell(cells[frontIndex]);
      const back = cleanCell(cells[backIndex]);
      if (!front || !back) continue;
      const id = flashcardIdFor(front, back);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      cards.push({
        id,
        front,
        back,
        tags: tagsIndex >= 0 ? cleanCell(cells[tagsIndex]) : "",
        timestamp: timestampIndex >= 0 ? cleanCell(cells[timestampIndex]) : ""
      });
    }
    index = row - 1;
  }

  return cards;
}

export function getFlashcardReviewState(
  card: Pick<FlashcardItem, "id" | "reviewState">,
  states: FlashcardReviewState[] = []
): FlashcardReviewState {
  if (card.reviewState) return card.reviewState;
  return (Array.isArray(states) ? states : []).find((item) => item?.id === card.id) || {
    id: card.id,
    ease: DEFAULT_EASE,
    intervalDays: 0,
    repetitions: 0,
    dueAt: 0
  };
}

export function nextFlashcardInterval(grade: FlashcardGrade, state: FlashcardReviewState): number {
  if (grade === "again") return 10 / (24 * 60);
  if (grade === "hard") return Math.max(1, Number(state.intervalDays) * 1.2);
  return Number(state.intervalDays) > 0
    ? Math.max(1, Number(state.intervalDays) * Number(state.ease || DEFAULT_EASE))
    : 1;
}

export function formatFlashcardInterval(days: number): string {
  const minutes = Math.max(1, Math.round(days * 24 * 60));
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.round(minutes / (24 * 60))} 天`;
}

export function getDueFlashcards(
  cards: FlashcardItem[],
  states: FlashcardReviewState[] = [],
  now = Date.now()
): FlashcardItem[] {
  return cards.filter((card) => Number(getFlashcardReviewState(card, states).dueAt) <= now);
}

export function computeNextReviewState(
  cardId: string,
  grade: FlashcardGrade,
  oldState: FlashcardReviewState,
  now = Date.now()
): FlashcardReviewState {
  const intervalDays = nextFlashcardInterval(grade, oldState);
  const easeDelta = grade === "good" ? 0.05 : grade === "hard" ? -0.15 : -0.2;
  return {
    id: cardId,
    ease: Math.max(1.3, Math.min(2.8, Number(oldState.ease || DEFAULT_EASE) + easeDelta)),
    intervalDays,
    repetitions: grade === "again" ? 0 : Number(oldState.repetitions || 0) + 1,
    dueAt: now + intervalDays * DAY_MS,
    lastReviewedAt: new Date(now).toISOString()
  };
}

export function mergeFlashcardReviewState(
  existing: FlashcardReviewState[] | undefined,
  nextState: FlashcardReviewState
): FlashcardReviewState[] {
  const list = Array.isArray(existing) ? existing : [];
  return [...list.filter((item) => item?.id !== nextState.id), nextState];
}

export function retainMatchingFlashcardReviews(
  markdown: string,
  states: FlashcardReviewState[] = []
): FlashcardReviewState[] {
  const list = Array.isArray(states) ? states : [];
  if (!list.length || !markdown) return [];
  const validIds = new Set(parseFlashcards(markdown).map((card) => card.id));
  return list.filter((item) => Boolean(item?.id && validIds.has(item.id)));
}

export function collectFlashcardsFromNotes(
  notes: FlashcardSourceNote[],
  { dueOnly = false, now = Date.now() }: { dueOnly?: boolean; now?: number } = {}
): FlashcardItem[] {
  const cards: FlashcardItem[] = [];
  for (const note of notes) {
    if (!getNoteStructure(note.template).supportsFlashcards && !hasFlashcardTableCandidate(note.markdown)) {
      continue;
    }
    const dueById = new Map(
      (Array.isArray(note.flashcardReview) ? note.flashcardReview : []).map((item) => [item.id, item])
    );
    for (const card of parseFlashcards(note.markdown)) {
      const reviewState = dueById.get(card.id) || {
        id: card.id,
        ease: DEFAULT_EASE,
        intervalDays: 0,
        repetitions: 0,
        dueAt: 0
      };
      if (dueOnly && Number(reviewState.dueAt) > now) continue;
      cards.push({
        ...card,
        noteId: note.id,
        noteTitle: note.title || "课程笔记",
        videoUrl: note.url || "",
        reviewState
      });
    }
  }
  return cards;
}

export function formatAnkiTsv(
  cards: FlashcardItem[],
  { addCourseTag = false }: { addCourseTag?: boolean } = {}
): string {
  const cleanField = (value?: string) => String(value || "").replace(/[\t\r\n]+/g, " ").trim();
  return [
    "#separator:Tab",
    "#html:false",
    "#columns:Front\tBack\tTags",
    "#tags column:3",
    ...cards.map((card) => [
      cleanField(card.front),
      [cleanField(card.back), cleanField(card.timestamp) ? `视频时间戳：${cleanField(card.timestamp)}` : ""]
        .filter(Boolean)
        .join(" · "),
      [cleanField(card.tags), addCourseTag ? cleanField(card.noteTitle).replace(/\s+/g, "_") : ""]
        .filter(Boolean)
        .join(" ")
    ].join("\t"))
  ].join("\n");
}

export function buildFlashcardVideoUrl(
  card: Pick<FlashcardItem, "timestamp" | "videoUrl">,
  fallbackVideoUrl: string | undefined,
  seconds: number | null
): string {
  if (seconds === null) return "";
  try {
    const videoUrl = new URL(card.videoUrl || fallbackVideoUrl || "");
    if (/(^|\.)bilibili\.com$/i.test(videoUrl.hostname)) {
      videoUrl.searchParams.set("t", String(seconds));
      return videoUrl.toString();
    }
  } catch {
    // Ignore malformed or absent video URLs cleanly.
  }
  return "";
}
