import { Keji, type KeyFrameItem, type TemplateId } from "./keji.ts";
import { mergeMarkdownSections } from "./markdown.ts";
import { stripQuizQuestionPrefix } from "./quiz.ts";

export interface OutlineSectionItem {
  id: string;
  title: string;
  startTime?: string;
}

interface StructuredKeyframe {
  timestamp: string;
  caption: string;
}

type StudyPointItem = string | { main: string; sub: string[] };

type StudyBlock =
  | { type: "points"; items: StudyPointItem[] }
  | { type: "subsection"; title: string; startTime?: string; lead?: string; items: StudyPointItem[]; code?: string; lang?: string }
  | { type: "derivation"; title?: string; startTime?: string; steps: string[] }
  | { type: "comparison"; title?: string; headers: string[]; rows: string[][] }
  | { type: "code"; title?: string; time?: string; summary?: string; lang: string; code: string; verify?: string }
  | { type: "example"; title?: string; time?: string; content: string }
  | { type: "pitfall"; content: string };

interface StudySection {
  id: string;
  title: string;
  startTime: string;
  lead: string;
  blocks: StudyBlock[];
  keyframes: StructuredKeyframe[];
}

interface StudyData {
  kind: "study";
  overview: {
    coreQuestion: string;
    takeaways: string[];
  };
  sections: StudySection[];
  cheatSheet: Array<{ item: string; meaning: string }>;
}

interface BriefData {
  kind: "brief";
  thesis: string;
  takeaways: Array<{ point: string; detail: string; time: string }>;
  logicChain: string[];
  keyframes: StructuredKeyframe[];
}

interface TutorialStep {
  id: string;
  title: string;
  time: string;
  action: string;
  code: string;
  lang: string;
  verify: string;
  pitfall: string;
  keyframe?: StructuredKeyframe;
}

interface TutorialData {
  kind: "tutorial";
  goal: string;
  prerequisites: string[];
  steps: TutorialStep[];
  troubleshooting: Array<{ issue: string; fix: string }>;
  keyframes: StructuredKeyframe[];
}

interface TimelinePhase {
  startTime: string;
  endTime: string;
  title: string;
  transition: string;
  highlights: string[];
  keyframe?: StructuredKeyframe;
}

interface TimelineData {
  kind: "timeline";
  overview: string;
  phases: TimelinePhase[];
  keyframes: StructuredKeyframe[];
}

interface CustomSection {
  id: string;
  title: string;
  startTime: string;
  bodyMarkdown: string;
  keyframes: StructuredKeyframe[];
}

interface CustomData {
  kind: "custom";
  overview: string;
  sections: CustomSection[];
  keyframes: StructuredKeyframe[];
}

interface FlashcardsData {
  kind: "flashcards";
  cards: Array<{ front: string; back: string; tags: string; timestamp: string }>;
}

interface QuizData {
  kind: "quiz";
  questions: Array<{
    question: string;
    timestamp: string;
    options: Array<{ key: string; text: string }>;
    answer: string;
    explanation: string;
  }>;
}

export type StructuredNoteData =
  | StudyData
  | BriefData
  | TutorialData
  | TimelineData
  | CustomData
  | FlashcardsData
  | QuizData;

const LATEX_T_COMMANDS = /^t(?:au|heta|imes|ext(?:bf|rm|it|tt|sf)?|an(?:h)?|o|riangle(?:q)?|ilde|op|herefore|frac)(?![a-zA-Z])/;
const LATEX_N_COMMANDS = /^n(?:eq|abla|eg|otin|less|gtr|mid|sim|leq|geq|subseteq|atural|u)(?![a-zA-Z])/;
const KEYFRAME_MARKER_PATTERN = /\[\[KEYFRAME:\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\|\s*([^\]]+)\]\]/gi;
const CAPTURED_PLACEHOLDER_PATTERN = /(?:>\s*\*\*画面要点\s*·[^\n]*\n+)?\s*\[视频关键帧：[^\]]+\]/g;
const HUMANIZED_KEYFRAME_PATTERN = />\s*关键时刻\s*·\s*\d{1,2}:\d{2}(?::\d{2})?\s*[：:][^\n]+/g;

function stripThinkAndFence(raw: string): string {
  let text = String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const fenceMatch = text.match(/^`{3,}[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n`{3,}$/);
  if (fenceMatch) return fenceMatch[1]!.trim();
  const inlineFence = text.match(/`{3,}(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n`{3,}/);
  if (inlineFence && text.startsWith("`")) return inlineFence[1]!.trim();
  return text;
}

function extractBalancedJson(text: string): string | null {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  if (startObj < 0 && startArr < 0) return null;
  const start = startObj >= 0 && (startArr < 0 || startObj < startArr) ? startObj : startArr;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
    } else if (ch === "}" || ch === "]") {
      if (!stack.length || stack[stack.length - 1] !== ch) break;
      stack.pop();
      if (stack.length === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function repairJsonText(source: string): string {
  let pass1 = "";
  let inString = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (!inString) {
      if (ch === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
        i += 1;
        continue;
      }
      if (ch === "\"") inString = true;
      pass1 += ch;
      continue;
    }

    if (ch === "\"") {
      inString = false;
      pass1 += ch;
      continue;
    }
    if (ch === "\n") {
      pass1 += "\\n";
      continue;
    }
    if (ch === "\r") {
      continue;
    }
    if (ch === "\t") {
      pass1 += "\\t";
      continue;
    }
    if (ch.charCodeAt(0) < 0x20) {
      continue;
    }
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) {
        pass1 += "\\\\";
        continue;
      }
      if (next === "\\") {
        pass1 += "\\\\";
        i += 1;
        continue;
      }
      if (next === "\"" || next === "/") {
        pass1 += `\\${next}`;
        i += 1;
        continue;
      }
      if (next === "u") {
        const hex = source.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          pass1 += `\\u${hex}`;
          i += 5;
        } else {
          pass1 += "\\\\u";
          i += 1;
        }
        continue;
      }
      const rest = source.slice(i + 1);
      if (next === "f" || next === "b" || next === "r") {
        pass1 += /^[fbr][a-zA-Z]/.test(rest) ? `\\\\${next}` : `\\${next}`;
        i += 1;
        continue;
      }
      if (next === "t") {
        pass1 += LATEX_T_COMMANDS.test(rest) ? "\\\\t" : "\\t";
        i += 1;
        continue;
      }
      if (next === "n") {
        pass1 += LATEX_N_COMMANDS.test(rest) ? "\\\\n" : "\\n";
        i += 1;
        continue;
      }
      pass1 += `\\\\${next}`;
      i += 1;
      continue;
    }
    pass1 += ch;
  }

  let output = "";
  inString = false;
  let escaped = false;
  for (let i = 0; i < pass1.length; i += 1) {
    const ch = pass1[i]!;
    if (inString) {
      output += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      output += ch;
      continue;
    }
    if (ch === ",") {
      let lookahead = i + 1;
      while (lookahead < pass1.length && /\s/.test(pass1[lookahead]!)) lookahead += 1;
      const upcoming = pass1[lookahead];
      if (upcoming === "}" || upcoming === "]") continue;
    }
    output += ch;
  }
  return output;
}

/** Parse tolerant LLM JSON output, preserving LaTeX commands inside string literals. */
export function parseModelJson<T = unknown>(raw: string): T | null {
  const cleaned = stripThinkAndFence(raw);
  if (!cleaned) return null;
  const candidate = extractBalancedJson(cleaned);
  if (!candidate) return null;
  const repaired = repairJsonText(candidate);
  try {
    return JSON.parse(repaired) as T;
  } catch {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      return null;
    }
  }
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function normalizeInlineMath(text: string): string {
  return String(text || "").replace(/\$\$([^$\n]+?)\$\$/g, (_m, expr: string) => `$${expr.trim()}$`);
}

function stripLeadingOrTrailingTimestamp(text: string): string {
  return String(text || "")
    .replace(/^(?:\s*[\[【(（]?\d{1,2}:\d{2}(?::\d{2})?[\]】)）]?\s*)+/, "")
    .replace(/(?:\s*[\[【(（]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[\]】)）])+\s*[。.]?\s*$/, "")
    .trim();
}

function cleanText(raw: unknown, { stripTimestamps = false }: { stripTimestamps?: boolean } = {}): string {
  let value = normalizeInlineMath(String(raw || ""))
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripTimestamps) value = stripLeadingOrTrailingTimestamp(value);
  return value;
}

function cleanHeadingTitle(raw: unknown): string {
  return cleanText(raw, { stripTimestamps: true })
    .replace(/^#{1,6}\s+/, "")
    .trim();
}

function normalizeTimestampLabel(raw: unknown, durationSeconds = 0): string {
  const stripped = String(raw || "").replace(/[\[\]()（）【】\s]/g, "").trim();
  if (!stripped) return "";
  const seconds = Keji.parseTime(stripped);
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  if (durationSeconds > 0 && seconds > durationSeconds + 5) return "";
  return Keji.formatTime(seconds);
}

function escapeTableCell(raw: unknown): string {
  const normalized = String(raw || "")
    .replace(/<br\s*\/?>/gi, "；")
    .replace(/\r?\n+/g, "；");
  return cleanText(normalized)
    .replace(/(?<!\\)\|/g, "\\|")
    .replace(/；{2,}/g, "；")
    .trim();
}

function sanitizeCaption(raw: unknown): string {
  return cleanText(raw, { stripTimestamps: true })
    .replace(/[|\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function normalizeKeyframes(rawList: unknown, durationSeconds = 0): StructuredKeyframe[] {
  const normalized: StructuredKeyframe[] = [];
  for (const item of asArray(rawList)) {
    const obj = asObject(item);
    if (!obj) continue;
    const timestamp = normalizeTimestampLabel(obj.timestamp ?? obj.time ?? obj.t, durationSeconds);
    const caption = sanitizeCaption(obj.caption ?? obj.label ?? obj.title ?? obj.description);
    if (timestamp && caption) normalized.push({ timestamp, caption });
  }
  return dedupeKeyframes(normalized, 8);
}

function dedupeKeyframes(items: StructuredKeyframe[], minGapSeconds = 8): StructuredKeyframe[] {
  const withTime = items
    .map((item) => ({
      timestamp: normalizeTimestampLabel(item.timestamp),
      caption: sanitizeCaption(item.caption),
      seconds: Keji.parseTime(item.timestamp) ?? -1
    }))
    .filter((item) => item.timestamp && item.caption && item.seconds >= 0)
    .sort((a, b) => a.seconds - b.seconds);

  const kept: Array<{ timestamp: string; caption: string; seconds: number }> = [];
  for (const item of withTime) {
    const prev = kept[kept.length - 1];
    if (prev && item.seconds - prev.seconds < minGapSeconds) {
      if (item.caption.length > prev.caption.length) {
        kept[kept.length - 1] = item;
      }
      continue;
    }
    kept.push(item);
  }
  return kept.map(({ timestamp, caption }) => ({ timestamp, caption }));
}

function normalizeSectionTitleKey(title: string): string {
  return cleanHeadingTitle(title)
    .replace(/^(?:第?[一二三四五六七八九十\d]+[章节讲点步部分]\s*[：:、.]?\s*|\d+(?:\.\d+)*\s*[.、:：)]\s*)/, "")
    .toLocaleLowerCase()
    .replace(/[\s·—–\-:：，,。()（）\[\]【】]+/g, "");
}

function sameOrSimilarTitle(a: string, b: string): boolean {
  const ka = normalizeSectionTitleKey(a);
  const kb = normalizeSectionTitleKey(b);
  if (!ka || !kb) return false;
  return ka === kb || (ka.length >= 3 && kb.length >= 3 && (ka.includes(kb) || kb.includes(ka)));
}

function normalizeStringList(raw: unknown, { stripTimestamps = true, limit = 16 }: { stripTimestamps?: boolean; limit?: number } = {}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of asArray(raw)) {
    const text = cleanText(
      typeof item === "string" ? item : (asObject(item)?.text ?? asObject(item)?.content ?? asObject(item)?.point ?? ""),
      { stripTimestamps }
    ).replace(/^(?:[-*•]\s+|\d+[.)、]\s+)/, "").trim();
    const key = text.toLocaleLowerCase().replace(/\s+/g, "");
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function pointItemText(item: StudyPointItem): string {
  return typeof item === "string" ? item : item.main;
}

function normalizePointItems(
  raw: unknown,
  { stripTimestamps = true, limit = 16 }: { stripTimestamps?: boolean; limit?: number } = {}
): StudyPointItem[] {
  const seen = new Set<string>();
  const out: StudyPointItem[] = [];
  for (const entry of asArray(raw)) {
    if (typeof entry === "string") {
      const text = cleanText(entry, { stripTimestamps }).replace(/^(?:[-*•]\s+|\d+[.)、]\s+)/, "").trim();
      const key = text.toLocaleLowerCase().replace(/\s+/g, "");
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    } else {
      const obj = asObject(entry);
      if (!obj) continue;
      const main = cleanText(obj.main ?? obj.point ?? obj.title ?? obj.text ?? obj.content ?? "", { stripTimestamps })
        .replace(/^(?:[-*•]\s+|\d+[.)、]\s+)/, "")
        .trim();
      const key = main.toLocaleLowerCase().replace(/\s+/g, "");
      if (!main || seen.has(key)) continue;
      seen.add(key);
      const sub = normalizeStringList(obj.sub ?? obj.subs ?? obj.details ?? obj.children ?? obj.items ?? [], { stripTimestamps, limit: 8 });
      out.push(sub.length ? { main, sub } : main);
    }
    if (out.length >= limit) break;
  }
  return out;
}

function clonePointItem(item: StudyPointItem): StudyPointItem {
  return typeof item === "string" ? item : { main: item.main, sub: [...item.sub] };
}

function cloneStudyBlock(block: StudyBlock): StudyBlock {
  if (block.type === "points") return { type: "points", items: block.items.map(clonePointItem) };
  if (block.type === "subsection") return { ...block, items: block.items.map(clonePointItem) };
  if (block.type === "derivation") return { ...block, steps: [...block.steps] };
  if (block.type === "comparison") return { ...block, headers: [...block.headers], rows: block.rows.map((r) => [...r]) };
  return { ...block };
}

function normalizeStudyBlocks(sectionObj: Record<string, any>): StudyBlock[] {
  const blocks: StudyBlock[] = [];
  const rawBlocks = asArray(sectionObj.blocks);
  let pitfallCount = 0;

  const pushSubsection = (obj: Record<string, any>) => {
    const title = cleanHeadingTitle(obj.title ?? obj.heading ?? obj.name);
    const items = normalizePointItems(obj.items ?? obj.points ?? obj.bullets ?? []);
    const lead = cleanText(obj.lead ?? obj.context ?? obj.motivation ?? obj.summary, { stripTimestamps: true }) || undefined;
    const code = String(obj.code ?? obj.command ?? "").trim() || undefined;
    const lang = cleanText(obj.lang ?? obj.language).replace(/[^a-zA-Z0-9_+-]/g, "") || undefined;
    if (title && (items.length || lead || code)) {
      blocks.push({
        type: "subsection",
        title,
        startTime: normalizeTimestampLabel(obj.startTime ?? obj.time) || undefined,
        lead,
        items,
        code,
        lang
      });
    }
  };

  for (const raw of rawBlocks) {
    if (typeof raw === "string") {
      const item = cleanText(raw, { stripTimestamps: true });
      if (item) blocks.push({ type: "points", items: [item] });
      continue;
    }
    const obj = asObject(raw);
    if (!obj) continue;
    const rawType = String(obj.type || obj.kind || "").toLowerCase();

    if (rawType === "subsection") {
      pushSubsection(obj);
      continue;
    }

    if (rawType === "derivation" || Array.isArray(obj.steps)) {
      const steps = asArray(obj.steps)
        .map((s) => cleanText(typeof s === "string" ? s : (asObject(s)?.text ?? asObject(s)?.step ?? ""), { stripTimestamps: true }))
        .map((s) => s.replace(/^\d+[.)、]\s*/, "").trim())
        .filter(Boolean);
      if (steps.length) {
        blocks.push({
          type: "derivation",
          title: cleanText(obj.title ?? obj.name, { stripTimestamps: true }) || undefined,
          startTime: normalizeTimestampLabel(obj.startTime ?? obj.time) || undefined,
          steps
        });
      }
      continue;
    }

    if (rawType === "comparison" || rawType === "table" || (Array.isArray(obj.headers) && Array.isArray(obj.rows))) {
      const headers = asArray(obj.headers).map((h) => escapeTableCell(h)).filter(Boolean);
      const rows = asArray(obj.rows)
        .map((row) => asArray(row).map((cell) => escapeTableCell(cell)))
        .filter((row) => row.some(Boolean));
      if (headers.length >= 2 && rows.length) {
        blocks.push({
          type: "comparison",
          title: cleanText(obj.title ?? obj.name, { stripTimestamps: true }) || undefined,
          headers,
          rows
        });
      }
      continue;
    }

    if (rawType === "code" || rawType === "procedure" || rawType === "implementation" || typeof obj.code === "string" || typeof obj.command === "string") {
      const code = String(obj.code ?? obj.command ?? obj.snippet ?? "").trim();
      const summary = cleanText(obj.summary ?? obj.action ?? obj.description, { stripTimestamps: true }) || undefined;
      if (code || summary) {
        if (code) {
          blocks.push({
            type: "code",
            title: cleanHeadingTitle(obj.title ?? obj.name) || undefined,
            time: normalizeTimestampLabel(obj.time ?? obj.startTime) || undefined,
            summary,
            lang: cleanText(obj.lang ?? obj.language).replace(/[^a-zA-Z0-9_+-]/g, ""),
            code,
            verify: cleanText(obj.verify ?? obj.expected, { stripTimestamps: true }) || undefined
          });
        } else if (summary) {
          blocks.push({ type: "points", items: [summary] });
        }
        continue;
      }
    }

    if (rawType === "example") {
      const content = cleanText(obj.content ?? obj.text ?? obj.summary ?? obj.detail, { stripTimestamps: true });
      if (content) {
        blocks.push({
          type: "example",
          title: cleanText(obj.title ?? obj.name, { stripTimestamps: true }) || undefined,
          time: normalizeTimestampLabel(obj.time ?? obj.startTime) || undefined,
          content
        });
      }
      continue;
    }

    if (rawType === "pitfall" || rawType === "warning" || rawType === "note") {
      const content = cleanText(obj.content ?? obj.text ?? obj.warning, { stripTimestamps: true });
      if (content && pitfallCount < 2) {
        pitfallCount += 1;
        blocks.push({ type: "pitfall", content });
      }
      continue;
    }

    if (rawType !== "points" && typeof (obj.title ?? obj.heading) === "string" && (Array.isArray(obj.items) || Array.isArray(obj.points))) {
      pushSubsection(obj);
      continue;
    }

    const items = normalizePointItems(obj.items ?? obj.points ?? obj.bullets ?? (obj.content ? [obj.content] : []));
    if (items.length) blocks.push({ type: "points", items });
  }

  for (const rawSub of asArray(sectionObj.subsections)) {
    const subObj = asObject(rawSub);
    if (subObj) pushSubsection(subObj);
  }

  // Fallback for sections that use flat points/bullets/items/pitfalls or prose body instead of `blocks`.
  const flatPoints = normalizePointItems(
    sectionObj.points ?? sectionObj.bullets ?? sectionObj.keyPoints ?? sectionObj.items
  );
  if (flatPoints.length) blocks.unshift({ type: "points", items: flatPoints });
  if (!blocks.length) {
    const rawBody = sectionObj.content ?? sectionObj.body ?? sectionObj.text ?? sectionObj.markdown;
    if (typeof rawBody === "string" && rawBody.trim()) {
      const lines = rawBody.split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
      const bodyPoints = normalizePointItems(lines.length > 1 ? lines : [rawBody]);
      if (bodyPoints.length) blocks.push({ type: "points", items: bodyPoints });
    }
  }
  const flatPitfall = cleanText(sectionObj.pitfall, { stripTimestamps: true });
  if (flatPitfall && pitfallCount < 2) blocks.push({ type: "pitfall", content: flatPitfall });

  return mergeConsecutivePointBlocks(blocks);
}

function mergeConsecutivePointBlocks(blocks: StudyBlock[]): StudyBlock[] {
  const out: StudyBlock[] = [];
  const seenPointKeys = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "points") {
      out.push(cloneStudyBlock(block));
      continue;
    }
    const fresh = block.items.filter((item) => {
      const k = pointItemText(item).toLocaleLowerCase().replace(/\s+/g, "");
      if (!k || seenPointKeys.has(k)) return false;
      seenPointKeys.add(k);
      return true;
    });
    if (!fresh.length) continue;
    const prev = out[out.length - 1];
    if (prev?.type === "points") prev.items.push(...fresh.map(clonePointItem));
    else out.push({ type: "points", items: fresh.map(clonePointItem) });
  }
  return out;
}

function normalizeStudyData(obj: Record<string, any>, fallbackCustomPrompt = ""): StudyData | null {
  void fallbackCustomPrompt;
  const ovObj = asObject(obj.overview) || {};
  const overviewStr = typeof obj.overview === "string" ? cleanText(obj.overview, { stripTimestamps: true }) : "";
  const summaryStr = typeof obj.summary === "string" ? cleanText(obj.summary, { stripTimestamps: true }) : "";
  const coreQuestion = cleanText(
    ovObj.coreQuestion ?? obj.coreQuestion ?? ovObj.question ?? obj.thesis ?? (overviewStr || summaryStr || undefined),
    { stripTimestamps: true }
  );
  const takeaways = normalizeStringList(ovObj.takeaways ?? obj.takeaways ?? ovObj.summary ?? obj.summary, { limit: 6 });

  const sections: StudySection[] = [];
  for (const [idx, rawSec] of asArray(obj.sections ?? obj.chapters ?? obj.parts ?? obj.topics).entries()) {
    const sec = asObject(rawSec);
    if (!sec) continue;
    const title = cleanHeadingTitle(sec.title ?? sec.heading ?? sec.name);
    if (!title) continue;
    const blocks = normalizeStudyBlocks(sec);
    const lead = cleanText(
      sec.lead ?? sec.context ?? sec.motivation ?? sec.intuition ?? sec.summary ?? sec.gist,
      { stripTimestamps: true }
    );
    const keyframes = normalizeKeyframes(sec.keyframes ?? sec.keyFrames);
    if (!blocks.length && !lead && !keyframes.length) continue;
    sections.push({
      id: cleanText(sec.id) || `sec-${idx + 1}`,
      title,
      startTime: normalizeTimestampLabel(sec.startTime ?? sec.time ?? sec.timestamp),
      lead,
      blocks,
      keyframes
    });
  }

  const rootKeyframes = normalizeKeyframes(obj.keyframes ?? obj.keyFrames);
  if (rootKeyframes.length && sections.length) {
    for (const kf of rootKeyframes) {
      const kfSec = Keji.parseTime(kf.timestamp) ?? 0;
      let target = sections[sections.length - 1]!;
      for (let i = 0; i < sections.length; i += 1) {
        const sTime = Keji.parseTime(sections[i]!.startTime);
        if (sTime !== null && sTime <= kfSec) target = sections[i]!;
      }
      target.keyframes = dedupeKeyframes([...target.keyframes, kf], 8);
    }
  }

  const cheatSheet: Array<{ item: string; meaning: string }> = [];
  const seenCheat = new Set<string>();
  for (const rawItem of asArray(obj.cheatSheet ?? obj.cheat_sheet ?? obj.glossary)) {
    const itemObj = asObject(rawItem);
    if (!itemObj) continue;
    const item = escapeTableCell(itemObj.item ?? itemObj.term ?? itemObj.formula ?? itemObj.name);
    const meaning = escapeTableCell(itemObj.meaning ?? itemObj.definition ?? itemObj.desc ?? itemObj.description);
    const key = item.toLocaleLowerCase();
    if (!item || !meaning || seenCheat.has(key)) continue;
    seenCheat.add(key);
    cheatSheet.push({ item, meaning });
  }

  if (!coreQuestion && !takeaways.length && !sections.length && !cheatSheet.length) return null;
  return {
    kind: "study",
    overview: { coreQuestion, takeaways },
    sections,
    cheatSheet
  };
}

function normalizeBriefData(obj: Record<string, any>): BriefData | null {
  const thesis = cleanText(obj.thesis ?? obj.coreThesis ?? obj.summary ?? obj.overview, { stripTimestamps: true });
  const takeaways: Array<{ point: string; detail: string; time: string }> = [];
  const seen = new Set<string>();
  for (const rawItem of asArray(obj.takeaways ?? obj.keyConclusions ?? obj.conclusions ?? obj.points)) {
    if (typeof rawItem === "string") {
      const point = cleanText(rawItem, { stripTimestamps: true });
      if (point && !seen.has(point)) {
        seen.add(point);
        takeaways.push({ point, detail: "", time: "" });
      }
      continue;
    }
    const itemObj = asObject(rawItem);
    if (!itemObj) continue;
    const point = cleanText(itemObj.point ?? itemObj.conclusion ?? itemObj.title ?? itemObj.summary, { stripTimestamps: true });
    const detail = cleanText(itemObj.detail ?? itemObj.basis ?? itemObj.reason ?? itemObj.explanation, { stripTimestamps: true });
    const time = normalizeTimestampLabel(itemObj.time ?? itemObj.timestamp ?? itemObj.startTime);
    const key = point.toLocaleLowerCase().replace(/\s+/g, "");
    if (!point || seen.has(key)) continue;
    seen.add(key);
    takeaways.push({ point, detail, time });
  }
  const logicChain = normalizeStringList(obj.logicChain ?? obj.framework ?? obj.outline, { limit: 10 });
  const keyframes = normalizeKeyframes(obj.keyframes ?? obj.keyFrames);
  if (!thesis && !takeaways.length && !logicChain.length) return null;
  return { kind: "brief", thesis, takeaways, logicChain, keyframes };
}

function normalizeTutorialData(obj: Record<string, any>): TutorialData | null {
  const goal = cleanText(obj.goal ?? obj.objective ?? obj.summary, { stripTimestamps: true });
  const prerequisites = normalizeStringList(obj.prerequisites ?? obj.prereqs, { limit: 10 });
  const steps: TutorialStep[] = [];
  for (const [idx, rawStep] of asArray(obj.steps ?? obj.sections).entries()) {
    const sObj = asObject(rawStep);
    if (!sObj) continue;
    const title = cleanHeadingTitle(sObj.title ?? sObj.name);
    const action = cleanText(sObj.action ?? sObj.content ?? sObj.detail ?? sObj.description, { stripTimestamps: true });
    if (!title && !action) continue;
    const kf = normalizeKeyframes(sObj.keyframe ? [sObj.keyframe] : sObj.keyframes)[0];
    steps.push({
      id: cleanText(sObj.id) || `step-${idx + 1}`,
      title: title || `操作 ${idx + 1}`,
      time: normalizeTimestampLabel(sObj.time ?? sObj.startTime ?? sObj.timestamp),
      action,
      code: String(sObj.code ?? sObj.command ?? "").trim(),
      lang: cleanText(sObj.lang ?? sObj.language).replace(/[^a-zA-Z0-9_+-]/g, ""),
      verify: cleanText(sObj.verify ?? sObj.expected, { stripTimestamps: true }),
      pitfall: cleanText(sObj.pitfall ?? sObj.warning, { stripTimestamps: true }),
      keyframe: kf
    });
  }
  const troubleshooting: Array<{ issue: string; fix: string }> = [];
  for (const rawT of asArray(obj.troubleshooting ?? obj.issues)) {
    const tObj = asObject(rawT);
    if (!tObj) continue;
    const issue = escapeTableCell(tObj.issue ?? tObj.problem ?? tObj.symptom);
    const fix = escapeTableCell(tObj.fix ?? tObj.solution);
    if (issue && fix) troubleshooting.push({ issue, fix });
  }
  const keyframes = normalizeKeyframes(obj.keyframes ?? obj.keyFrames);
  if (!goal && !steps.length && !troubleshooting.length) return null;
  return { kind: "tutorial", goal, prerequisites, steps, troubleshooting, keyframes };
}

function normalizeTimelineData(obj: Record<string, any>): TimelineData | null {
  const overview = cleanText(obj.overview ?? obj.mainThread ?? obj.summary, { stripTimestamps: true });
  const phases: TimelinePhase[] = [];
  for (const rawPhase of asArray(obj.phases ?? obj.timeline ?? obj.sections)) {
    const pObj = asObject(rawPhase);
    if (!pObj) continue;
    const title = cleanHeadingTitle(pObj.title ?? pObj.topic ?? pObj.name);
    if (!title) continue;
    const highlights = normalizeStringList(pObj.highlights ?? pObj.points ?? pObj.bullets, { limit: 5 });
    const transition = cleanText(pObj.transition ?? pObj.summary ?? pObj.relation, { stripTimestamps: true });
    const kf = normalizeKeyframes(pObj.keyframe ? [pObj.keyframe] : pObj.keyframes)[0];
    phases.push({
      startTime: normalizeTimestampLabel(pObj.startTime ?? pObj.time ?? pObj.timestamp),
      endTime: normalizeTimestampLabel(pObj.endTime),
      title,
      transition,
      highlights,
      keyframe: kf
    });
  }
  const keyframes = normalizeKeyframes(obj.keyframes ?? obj.keyFrames);
  if (!overview && !phases.length) return null;
  return { kind: "timeline", overview, phases, keyframes };
}

function normalizeCustomData(obj: Record<string, any>): CustomData | null {
  const overview = cleanText(obj.overview ?? obj.summary, { stripTimestamps: true });
  const sections: CustomSection[] = [];
  for (const [idx, rawSec] of asArray(obj.sections).entries()) {
    const sObj = asObject(rawSec);
    if (!sObj) continue;
    const title = cleanHeadingTitle(sObj.title ?? sObj.name);
    const rawBody = normalizeInlineMath(String(sObj.bodyMarkdown ?? sObj.contentMarkdown ?? sObj.content ?? "").trim());
    const bulletFallback = normalizeStringList(sObj.points ?? sObj.items).map((item) => `- ${item}`).join("\n");
    const bodyMarkdown = rawBody || bulletFallback;
    if (!title && !bodyMarkdown) continue;
    sections.push({
      id: cleanText(sObj.id) || `sec-${idx + 1}`,
      title: title || `节 ${idx + 1}`,
      startTime: normalizeTimestampLabel(sObj.startTime ?? sObj.time),
      bodyMarkdown,
      keyframes: normalizeKeyframes(sObj.keyframes ?? sObj.keyFrames)
    });
  }
  const keyframes = normalizeKeyframes(obj.keyframes ?? obj.keyFrames);
  if (!overview && !sections.length) return null;
  return { kind: "custom", overview, sections, keyframes };
}

function normalizeFlashcardsData(obj: Record<string, any>): FlashcardsData | null {
  const rawList = Array.isArray(obj) ? obj : asArray(obj.cards ?? obj.flashcards ?? obj.items);
  const seen = new Set<string>();
  const cards: FlashcardsData["cards"] = [];
  for (const item of rawList) {
    const cObj = asObject(item);
    if (!cObj) continue;
    const front = escapeTableCell(cObj.front ?? cObj.question ?? cObj.q);
    const back = escapeTableCell(cObj.back ?? cObj.answer ?? cObj.a);
    const key = front.toLocaleLowerCase();
    if (!front || !back || seen.has(key)) continue;
    seen.add(key);
    cards.push({
      front,
      back,
      tags: escapeTableCell(cObj.tags ?? cObj.tag) || "课程要点",
      timestamp: normalizeTimestampLabel(cObj.timestamp ?? cObj.time)
    });
  }
  return cards.length ? { kind: "flashcards", cards } : null;
}

function normalizeQuizData(obj: Record<string, any>): QuizData | null {
  const rawList = Array.isArray(obj) ? obj : asArray(obj.questions ?? obj.items ?? obj.quiz);
  const seen = new Set<string>();
  const questions: QuizData["questions"] = [];

  for (const item of rawList) {
    const qObj = asObject(item);
    if (!qObj) continue;
    const question = stripQuizQuestionPrefix(
      cleanText(qObj.question ?? qObj.stem ?? qObj.prompt, { stripTimestamps: true })
    );
    if (!question) continue;
    const key = question.toLocaleLowerCase();
    if (seen.has(key)) continue;

    const options: Array<{ key: string; text: string }> = [];
    const optSource = qObj.options ?? qObj.choices;
    if (Array.isArray(optSource)) {
      const keys = ["A", "B", "C", "D"];
      optSource.slice(0, 4).forEach((entry, idx) => {
        if (typeof entry === "string") {
          const m = entry.match(/^(?:[A-D][.)、:：]\s*)?(.+)$/i);
          const text = cleanText(m?.[1] || entry);
          if (text) options.push({ key: keys[idx]!, text });
        } else if (asObject(entry)) {
          const eObj = asObject(entry)!;
          const k = cleanText(eObj.key ?? eObj.label).toUpperCase() || keys[idx]!;
          const text = cleanText(eObj.text ?? eObj.content ?? eObj.value);
          if (text) options.push({ key: k, text });
        }
      });
    } else if (asObject(optSource)) {
      for (const k of ["A", "B", "C", "D"]) {
        const text = cleanText(optSource[k] ?? optSource[k.toLowerCase()]);
        if (text) options.push({ key: k, text });
      }
    }

    const answer = cleanText(qObj.answer ?? qObj.correct).toUpperCase().replace(/[^A-D]/g, "").slice(0, 1);
    if (options.length < 2 || !answer || !options.some((o) => o.key === answer)) continue;
    seen.add(key);
    questions.push({
      question,
      timestamp: normalizeTimestampLabel(qObj.timestamp ?? qObj.time),
      options,
      answer,
      explanation: cleanText(qObj.explanation ?? qObj.analysis ?? qObj.reason) || "请结合课程相关片段复核。"
    });
  }
  return questions.length ? { kind: "quiz", questions } : null;
}

function hasTemplateCoreKeys(obj: Record<string, any>, templateId: TemplateId): boolean {
  if (templateId === "flashcards") {
    return Array.isArray(obj.cards) || Array.isArray(obj.flashcards) || Array.isArray(obj.items);
  }
  if (templateId === "quiz") {
    return Array.isArray(obj.questions) || Array.isArray(obj.quiz) || Array.isArray(obj.items);
  }
  if (templateId === "brief") {
    return Boolean(obj.thesis ?? obj.coreThesis ?? obj.takeaways ?? obj.keyConclusions ?? obj.conclusions ?? obj.logicChain ?? obj.framework ?? obj.outline);
  }
  if (templateId === "tutorial") {
    return Boolean(obj.goal ?? obj.objective ?? obj.prerequisites ?? obj.steps ?? obj.sections ?? obj.troubleshooting);
  }
  if (templateId === "timeline") {
    return Boolean(obj.overview ?? obj.mainThread ?? obj.phases ?? obj.timeline ?? obj.sections);
  }
  if (templateId === "custom") {
    return Boolean(obj.sections);
  }
  return Boolean(obj.overview ?? obj.sections ?? obj.chapters ?? obj.parts ?? obj.topics ?? obj.cheatSheet ?? obj.coreQuestion ?? obj.takeaways);
}

function normalizeParsedForTemplate(parsed: Record<string, any> | unknown[], templateId: TemplateId): StructuredNoteData | null {
  if (templateId === "flashcards") return normalizeFlashcardsData(parsed as Record<string, any>);
  if (templateId === "quiz") return normalizeQuizData(parsed as Record<string, any>);
  let obj = asObject(parsed);
  if (!obj) {
    if (!Array.isArray(parsed)) return null;
    if (templateId === "brief") obj = { takeaways: parsed };
    else if (templateId === "tutorial") obj = { steps: parsed };
    else if (templateId === "timeline") obj = { phases: parsed };
    else obj = { sections: parsed };
  }
  if (templateId === "brief") return normalizeBriefData(obj);
  if (templateId === "tutorial") return normalizeTutorialData(obj);
  if (templateId === "timeline") return normalizeTimelineData(obj);
  if (templateId === "custom") return normalizeCustomData(obj);
  return normalizeStudyData(obj);
}

/** Parse and validate LLM JSON response into a canonical structured note object. */
export function parseStructuredNoteResponse(raw: string, templateId: TemplateId): StructuredNoteData | null {
  const parsed = parseModelJson<Record<string, any> | unknown[]>(raw);
  if (!parsed) return null;
  const obj = asObject(parsed);
  if (obj && !hasTemplateCoreKeys(obj, templateId)) {
    for (const key of ["data", "note", "result", "output", templateId]) {
      const inner = obj[key];
      if (!inner || typeof inner !== "object") continue;
      const innerResult = normalizeParsedForTemplate(inner as Record<string, any> | unknown[], templateId);
      if (innerResult) return innerResult;
    }
  }
  return normalizeParsedForTemplate(parsed, templateId);
}

const LOOSE_JSON_META_KEYS = new Set([
  "id", "kind", "template", "status", "ok", "success", "model", "version", "type", "lang"
]);

const LOOSE_JSON_KEY_LABELS: Record<string, string> = {
  title: "主题",
  topic: "主题",
  subject: "主题",
  overview: "核心提要",
  summary: "总结",
  corequestion: "核心问题",
  question: "核心问题",
  thesis: "核心主旨",
  goal: "目标",
  takeaways: "核心结论",
  conclusions: "核心结论",
  points: "核心要点",
  bullets: "要点",
  items: "要点",
  sections: "章节内容",
  chapters: "章节内容",
  parts: "分节内容",
  topics: "专题内容",
  steps: "操作步骤",
  phases: "阶段梳理",
  highlights: "重点内容",
  logicchain: "逻辑脉络",
  cheatsheet: "速查表",
  cheat_sheet: "速查表",
  pitfall: "易错点",
  pitfalls: "易错点",
  verify: "验证方式",
  detail: "说明",
  details: "详细说明",
  content: "正文",
  body: "正文",
  lead: "导语",
  transition: "衔接",
  example: "实例",
  examples: "实例",
  keyframes: "关键帧"
};

function formatLooseKeyLabel(rawKey: string): string {
  const trimmed = rawKey.trim();
  const mapped = LOOSE_JSON_KEY_LABELS[trimmed.toLocaleLowerCase()];
  if (mapped) return mapped;
  return trimmed.replace(/[_-]+/g, " ");
}

function renderLooseJsonEntry(value: unknown, headingLevel = 2): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    return stripThinkAndFence(value).trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (item === null || item === undefined) continue;
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
        const text = cleanText(item);
        if (text) parts.push(`- ${text}`);
        continue;
      }
      const itemObj = asObject(item);
      if (!itemObj) continue;
      const kfTs = normalizeTimestampLabel(itemObj.timestamp ?? itemObj.time);
      const kfCaption = sanitizeCaption(itemObj.caption ?? itemObj.label);
      if (kfTs && kfCaption && !itemObj.points && !itemObj.blocks && !itemObj.steps && !itemObj.items && !itemObj.content) {
        parts.push(`[[KEYFRAME: ${kfTs} | ${kfCaption}]]`);
        continue;
      }
      const rendered = renderLooseJsonObject(itemObj, Math.min(4, headingLevel));
      if (rendered) parts.push(rendered);
    }
    return parts.join("\n\n");
  }
  const obj = asObject(value);
  return obj ? renderLooseJsonObject(obj, headingLevel) : "";
}

function renderLooseJsonObject(obj: Record<string, unknown>, headingLevel = 2): string {
  const blocks: string[] = [];
  const scalars: string[] = [];
  const rawTitle = cleanHeadingTitle(obj.title ?? obj.heading ?? obj.name ?? obj.topic);
  const ts = normalizeTimestampLabel(obj.startTime ?? obj.time ?? obj.timestamp);
  if (rawTitle) {
    const hashes = "#".repeat(Math.max(2, Math.min(4, headingLevel)));
    blocks.push(`${hashes} ${rawTitle}${ts ? ` [${ts}]` : ""}`);
  }
  if (typeof obj.code === "string" && obj.code.trim()) {
    const lang = cleanText(obj.lang ?? obj.language).replace(/[^a-zA-Z0-9_+-]/g, "");
    blocks.push(`\`\`\`${lang}\n${obj.code.trim()}\n\`\`\``);
  }

  for (const [rawKey, rawVal] of Object.entries(obj)) {
    const lowerKey = rawKey.toLocaleLowerCase();
    if (
      ["title", "heading", "name", "topic", "starttime", "time", "timestamp", "code", "lang", "language"].includes(lowerKey)
      || LOOSE_JSON_META_KEYS.has(lowerKey)
    ) {
      continue;
    }
    if (rawVal === null || rawVal === undefined) continue;
    if (typeof rawVal === "string") {
      const cleaned = stripThinkAndFence(rawVal).trim();
      if (!cleaned) continue;
      if (["markdown", "note", "content", "body", "text", "lead"].includes(lowerKey)) {
        blocks.push(normalizeInlineMath(cleaned));
      } else {
        scalars.push(`- **${formatLooseKeyLabel(rawKey)}**：${normalizeInlineMath(cleanText(cleaned))}`);
      }
      continue;
    }
    if (typeof rawVal === "number" || typeof rawVal === "boolean") {
      scalars.push(`- **${formatLooseKeyLabel(rawKey)}**：${String(rawVal)}`);
      continue;
    }
    const nested = renderLooseJsonEntry(rawVal, Math.min(4, headingLevel + 1));
    if (!nested) continue;
    if (Array.isArray(rawVal)) {
      if (["points", "bullets", "items", "highlights", "takeaways", "keyframes"].includes(lowerKey) || rawTitle) {
        blocks.push(nested);
      } else {
        const hashes = "#".repeat(Math.max(2, Math.min(4, headingLevel)));
        blocks.push(`${hashes} ${formatLooseKeyLabel(rawKey)}\n\n${nested}`);
      }
    } else {
      const hashes = "#".repeat(Math.max(2, Math.min(4, headingLevel)));
      const hasOwnHeading = /^#{2,4}\s+/m.test(nested);
      blocks.push(hasOwnHeading ? nested : `${hashes} ${formatLooseKeyLabel(rawKey)}\n\n${nested}`);
    }
  }

  if (scalars.length) blocks.push(scalars.join("\n"));
  return blocks.join("\n\n").trim();
}

/** Salvage loose/non-standard JSON objects into clean Markdown so raw JSON braces never reach note view. */
export function salvageLooseJsonToMarkdown(obj: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(obj)) return renderLooseJsonEntry(obj, 2);
  const record = asObject(obj);
  if (!record) return "";
  for (const key of ["markdown", "note", "content"]) {
    const val = record[key];
    if (typeof val === "string" && val.trim()) {
      return normalizeInlineMath(stripThinkAndFence(val).trim());
    }
  }
  for (const wrapperKey of ["data", "note", "result", "output"]) {
    const inner = record[wrapperKey];
    if (inner && typeof inner === "object") {
      const innerMd = salvageLooseJsonToMarkdown(inner as Record<string, unknown> | unknown[]);
      if (innerMd) return innerMd;
    }
  }
  return renderLooseJsonObject(record, 2);
}

/** Compile a structured note object deterministically into clean review Markdown. */
export function compileStructuredNoteToMarkdown(data: StructuredNoteData, templateId?: TemplateId): string {
  void templateId;
  const globalSeenKfs: StructuredKeyframe[] = [];
  const takeUniqueKf = (candidates: StructuredKeyframe[]): StructuredKeyframe[] => {
    const out: StructuredKeyframe[] = [];
    for (const kf of candidates) {
      const sec = Keji.parseTime(kf.timestamp);
      if (sec === null) continue;
      if (globalSeenKfs.some((prev) => Math.abs((Keji.parseTime(prev.timestamp) ?? -999) - sec) < 8)) continue;
      globalSeenKfs.push(kf);
      out.push(kf);
    }
    return out;
  };

  if (data.kind === "flashcards") {
    const rows = data.cards.map(
      (c) => `| ${escapeTableCell(c.front)} | ${escapeTableCell(c.back)} | ${escapeTableCell(c.tags || "课程要点")} | ${c.timestamp || "-"} |`
    );
    return ["| 问题 | 答案 | 标签 | 时间戳 |", "| --- | --- | --- | --- |", ...rows].join("\n");
  }

  if (data.kind === "quiz") {
    return data.questions
      .map((q, idx) => {
        const tsBadge = q.timestamp ? ` [${q.timestamp}]` : "";
        return [
          `### Q${idx + 1}. ${q.question}${tsBadge}`,
          ...q.options.map((opt) => `- ${opt.key}. ${opt.text}`),
          `> 答案：${q.answer}`,
          `> 解析：${q.explanation}`
        ].join("\n");
      })
      .join("\n\n");
  }

  if (data.kind === "brief") {
    const blocks: string[] = [];
    if (data.thesis) blocks.push(`## 核心主旨\n\n> ${data.thesis}`);
    if (data.takeaways.length) {
      const items = data.takeaways
        .map((item) => {
          const ts = item.time ? ` [${item.time}]` : "";
          const detail = item.detail ? `：${item.detail}` : "";
          return `- **${item.point}**${ts}${detail}`;
        })
        .join("\n");
      blocks.push(`## 关键结论\n\n${items}`);
    }
    if (data.logicChain.length) {
      const compactArrow = data.logicChain.length >= 2
        && data.logicChain.length <= 6
        && data.logicChain.every((node) => node.length <= 20);
      const chainBody = compactArrow
        ? `> ${data.logicChain.join(" → ")}`
        : data.logicChain.map((node, i) => `${i + 1}. ${node}`).join("\n");
      blocks.push(`## 逻辑脉络\n\n${chainBody}`);
    }
    for (const kf of takeUniqueKf(data.keyframes)) {
      blocks.push(`[[KEYFRAME: ${kf.timestamp} | ${kf.caption}]]`);
    }
    return blocks.join("\n\n");
  }

  if (data.kind === "tutorial") {
    const blocks: string[] = [];
    if (data.goal) blocks.push(`## 实操目标\n\n${data.goal}`);
    if (data.prerequisites.length) {
      blocks.push(`## 前置准备\n\n${data.prerequisites.map((p) => `- ${p}`).join("\n")}`);
    }
    data.steps.forEach((step, idx) => {
      const parts: string[] = [`## 步骤 ${idx + 1}：${step.title}${step.time ? ` [${step.time}]` : ""}`];
      if (step.action) parts.push(step.action);
      if (step.code) parts.push(`\`\`\`${step.lang || ""}\n${step.code}\n\`\`\``);
      if (step.verify) parts.push(`> ✅ **验证**：${step.verify}`);
      if (step.pitfall) parts.push(`> ⚠️ **注意**：${step.pitfall}`);
      if (step.keyframe) {
        for (const kf of takeUniqueKf([step.keyframe])) {
          parts.push(`[[KEYFRAME: ${kf.timestamp} | ${kf.caption}]]`);
        }
      }
      blocks.push(parts.join("\n\n"));
    });
    if (data.troubleshooting.length) {
      const rows = data.troubleshooting.map((t) => `| ${escapeTableCell(t.issue)} | ${escapeTableCell(t.fix)} |`);
      blocks.push(["## 常见排错", "| 问题现象 | 排查与解决方法 |", "| --- | --- |", ...rows].join("\n"));
    }
    for (const kf of takeUniqueKf(data.keyframes)) {
      blocks.push(`[[KEYFRAME: ${kf.timestamp} | ${kf.caption}]]`);
    }
    return blocks.join("\n\n");
  }

  if (data.kind === "timeline") {
    const blocks: string[] = [];
    if (data.overview) blocks.push(`> **全片主线**：${data.overview}`);
    for (const phase of data.phases) {
      const startBadge = phase.startTime ? `[${phase.startTime}] ` : "";
      const endNote = phase.endTime && phase.endTime !== phase.startTime ? `（至 ${phase.endTime}）` : "";
      const parts: string[] = [`## ${startBadge}${phase.title}${endNote}`];
      if (phase.transition) parts.push(`> **衔接**：${phase.transition}`);
      if (phase.highlights.length) parts.push(phase.highlights.map((h) => `- ${h}`).join("\n"));
      if (phase.keyframe) {
        for (const kf of takeUniqueKf([phase.keyframe])) {
          parts.push(`[[KEYFRAME: ${kf.timestamp} | ${kf.caption}]]`);
        }
      }
      blocks.push(parts.join("\n\n"));
    }
    for (const kf of takeUniqueKf(data.keyframes)) {
      blocks.push(`[[KEYFRAME: ${kf.timestamp} | ${kf.caption}]]`);
    }
    return blocks.join("\n\n");
  }

  if (data.kind === "custom") {
    const blocks: string[] = [];
    if (data.overview) blocks.push(`> **内容提要**：${data.overview}`);
    for (const sec of data.sections) {
      const parts: string[] = [`## ${sec.title}${sec.startTime ? ` [${sec.startTime}]` : ""}`];
      if (sec.bodyMarkdown) parts.push(sec.bodyMarkdown);
      for (const kf of takeUniqueKf(sec.keyframes)) {
        parts.push(`[[KEYFRAME: ${kf.timestamp} | ${kf.caption}]]`);
      }
      blocks.push(parts.join("\n\n"));
    }
    for (const kf of takeUniqueKf(data.keyframes)) {
      blocks.push(`[[KEYFRAME: ${kf.timestamp} | ${kf.caption}]]`);
    }
    return blocks.join("\n\n");
  }

  // Default: "study"
  const renderPointItems = (items: StudyPointItem[]): string => items
    .map((item) => {
      if (typeof item === "string") return `- ${item}`;
      if (!item.sub.length) return `- ${item.main}`;
      return [`- **${item.main}**`, ...item.sub.map((s) => `  - ${s}`)].join("\n");
    })
    .join("\n");

  const docBlocks: string[] = [];
  if (data.overview.coreQuestion || data.overview.takeaways.length) {
    const ovParts: string[] = ["## 核心提要"];
    if (data.overview.coreQuestion) ovParts.push(`> **核心问题**：${data.overview.coreQuestion}`);
    if (data.overview.takeaways.length) {
      ovParts.push(data.overview.takeaways.slice(0, 5).map((item) => `- ${item}`).join("\n"));
    }
    docBlocks.push(ovParts.join("\n\n"));
  }

  for (const sec of data.sections) {
    const parts: string[] = [`## ${sec.title}${sec.startTime ? ` [${sec.startTime}]` : ""}`];
    if (sec.lead) parts.push(sec.lead);
    for (const block of sec.blocks) {
      if (block.type === "points") {
        parts.push(renderPointItems(block.items));
      } else if (block.type === "subsection") {
        const subParts: string[] = [`### ${block.title}${block.startTime ? ` [${block.startTime}]` : ""}`];
        if (block.lead) subParts.push(block.lead);
        if (block.items.length) subParts.push(renderPointItems(block.items));
        if (block.code) subParts.push(`\`\`\`${block.lang || ""}\n${block.code}\n\`\`\``);
        parts.push(subParts.join("\n\n"));
      } else if (block.type === "derivation") {
        const header = block.title || block.startTime
          ? `**推导${block.title ? ` · ${block.title}` : ""}**${block.startTime ? ` [${block.startTime}]` : ""}\n\n`
          : "";
        parts.push(`${header}${block.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
      } else if (block.type === "comparison") {
        const titleLine = block.title ? `**对比 · ${block.title}**\n\n` : "";
        const sep = block.headers.map(() => "---");
        const tableLines = [
          `| ${block.headers.join(" | ")} |`,
          `| ${sep.join(" | ")} |`,
          ...block.rows.map((r) => `| ${block.headers.map((_, idx) => escapeTableCell(r[idx] || "-")).join(" | ")} |`)
        ];
        parts.push(`${titleLine}${tableLines.join("\n")}`);
      } else if (block.type === "code") {
        const head = block.title || block.time || block.summary
          ? `**实现${block.title ? ` · ${block.title}` : ""}**${block.time ? ` [${block.time}]` : ""}${block.summary ? `：${block.summary}` : ""}`
          : "";
        const codePieces = [
          head,
          `\`\`\`${block.lang || ""}\n${block.code}\n\`\`\``,
          block.verify ? `- 验证：${block.verify}` : ""
        ].filter(Boolean);
        parts.push(codePieces.join("\n\n"));
      } else if (block.type === "example") {
        const label = block.title ? ` · ${block.title}` : "";
        const time = block.time ? ` [${block.time}]` : "";
        parts.push(`**实例${label}**${time}：${block.content}`);
      } else if (block.type === "pitfall") {
        parts.push(`> **易错边界**：${block.content}`);
      }
    }
    for (const kf of takeUniqueKf(sec.keyframes)) {
      parts.push(`[[KEYFRAME: ${kf.timestamp} | ${kf.caption}]]`);
    }
    docBlocks.push(parts.join("\n\n"));
  }

  if (data.cheatSheet.length) {
    const rows = data.cheatSheet
      .slice(0, 12)
      .map((row) => `| ${escapeTableCell(row.item)} | ${escapeTableCell(row.meaning)} |`);
    docBlocks.push(["## 核心公式与速查", "| 术语 / 公式 | 核心含义与边界 |", "| --- | --- |", ...rows].join("\n"));
  }

  return docBlocks.join("\n\n");
}

function mergeDistinctStrings(prev: string[], next: string[], limit: number): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...prev, ...next]) {
    const clean = cleanText(item, { stripTimestamps: true });
    const key = clean.toLocaleLowerCase().replace(/\s+/g, "");
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    merged.push(clean);
    if (merged.length >= limit) break;
  }
  return merged;
}

/** Merge multi-chunk structured note payloads while keeping sections cohesive and non-redundant. */
export function mergeStructuredNoteData(
  prev: StructuredNoteData,
  next: StructuredNoteData,
  templateId?: TemplateId
): StructuredNoteData {
  void templateId;
  if (prev.kind === "flashcards" && next.kind === "flashcards") {
    const seen = new Set(prev.cards.map((c) => c.front.toLocaleLowerCase()));
    const cards = [...prev.cards];
    for (const card of next.cards) {
      const k = card.front.toLocaleLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        cards.push(card);
      }
    }
    return { kind: "flashcards", cards };
  }

  if (prev.kind === "quiz" && next.kind === "quiz") {
    const seen = new Set(prev.questions.map((q) => q.question.toLocaleLowerCase()));
    const questions = [...prev.questions];
    for (const q of next.questions) {
      const k = q.question.toLocaleLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        questions.push(q);
      }
    }
    return { kind: "quiz", questions };
  }

  if (prev.kind === "brief" && next.kind === "brief") {
    const seen = new Set(prev.takeaways.map((t) => t.point.toLocaleLowerCase().replace(/\s+/g, "")));
    const takeaways = [...prev.takeaways];
    for (const t of next.takeaways) {
      const k = t.point.toLocaleLowerCase().replace(/\s+/g, "");
      if (!seen.has(k) && takeaways.length < 10) {
        seen.add(k);
        takeaways.push(t);
      }
    }
    return {
      kind: "brief",
      thesis: prev.thesis || next.thesis,
      takeaways,
      logicChain: mergeDistinctStrings(prev.logicChain, next.logicChain, 12),
      keyframes: dedupeKeyframes([...prev.keyframes, ...next.keyframes], 8)
    };
  }

  if (prev.kind === "tutorial" && next.kind === "tutorial") {
    const seenSteps = new Set(prev.steps.map((s) => normalizeSectionTitleKey(s.title)));
    const steps = [...prev.steps];
    for (const step of next.steps) {
      const k = normalizeSectionTitleKey(step.title);
      if (k && seenSteps.has(k)) continue;
      if (k) seenSteps.add(k);
      steps.push(step);
    }
    const seenIssues = new Set(prev.troubleshooting.map((t) => t.issue.toLocaleLowerCase()));
    const troubleshooting = [...prev.troubleshooting];
    for (const item of next.troubleshooting) {
      const k = item.issue.toLocaleLowerCase();
      if (!seenIssues.has(k)) {
        seenIssues.add(k);
        troubleshooting.push(item);
      }
    }
    return {
      kind: "tutorial",
      goal: prev.goal || next.goal,
      prerequisites: mergeDistinctStrings(prev.prerequisites, next.prerequisites, 10),
      steps,
      troubleshooting,
      keyframes: dedupeKeyframes([...prev.keyframes, ...next.keyframes], 8)
    };
  }

  if (prev.kind === "timeline" && next.kind === "timeline") {
    const phases = [...prev.phases];
    for (const phase of next.phases) {
      const match = phases.find((p) => sameOrSimilarTitle(p.title, phase.title));
      if (match) {
        if (!match.endTime || (phase.endTime && (Keji.parseTime(phase.endTime) ?? 0) > (Keji.parseTime(match.endTime) ?? 0))) {
          match.endTime = phase.endTime;
        }
        match.highlights = mergeDistinctStrings(match.highlights, phase.highlights, 5);
        if (!match.keyframe && phase.keyframe) match.keyframe = phase.keyframe;
      } else {
        phases.push({ ...phase });
      }
    }
    phases.sort((a, b) => (Keji.parseTime(a.startTime) ?? 0) - (Keji.parseTime(b.startTime) ?? 0));
    return {
      kind: "timeline",
      overview: prev.overview || next.overview,
      phases,
      keyframes: dedupeKeyframes([...prev.keyframes, ...next.keyframes], 8)
    };
  }

  if (prev.kind === "custom" && next.kind === "custom") {
    const sections = prev.sections.map((s) => ({ ...s, keyframes: [...s.keyframes] }));
    for (const inc of next.sections) {
      const target = sections.find((s) => sameOrSimilarTitle(s.title, inc.title))
        || sections.find((s) => s.id === inc.id && (!inc.title || sameOrSimilarTitle(s.title, inc.title)));
      if (target) {
        if (inc.bodyMarkdown) target.bodyMarkdown = target.bodyMarkdown ? `${target.bodyMarkdown}\n\n${inc.bodyMarkdown}` : inc.bodyMarkdown;
        target.keyframes = dedupeKeyframes([...target.keyframes, ...inc.keyframes], 8);
      } else {
        sections.push({
          ...inc,
          id: sections.some((s) => s.id === inc.id) ? `sec-${sections.length + 1}` : inc.id
        });
      }
    }
    return {
      kind: "custom",
      overview: prev.overview || next.overview,
      sections,
      keyframes: dedupeKeyframes([...prev.keyframes, ...next.keyframes], 8)
    };
  }

  if (prev.kind === "study" && next.kind === "study") {
    const sections = prev.sections.map((s) => ({
      ...s,
      blocks: s.blocks.map(cloneStudyBlock),
      keyframes: [...s.keyframes]
    }));
    for (const inc of next.sections) {
      const target = sections.find((s) => sameOrSimilarTitle(s.title, inc.title))
        || sections.find((s) => s.id === inc.id && (!inc.title || sameOrSimilarTitle(s.title, inc.title)));
      if (target) {
        if (!target.startTime && inc.startTime) target.startTime = inc.startTime;
        if (!target.lead && inc.lead) target.lead = inc.lead;
        target.blocks = mergeConsecutivePointBlocks([...target.blocks, ...inc.blocks]);
        target.keyframes = dedupeKeyframes([...target.keyframes, ...inc.keyframes], 8);
      } else {
        sections.push({
          ...inc,
          id: sections.some((s) => s.id === inc.id) ? `sec-${sections.length + 1}` : inc.id,
          blocks: inc.blocks.map(cloneStudyBlock),
          keyframes: [...inc.keyframes]
        });
      }
    }
    const seenCheat = new Set(prev.cheatSheet.map((c) => c.item.toLocaleLowerCase()));
    const cheatSheet = [...prev.cheatSheet];
    for (const item of next.cheatSheet) {
      const k = item.item.toLocaleLowerCase();
      if (!seenCheat.has(k) && cheatSheet.length < 12) {
        seenCheat.add(k);
        cheatSheet.push(item);
      }
    }
    return {
      kind: "study",
      overview: {
        coreQuestion: prev.overview.coreQuestion || next.overview.coreQuestion,
        takeaways: mergeDistinctStrings(prev.overview.takeaways, next.overview.takeaways, 5)
      },
      sections,
      cheatSheet
    };
  }

  return next;
}

/** Extract compact section outline (saving prompt tokens during multi-chunk continuation). */
export function extractStructuredOutline(data: StructuredNoteData, maxCount = 18): OutlineSectionItem[] {
  if (data.kind === "study") {
    return data.sections.slice(-maxCount).map((s) => ({ id: s.id, title: s.title, startTime: s.startTime || undefined }));
  }
  if (data.kind === "tutorial") {
    return data.steps.slice(-maxCount).map((s) => ({ id: s.id, title: s.title, startTime: s.time || undefined }));
  }
  if (data.kind === "timeline") {
    return data.phases.slice(-maxCount).map((p, idx) => ({ id: `phase-${idx + 1}`, title: p.title, startTime: p.startTime || undefined }));
  }
  if (data.kind === "custom") {
    return data.sections.slice(-maxCount).map((s) => ({ id: s.id, title: s.title, startTime: s.startTime || undefined }));
  }
  return [];
}

/** Fallback outline extraction from compiled Markdown when resuming after partial failure. */
export function extractMarkdownOutline(markdown: string, maxCount = 18): OutlineSectionItem[] {
  const headings = [...String(markdown || "").matchAll(/^##\s+(.+)$/gm)]
    .map((m) => cleanHeadingTitle(m[1]))
    .filter((title) => title && !/^(?:核心提要|核心主旨|核心公式与速查)$/.test(title));
  return headings.slice(-maxCount).map((title, idx) => ({ id: `sec-${idx + 1}`, title }));
}

/** Merge Markdown chunks cleanly when resuming without in-memory structured state. */
export function mergeNoteMarkdownChunks(prevMarkdown: string, chunkMarkdown: string): string {
  const merged = mergeMarkdownSections([prevMarkdown, chunkMarkdown]);
  // Deduplicate keyframe markers closer than 8 seconds across the merged Markdown.
  const markers = [...merged.matchAll(KEYFRAME_MARKER_PATTERN)];
  if (markers.length <= 1) return merged;
  let result = merged;
  let lastAcceptedSeconds = -999;
  for (const m of markers) {
    const sec = Keji.parseTime(m[1]!) ?? -1;
    if (sec < 0) continue;
    if (sec - lastAcceptedSeconds < 8) {
      result = result.replace(m[0], "");
    } else {
      lastAcceptedSeconds = sec;
    }
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function schemaHintForTemplate(templateId: TemplateId, continuation: boolean): string {
  switch (templateId) {
    case "brief":
      return [
        "输出严格 JSON（禁止包裹 Markdown 代码围栏，禁止输出解释前缀），结构：",
        '{"thesis":"1-2句概括全课核心主旨","takeaways":[{"point":"高价值结论短语","detail":"关键依据/适用条件（1句）","time":"MM:SS"}],"logicChain":["阶段A","阶段B"],"keyframes":[{"timestamp":"MM:SS","caption":"画面重点简述"}]}',
        `要求：takeaways 控制在 3-${continuation ? 4 : 6} 条以内；普通推导细节省去，只留核心结论与前提条件。`
      ].join("\n");
    case "tutorial":
      return [
        "输出严格 JSON（禁止包裹代码围栏），结构：",
        '{"goal":"一句话实操目标","prerequisites":["环境/依赖"],"steps":[{"title":"步骤动作名称","time":"MM:SS","action":"关键操作与参数说明","code":"命令或代码（无则省略）","lang":"bash","verify":"成功判据","pitfall":"易错点（无则省略）","keyframe":{"timestamp":"MM:SS","caption":"对应画面演示（无则省略）"}}],"troubleshooting":[{"issue":"报错/异常","fix":"排查做法"}]}',
        "要求：按实际动作合并琐碎微步骤，只写明确出现的命令/参数，绝不编造。"
      ].join("\n");
    case "timeline":
      return [
        "输出严格 JSON（禁止包裹代码围栏），结构：",
        '{"overview":"一句话全片主线","phases":[{"startTime":"MM:SS","endTime":"MM:SS","title":"阶段主题","transition":"与前文衔接（1句，可选）","highlights":["核心要点1","核心要点2"],"keyframe":{"timestamp":"MM:SS","caption":"该阶段关键画面（无则省略）"}}]}',
        "要求：按语义推进划分大阶段（不要机械按每分钟切段），highlights 每阶段 1-4 条凝练要点，不要在 highlights 里重复贴时间戳。"
      ].join("\n");
    case "flashcards":
      return [
        "输出严格 JSON（禁止包裹代码围栏），结构：",
        '{"cards":[{"front":"明确单一的考核问题","back":"精炼准确的答案（含条件/公式含义）","tags":"主题标签","timestamp":"MM:SS"}]}',
        "要求：只针对高价值易忘知识点制卡，避免同义重复，不硬凑数量。"
      ].join("\n");
    case "quiz":
      return [
        "输出严格 JSON（禁止包裹代码围栏），结构：",
        '{"questions":[{"question":"具体问题表述（禁止出现题干前缀，也禁止在题干里直接写出正确答案后再反问）","timestamp":"MM:SS","options":{"A":"选项A","B":"选项B","C":"选项C","D":"选项D"},"answer":"B","explanation":"先写为什么选B，再简要说明其他干扰项为何错"}]}',
        "要求：出 4-8 道理解/推理型单选，给出 A/B/C/D 四个同维强干扰项，严禁自问自答送分题。"
      ].join("\n");
    case "custom":
      return [
        "输出严格 JSON（禁止包裹代码围栏），结构：",
        '{"overview":"可选1句提要","sections":[{"id":"sec-1","title":"章节标题","startTime":"MM:SS","bodyMarkdown":"本节精炼Markdown正文（不在普通列表项重复贴时间戳）","keyframes":[{"timestamp":"MM:SS","caption":"关键画面"}]}]}'
      ].join("\n");
    case "study":
    default:
      return [
        "输出严格 JSON（禁止包裹代码围栏），结构：",
        '{"overview":{"coreQuestion":"本节解决什么核心矛盾或问题","takeaways":["全课高价值核心结论（1句，不含时间戳）"]},"sections":[{"id":"sec-1","title":"章节标题","startTime":"MM:SS","lead":"1-2句说明为什么引入该机制/解决什么问题（自然段，无需加前缀）","blocks":[{"type":"points","items":[{"main":"主论点/寄存器","sub":["位域/数值/因果依据1","依据2"]}]},{"type":"subsection","title":"子主题标题","startTime":"MM:SS","lead":"可选1句引入","items":["精炼要点"]},{"type":"comparison","title":"对比","headers":["维度","方案A","方案B"],"rows":[["适用场景","值A","值B"]]}],"keyframes":[{"timestamp":"MM:SS","caption":"值得配图回看的板书/电路/波形/代码演示"}]},{"id":"sec-2","title":"实操或推导示例","startTime":"MM:SS","lead":"衔接背景说明","blocks":[{"type":"derivation","title":"公式推导","startTime":"MM:SS","steps":["已知前提与方程","化简与结论"]},{"type":"code","title":"关键实现/配置","time":"MM:SS","lang":"c","code":"GPFCON &= ~(0x3 << 8);\\nGPFCON |= (0x1 << 8);","verify":"测量/验证方法"},{"type":"example","title":"典型实例","time":"MM:SS","content":"具体算例或现象说明"},{"type":"pitfall","content":"确有必要的易混边界/踩坑警告（每节最多1条）"}],"keyframes":[]}],"cheatSheet":[{"item":"公式/寄存器/专有参数","meaning":"精确位域/物理意义与成立条件（无硬核参数请输出 []）"}]}',
        "要求：每段 takeaways 限 2-4 条；按知识内容自然选用 blocks（无需每节填满所有块类型）；禁止写“介绍了某寄存器/讲解了某流程”的空洞概括，必须写出具体寄存器名、位域、数值、代码和推导关系；cheatSheet 无硬核参数时输出 []。"
      ].join("\n");
  }
}

/** Build structured cognitive note-generation prompts enforcing conciseness and dynamic visual anchors. */
export function buildStructuredNotePrompts(params: {
  templateId: TemplateId;
  task: string;
  templateLabel: string;
  videoTitle?: string;
  videoPart?: string;
  page?: number;
  pageCount?: number;
  isAudioChunk: boolean;
  chunkIndex: number;
  totalChunks: number;
  audioStart?: number;
  audioEnd?: number;
  transcriptChunk?: string;
  previousContext?: string;
  nextContext?: string;
  outline?: OutlineSectionItem[];
}): { system: string; userText: string } {
  const continuation = params.chunkIndex > 0;
  const outlineLines = (params.outline || [])
    .map((item) => `- id: "${item.id}" | title: "${item.title}"${item.startTime ? ` | startTime: "${item.startTime}"` : ""}`)
    .join("\n");

  const commonRules = [
    "你是严谨、善于提炼重点的高效课程笔记编辑，只根据课程实际讲授内容输出高信噪比中文结构化 JSON。",
    "【表达规范】彻底滤除课堂寒暄、设备确认、口头禅、自我纠正前的口误；严禁使用“老师讲解了/本视频介绍了/接下来我们看”等旁白视角词，直接陈述知识机制、因果逻辑与结论。",
    "【讲义叙事流】先说明为什么引入某概念或解决了什么矛盾（lead），再用 sub/subsection 分层展开机制、公式与代码，不要把所有内容拍平成一层流水清单；pitfall 仅在确有易混边界或踩坑时才写。",
    "【硬核细节零丢失】凡课程出现的寄存器/位域数值、时序参数、公式物理意义、代码关键语句、典型例子结论，务必落到纸面，严禁写空洞的“简介”式目录句。",
    "【清爽时间戳】普通要点/列表项内不要标注 [MM:SS]；仅在章节 startTime、关键推导/例题/代码步骤时间、以及 keyframes 上保留精确时间。",
    "【动态精准关键帧】keyframes 数量由实际视觉重点决定（0..N）：纯口述概念或无关键图示时输出 []，不要硬凑数量；若出现核心电路、公式推导完成态、架构图、对比表格或实操结果，请在对应位置输出 keyframe。务必选择板书/图示已完整呈现并总结的时刻，不要选刚开口说“下面我们看图”的瞬间。"
  ];

  if (params.isAudioChunk) {
    const start = Math.max(0, Number(params.audioStart) || 0);
    const end = Math.max(start, Number(params.audioEnd) || 0);
    commonRules.push(
      `本段音频在原视频中的绝对起始时间为 ${Keji.formatTime(start)}（+${Math.floor(start)} 秒），所有 timestamp / startTime / time 均须为叠加起始时间后的整课绝对视频时间（MM:SS）。`
    );
  } else {
    commonRules.push("时间戳必须取自文字稿中真实出现的 [MM:SS] 或 [HH:MM:SS] 范围，不得编造或把时间重置为 00:00。你只能看到文字稿，caption 只概括该时刻讲到的重点内容，不臆测未确认的画面细节。");
  }

  if (params.totalChunks > 1) {
    commonRules.push(
      continuation
        ? `当前为第 ${params.chunkIndex + 1}/${params.totalChunks} 个分段，只整理本段新增知识点并严禁复述前段内容。沿用已锁定章节时请保持相同的 section id 与 title；确属新主题再创建新节（id 建议以 c${params.chunkIndex + 1}- 开头）。`
        : `当前为第 1/${params.totalChunks} 个分段，只整理本段内容；不要预写后面尚未出场段落的总结。`
    );
  }

  commonRules.push("【数学公式防错】若 JSON 字符串中含 LaTeX 公式（如 \\frac、\\tau、\\beta），请使用合法 JSON 字符串并保持语义简洁清晰。");
  commonRules.push(schemaHintForTemplate(params.templateId, continuation));

  const userLines: string[] = [
    `视频：${params.videoTitle || "未命名视频"}`,
    `分 P：${params.videoPart || "当前分 P"}（第 ${params.page || 1}/${params.pageCount || 1} 节）`,
    `整理模板：${params.templateLabel}`,
    `整理要求：${params.task}`
  ];

  if (params.isAudioChunk) {
    const start = Math.max(0, Number(params.audioStart) || 0);
    const end = Math.max(start, Number(params.audioEnd) || 0);
    const timeRange = end > start ? `${Keji.formatTime(start)}–${Keji.formatTime(end)}` : `从 ${Keji.formatTime(start)} 起`;
    userLines.push(`音频范围：${timeRange}（第 ${params.chunkIndex + 1}/${params.totalChunks} 段）`);
    if (continuation && outlineLines) userLines.push(`已建立章节大纲（继续同主题请复用对应 id）：\n${outlineLines}`);
  } else {
    if (params.previousContext) userLines.push(`前一段末尾上下文（仅作语意衔接，不要复述）：\n${params.previousContext}`);
    if (continuation && outlineLines) userLines.push(`已建立章节大纲（继续同主题请复用对应 id）：\n${outlineLines}`);
    userLines.push(`视频原时间戳不因分段而重置。文字稿片段 ${params.chunkIndex + 1}/${params.totalChunks}：`);
    userLines.push(params.transcriptChunk || "");
    if (params.nextContext) userLines.push(`后一段开头上下文（仅作衔接，不要提前整理）：\n${params.nextContext}`);
  }

  return { system: commonRules.join("\n"), userText: userLines.filter(Boolean).join("\n\n") };
}

/** Build a lightweight whole-lesson synthesis prompt across merged multi-chunk sections. */
export function buildGlobalSynthesisPrompts(
  data: StructuredNoteData,
  meta: { title?: string; part?: string } = {}
): { system: string; userText: string } | null {
  if (data.kind === "study") {
    if (data.sections.length < 2) return null;
    const sectionDigest = data.sections.map((sec) => {
      const samplePoints: string[] = [];
      for (const block of sec.blocks) {
        if (block.type === "points") {
          for (const item of block.items.slice(0, 3)) samplePoints.push(pointItemText(item));
        } else if (block.type === "subsection") {
          samplePoints.push(block.title);
        } else if (block.type === "code" && block.title) {
          samplePoints.push(`代码:${block.title}`);
        } else if (block.type === "derivation" && block.title) {
          samplePoints.push(`推导:${block.title}`);
        }
        if (samplePoints.length >= 4) break;
      }
      return [
        `- id: "${sec.id}"`,
        `title: "${sec.title}"`,
        sec.startTime ? `startTime: "${sec.startTime}"` : "",
        sec.lead ? `lead: "${sec.lead.slice(0, 90)}"` : "",
        samplePoints.length ? `highlights: "${samplePoints.join("；").slice(0, 140)}"` : ""
      ].filter(Boolean).join(" | ");
    }).join("\n").slice(0, 2600);

    const cheatDigest = data.cheatSheet.length
      ? data.cheatSheet.slice(0, 12).map((c) => `${c.item}: ${c.meaning}`).join("\n")
      : "";

    return {
      system: [
        "你是课程笔记总编，负责在多段视频解析完成后做一次全课统合收口。",
        "前序分段可能偏重开头导入段；请你通览全课各节脉络，重新提炼真正贯穿整堂课的核心问题与 3-5 条全课关键结论，识别跨段拆散但属同一主题的节给出合并建议（若各节主题独立则 merges 输出 []）。",
        "输出严格 JSON（禁止包裹代码围栏）：",
        '{"coreQuestion":"贯穿整堂课的核心问题（1句话）","takeaways":["覆盖全课首尾的关键结论1","结论2","结论3"],"merges":[{"keepId":"sec-1","dropId":"c2-1","title":"合并后更清晰的章节标题"}],"cheatSheet":[{"item":"关键公式/寄存器/参数","meaning":"物理意义与成立条件"}]}'
      ].join("\n"),
      userText: [
        `课程：${meta.title || "未命名课程"}${meta.part ? ` · ${meta.part}` : ""}`,
        data.overview.coreQuestion ? `当前初版核心问题：${data.overview.coreQuestion}` : "",
        `全课章节摘要（共 ${data.sections.length} 节）：\n${sectionDigest}`,
        cheatDigest ? `已有速查条目：\n${cheatDigest}` : ""
      ].filter(Boolean).join("\n\n")
    };
  }

  if (data.kind === "brief") {
    if (data.takeaways.length < 2) return null;
    const digest = data.takeaways
      .map((item, i) => `${i + 1}. ${item.point}${item.detail ? `：${item.detail}` : ""}${item.time ? ` [${item.time}]` : ""}`)
      .join("\n")
      .slice(0, 2400);
    return {
      system: [
        "你是课程精简总结总编，负责把多段提炼的结果收口为连贯的一页速览。",
        "输出严格 JSON（禁止包裹代码围栏）：",
        '{"thesis":"1-2句概括贯穿整堂课的主旨","takeaways":[{"point":"核心结论短语","detail":"成立条件或依据（1句）","time":"MM:SS"}],"logicChain":["阶段1","阶段2","阶段3"]}'
      ].join("\n"),
      userText: [
        `课程：${meta.title || "未命名课程"}${meta.part ? ` · ${meta.part}` : ""}`,
        data.thesis ? `初版主旨：${data.thesis}` : "",
        `各段结论汇总：\n${digest}`,
        data.logicChain.length ? `初版脉络：${data.logicChain.join(" -> ")}` : ""
      ].filter(Boolean).join("\n\n")
    };
  }

  return null;
}

/** Apply synthesized whole-lesson overview, cross-chunk section merges, and refined cheatSheet. */
export function applyGlobalSynthesisResult(
  data: StructuredNoteData,
  rawJson: string
): StructuredNoteData {
  const obj = asObject(parseModelJson(rawJson));
  if (!obj) return data;

  if (data.kind === "study") {
    const coreQuestion = cleanText(obj.coreQuestion ?? obj.question, { stripTimestamps: true }) || data.overview.coreQuestion;
    const takeaways = normalizeStringList(obj.takeaways ?? obj.summary, { limit: 5 });

    const sections = data.sections.map((s) => ({
      ...s,
      blocks: s.blocks.map(cloneStudyBlock),
      keyframes: [...s.keyframes]
    }));
    const droppedIds = new Set<string>();
    for (const rawMerge of asArray(obj.merges)) {
      const mObj = asObject(rawMerge);
      if (!mObj) continue;
      const keepId = cleanText(mObj.keepId);
      const dropId = cleanText(mObj.dropId);
      if (!keepId || !dropId || keepId === dropId || droppedIds.has(keepId) || droppedIds.has(dropId)) continue;
      const keep = sections.find((s) => s.id === keepId);
      const drop = sections.find((s) => s.id === dropId);
      if (!keep || !drop) continue;
      if (sections.length - droppedIds.size <= 1) break;
      if (!keep.lead && drop.lead) keep.lead = drop.lead;
      if (!keep.startTime && drop.startTime) keep.startTime = drop.startTime;
      const mergedTitle = cleanHeadingTitle(mObj.title);
      if (mergedTitle) keep.title = mergedTitle;
      keep.blocks = mergeConsecutivePointBlocks([...keep.blocks, ...drop.blocks]);
      keep.keyframes = dedupeKeyframes([...keep.keyframes, ...drop.keyframes], 8);
      droppedIds.add(dropId);
    }
    const nextSections = sections.filter((s) => !droppedIds.has(s.id));

    const cheatRaw = asArray(obj.cheatSheet ?? obj.cheat_sheet);
    let nextCheatSheet = data.cheatSheet;
    if (cheatRaw.length) {
      const built: Array<{ item: string; meaning: string }> = [];
      const seen = new Set<string>();
      for (const rawRow of cheatRaw) {
        const rowObj = asObject(rawRow);
        if (!rowObj) continue;
        const item = escapeTableCell(rowObj.item ?? rowObj.term ?? rowObj.formula ?? rowObj.name);
        const meaning = escapeTableCell(rowObj.meaning ?? rowObj.definition ?? rowObj.desc ?? rowObj.description);
        const key = item.toLocaleLowerCase();
        if (!item || !meaning || seen.has(key)) continue;
        seen.add(key);
        built.push({ item, meaning });
        if (built.length >= 12) break;
      }
      if (built.length) nextCheatSheet = built;
    }

    return {
      kind: "study",
      overview: {
        coreQuestion,
        takeaways: takeaways.length ? takeaways : data.overview.takeaways
      },
      sections: nextSections.length ? nextSections : data.sections,
      cheatSheet: nextCheatSheet
    };
  }

  if (data.kind === "brief") {
    const normalized = normalizeBriefData(obj);
    if (!normalized) return data;
    return {
      kind: "brief",
      thesis: normalized.thesis || data.thesis,
      takeaways: normalized.takeaways.length ? normalized.takeaways.slice(0, 8) : data.takeaways,
      logicChain: normalized.logicChain.length ? normalized.logicChain : data.logicChain,
      keyframes: data.keyframes
    };
  }

  return data;
}

/** Compile quiz JSON response to Markdown expected by quiz parser, with Markdown fallback. */
export function compileQuizResponseToMarkdown(raw: string): string {
  const parsed = parseStructuredNoteResponse(raw, "quiz");
  if (parsed && parsed.kind === "quiz") return compileStructuredNoteToMarkdown(parsed, "quiz");
  return stripThinkAndFence(raw);
}

/** Compile flashcards JSON response into clean escaped Markdown table, with table fallback. */
export function compileFlashcardsResponseToMarkdown(raw: string): string {
  const parsed = parseStructuredNoteResponse(raw, "flashcards");
  if (parsed && parsed.kind === "flashcards") return compileStructuredNoteToMarkdown(parsed, "flashcards");
  return stripThinkAndFence(raw);
}

/** Parse discussion revision JSON (`{ summary, updatedMarkdown }`) with tag fallback. */
export function parseDiscussionReviseResponse(raw: string): { summary: string; markdown: string } | null {
  const obj = asObject(parseModelJson(raw));
  const updatedFromJson = String(obj?.updatedMarkdown ?? obj?.updated_markdown ?? obj?.markdown ?? obj?.note ?? "").trim();
  if (updatedFromJson) {
    return {
      summary: cleanText(obj?.summary ?? obj?.changeSummary ?? obj?.changes) || "已根据讨论更新笔记。",
      markdown: updatedFromJson
    };
  }
  const text = String(raw || "").trim();
  const updated = text.match(/\[\[KEJI_UPDATED_NOTE\]\]([\s\S]*?)\[\[\/KEJI_UPDATED_NOTE\]\]/)?.[1]?.trim();
  if (!updated) return null;
  const summary = text.match(/\[\[KEJI_CHANGE_SUMMARY\]\]([\s\S]*?)\[\[\/KEJI_CHANGE_SUMMARY\]\]/)?.[1]?.trim() || "已根据讨论更新笔记。";
  return { summary, markdown: updated };
}

function splitSectionsFromMarkdown(markdown: string): { preamble: string; sections: Array<{ heading: string; title: string; startSeconds: number | null; body: string }> } {
  const lines = String(markdown || "").split(/\r?\n/);
  const preambleLines: string[] = [];
  const sections: Array<{ heading: string; title: string; startSeconds: number | null; bodyLines: string[] }> = [];
  let fence: string | null = null;

  for (const line of lines) {
    const fenceLine = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceLine) {
      const marker = fenceLine[1]![0]!;
      fence = !fence ? marker : (fence === marker ? null : fence);
    }
    const h2 = !fence ? line.match(/^##\s+(.+)$/) : null;
    if (h2) {
      const title = cleanHeadingTitle(h2[1]);
      const tsMatch = h2[1]!.match(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
      sections.push({
        heading: line,
        title,
        startSeconds: tsMatch ? Keji.parseTime(tsMatch[1]!) : null,
        bodyLines: []
      });
    } else if (sections.length) {
      sections[sections.length - 1]!.bodyLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }

  return {
    preamble: preambleLines.join("\n").trim(),
    sections: sections.map((sec) => ({
      heading: sec.heading,
      title: sec.title,
      startSeconds: sec.startSeconds,
      body: sec.bodyLines.join("\n").trim()
    }))
  };
}

function cleanPlaceholderMarkers(markdown: string): string {
  return String(markdown || "")
    .replace(KEYFRAME_MARKER_PATTERN, "")
    .replace(HUMANIZED_KEYFRAME_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function applyInPlaceReplacementsToSectionBody(
  body: string,
  replacements: Array<{ wrong: string; right: string }>
): string {
  if (!body || !replacements.length) return body;
  const lines = body.split(/\r?\n/);
  let fence: string | null = null;
  const updated = lines.map((line) => {
    const fenceLine = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceLine) {
      const marker = fenceLine[1]![0]!;
      fence = !fence ? marker : (fence === marker ? null : fence);
      return line;
    }
    if (fence || /^\s*!\[[^\]]*\]\(data:image\//i.test(line)) return line;
    let current = line;
    for (const pair of replacements) {
      if (current.includes(pair.wrong)) {
        current = current.split(pair.wrong).join(pair.right);
      }
    }
    return current;
  });
  return updated.join("\n");
}

function insertBlockIntoSection(sectionBody: string, blockText: string, targetSeconds: number | null): string {
  if (!sectionBody) return blockText;
  if (targetSeconds === null || !/^###\s+/m.test(sectionBody)) {
    return `${sectionBody}\n\n${blockText}`;
  }
  const chunks = sectionBody.split(/\n(?=###\s+)/);
  if (chunks.length <= 1) return `${sectionBody}\n\n${blockText}`;
  let bestIdx = -1;
  for (let i = 0; i < chunks.length; i += 1) {
    const firstLine = chunks[i]!.split(/\r?\n/, 1)[0] || "";
    const headingMatch = firstLine.match(/^###\s+[^\n]*\[(\d{1,2}:\d{2}(?::\d{2})?)\]/);
    if (!headingMatch) continue;
    const sec = Keji.parseTime(headingMatch[1]!);
    if (sec !== null && sec <= targetSeconds + 4) bestIdx = i;
  }
  if (bestIdx < 0) return `${sectionBody}\n\n${blockText}`;
  chunks[bestIdx] = `${chunks[bestIdx]}\n\n${blockText}`;
  return chunks.join("\n");
}

/**
 * Apply structured visual patch (`keyframes` + `replacements` + `supplements`)
 * returned by vision/video models directly onto note sections without diff-log blockquote noise.
 */
export function applyVisualPatchToMarkdown(
  baseMarkdown: string,
  rawResponse: string,
  candidateFrames: KeyFrameItem[] = []
): string {
  const parsedObj = asObject(parseModelJson(rawResponse));
  if (!parsedObj) {
    // Fallback if model ignored JSON mode and wrote complete Markdown directly.
    return stripThinkAndFence(rawResponse);
  }

  const sanitizedBase = cleanPlaceholderMarkers(
    String(baseMarkdown || "").replace(CAPTURED_PLACEHOLDER_PATTERN, "")
  );
  const split = splitSectionsFromMarkdown(sanitizedBase);

  const replacements: Array<{ wrong: string; right: string }> = [];
  for (const rawRep of asArray(parsedObj.replacements ?? parsedObj.termFixes)) {
    const rObj = asObject(rawRep);
    if (!rObj) continue;
    const wrong = cleanText(rObj.wrong ?? rObj.from ?? rObj.old);
    const right = cleanText(rObj.right ?? rObj.to ?? rObj.new);
    if (wrong.length >= 2 && right && wrong !== right) {
      replacements.push({ wrong, right });
    }
  }
  if (replacements.length) {
    for (const sec of split.sections) {
      sec.body = applyInPlaceReplacementsToSectionBody(sec.body, replacements);
    }
  }

  const rawSupplements = asArray(parsedObj.supplements ?? parsedObj.corrections ?? parsedObj.fixes);
  const rawFrames = asArray(parsedObj.keyframes ?? parsedObj.selectedFrames ?? parsedObj.frames ?? parsedObj.highlights);

  const resolveSectionIndex = (sectionTitle: unknown, targetSeconds: number | null): number => {
    const cleanTarget = cleanHeadingTitle(sectionTitle);
    if (cleanTarget) {
      const byTitle = split.sections.findIndex((s) => sameOrSimilarTitle(s.title, cleanTarget));
      if (byTitle >= 0) return byTitle;
    }
    if (targetSeconds !== null && split.sections.length) {
      let bestIdx = -1;
      for (let i = 0; i < split.sections.length; i += 1) {
        const sec = split.sections[i]!;
        if (/^(?:核心提要|核心公式与速查)$/.test(sec.title)) continue;
        if (sec.startSeconds !== null && sec.startSeconds <= targetSeconds + 3) bestIdx = i;
      }
      if (bestIdx >= 0) return bestIdx;
    }
    const contentIdx = split.sections.findIndex((s) => !/^(?:核心提要|核心公式与速查)$/.test(s.title));
    return contentIdx >= 0 ? contentIdx : (split.sections.length ? split.sections.length - 1 : -1);
  };

  for (const supp of rawSupplements) {
    const cObj = asObject(supp);
    if (!cObj) continue;
    const detail = cleanText(cObj.detail ?? cObj.content ?? cObj.replacement ?? cObj.note);
    if (!detail) continue;
    const secIdx = resolveSectionIndex(cObj.sectionTitle ?? cObj.section, null);
    const line = `- **视觉补充**：${detail}`;
    if (secIdx >= 0) {
      split.sections[secIdx]!.body = insertBlockIntoSection(split.sections[secIdx]!.body, line, null);
    } else {
      split.preamble = split.preamble ? `${split.preamble}\n\n${line}` : line;
    }
  }

  const normalizedAdditions: Array<{ timestamp: string; seconds: number; caption: string; boardSupplement: string; sectionTitle: string }> = [];
  for (const rawItem of rawFrames) {
    const fObj = asObject(rawItem);
    if (!fObj) continue;
    let resolvedTs = normalizeTimestampLabel(fObj.timestamp ?? fObj.time);
    const candidateIdx = Number(fObj.candidateIndex ?? fObj.frameIndex ?? fObj.index);
    if (candidateFrames.length) {
      if (Number.isInteger(candidateIdx) && candidateIdx >= 1 && candidateIdx <= candidateFrames.length) {
        resolvedTs = candidateFrames[candidateIdx - 1]!.timestamp;
      } else if (resolvedTs) {
        const targetSec = Keji.parseTime(resolvedTs);
        if (targetSec !== null) {
          let nearest: KeyFrameItem | null = null;
          let minDiff = 4.5;
          for (const candidate of candidateFrames) {
            const diff = Math.abs(candidate.seconds - targetSec);
            if (diff <= minDiff) {
              minDiff = diff;
              nearest = candidate;
            }
          }
          if (nearest) resolvedTs = nearest.timestamp;
        }
      }
    }
    const secVal = Keji.parseTime(resolvedTs);
    const caption = sanitizeCaption(fObj.caption ?? fObj.label ?? fObj.value ?? fObj.title);
    if (!resolvedTs || secVal === null || !caption) continue;
    normalizedAdditions.push({
      timestamp: resolvedTs,
      seconds: secVal,
      caption,
      boardSupplement: cleanText(fObj.boardSupplement ?? fObj.boardNotes ?? fObj.visualDetail),
      sectionTitle: cleanText(fObj.sectionTitle ?? fObj.section)
    });
  }

  normalizedAdditions.sort((a, b) => a.seconds - b.seconds);
  const keptAdditions: typeof normalizedAdditions = [];
  for (const item of normalizedAdditions) {
    const prev = keptAdditions[keptAdditions.length - 1];
    if (prev && item.seconds - prev.seconds < 8) {
      if (item.caption.length + item.boardSupplement.length > prev.caption.length + prev.boardSupplement.length) {
        keptAdditions[keptAdditions.length - 1] = item;
      }
      continue;
    }
    keptAdditions.push(item);
  }

  for (const item of keptAdditions) {
    const secIdx = resolveSectionIndex(item.sectionTitle, item.seconds);
    const pieces = [
      item.boardSupplement ? `- **板书补充（${item.timestamp}）**：${item.boardSupplement}` : "",
      `[[KEYFRAME: ${item.timestamp} | ${item.caption}]]`
    ].filter(Boolean).join("\n\n");
    if (secIdx >= 0) {
      split.sections[secIdx]!.body = insertBlockIntoSection(split.sections[secIdx]!.body, pieces, item.seconds);
    } else {
      split.preamble = split.preamble ? `${split.preamble}\n\n${pieces}` : pieces;
    }
  }

  const rebuilt: string[] = [];
  if (split.preamble) rebuilt.push(split.preamble);
  for (const sec of split.sections) {
    rebuilt.push(sec.body ? `${sec.heading}\n\n${sec.body}` : sec.heading);
  }
  return rebuilt.join("\n\n").trim();
}

/**
 * Apply JSON visual review onto an existing note that already holds captured `[视频关键帧：...]` placeholders.
 */
export function applyVisualFrameReviewToMarkdown(
  baseMarkdown: string,
  frames: KeyFrameItem[],
  rawResponse: string
): string {
  const parsedObj = asObject(parseModelJson(rawResponse));
  if (!parsedObj) return stripThinkAndFence(rawResponse);

  let output = String(baseMarkdown || "");
  for (const item of asArray(parsedObj.frameUpdates ?? parsedObj.keyframes ?? parsedObj.frames)) {
    const fObj = asObject(item);
    if (!fObj) continue;
    const idx = Number(fObj.frameIndex ?? fObj.index);
    const frame = (Number.isInteger(idx) && idx >= 1 && idx <= frames.length)
      ? frames[idx - 1]
      : frames.find((f) => normalizeTimestampLabel(f.timestamp) === normalizeTimestampLabel(fObj.timestamp));
    if (!frame) continue;
    const alt = `${frame.caption} · ${frame.timestamp}`.replace(/[\[\]]/g, "");
    const placeholder = `[视频关键帧：${alt}]`;
    if (fObj.keep === false) {
      output = output.replace(new RegExp(`(?:>\\s*\\*\\*画面要点\\s*·[^\\n]*\\n+)?\\s*${placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), "");
      continue;
    }
    const boardSupplement = cleanText(fObj.boardSupplement ?? fObj.boardNotes);
    if (boardSupplement && output.includes(placeholder)) {
      output = output.replace(placeholder, `${placeholder}\n\n- **板书补充（${frame.timestamp}）**：${boardSupplement}`);
    }
  }

  const split = splitSectionsFromMarkdown(output);
  const replacements: Array<{ wrong: string; right: string }> = [];
  for (const rawRep of asArray(parsedObj.replacements ?? parsedObj.termFixes)) {
    const rObj = asObject(rawRep);
    if (!rObj) continue;
    const wrong = cleanText(rObj.wrong ?? rObj.from ?? rObj.old);
    const right = cleanText(rObj.right ?? rObj.to ?? rObj.new);
    if (wrong.length >= 2 && right && wrong !== right) {
      replacements.push({ wrong, right });
    }
  }
  if (replacements.length) {
    for (const sec of split.sections) {
      sec.body = applyInPlaceReplacementsToSectionBody(sec.body, replacements);
    }
  }

  for (const corr of asArray(parsedObj.supplements ?? parsedObj.corrections ?? parsedObj.fixes)) {
    const cObj = asObject(corr);
    if (!cObj) continue;
    const detail = cleanText(cObj.detail ?? cObj.content);
    if (!detail) continue;
    const targetTitle = cleanHeadingTitle(cObj.sectionTitle ?? cObj.section);
    const secIdx = targetTitle ? split.sections.findIndex((s) => sameOrSimilarTitle(s.title, targetTitle)) : -1;
    const line = `- **视觉补充**：${detail}`;
    if (secIdx >= 0) {
      split.sections[secIdx]!.body = insertBlockIntoSection(split.sections[secIdx]!.body, line, null);
    } else {
      split.preamble = split.preamble ? `${split.preamble}\n\n${line}` : line;
    }
  }

  const rebuilt: string[] = [];
  if (split.preamble) rebuilt.push(split.preamble);
  for (const sec of split.sections) {
    rebuilt.push(sec.body ? `${sec.heading}\n\n${sec.body}` : sec.heading);
  }
  return rebuilt.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function parseTranscriptCues(transcript: string): Array<{ seconds: number; text: string }> {
  const cues: Array<{ seconds: number; text: string }> = [];
  for (const line of String(transcript || "").split(/\r?\n/)) {
    const m = line.match(/^\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+)$/);
    if (!m) continue;
    const sec = Keji.parseTime(m[1]!);
    if (sec === null || !Number.isFinite(sec)) continue;
    cues.push({ seconds: sec, text: m[2]!.trim() });
  }
  return cues.sort((a, b) => a.seconds - b.seconds);
}

/** Shift early spoken-start timestamps slightly forward to steady visual-board moments using transcript cues. */
export function refineKeyframeTargetsWithTranscript<T extends { timestamp: string; seconds: number; caption: string }>(
  targets: T[],
  transcript: string,
  duration = 0
): T[] {
  if (!Array.isArray(targets) || !targets.length) return [];
  const cues = parseTranscriptCues(transcript);
  if (!cues.length) return targets;

  const openerPattern = /(?:下面|接下来|现在|我们来看|画一下|看(?:看|一下)?这|来看下|写一下|算一下|打开|切换到|演示一下)/;
  const completedPattern = /(?:如图所示|如下图所示|可以看到|这就完成|总结成|最终得到|看这里|这条曲线|这个电路图|波形如下|输出结果)/;
  const maxEnd = duration > 1 ? duration - 0.5 : Number.POSITIVE_INFINITY;

  return targets.map((target, idx) => {
    const baseSec = Number(target.seconds) || 0;
    const nextCap = idx + 1 < targets.length ? Math.max(baseSec + 1, targets[idx + 1]!.seconds - 2) : maxEnd;
    const ceiling = Math.min(baseSec + 8, maxEnd, nextCap);
    if (ceiling <= baseSec + 1.5) return target;

    const nearCue = cues.find((c) => Math.abs(c.seconds - baseSec) <= 1.5);
    if (!nearCue || !openerPattern.test(nearCue.text) || completedPattern.test(nearCue.text)) {
      return target;
    }

    const laterCues = cues.filter((c) => c.seconds >= baseSec + 1.5 && c.seconds <= ceiling);
    if (!laterCues.length) return target;

    const settledCue = laterCues.find((c) => completedPattern.test(c.text))
      || laterCues[Math.min(laterCues.length - 1, 1)]!;
    const refinedSeconds = Math.min(ceiling, Math.max(baseSec + 1.5, Math.round(settledCue.seconds)));
    return {
      ...target,
      seconds: refinedSeconds,
      timestamp: Keji.formatTime(refinedSeconds)
    };
  });
}

/** Plan anchor-guided candidate timestamps rather than blind uniform intervals for vision frame selection. */
export function planVisualCandidateTimes(
  duration: number,
  transcript: string,
  markdown: string,
  maxCount = 24
): number[] {
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds < 10) return [];
  const limit = Math.max(4, Math.min(28, Math.floor(Number(maxCount) || 24)));
  const count = Math.min(limit, Math.max(8, Math.ceil(seconds / 75)));
  const end = Math.max(1, seconds - 1);

  const priorityAnchors: Array<{ time: number; priority: number }> = [];
  for (const m of String(markdown || "").matchAll(KEYFRAME_MARKER_PATTERN)) {
    const t = Keji.parseTime(m[1]!);
    if (t !== null && t >= 0 && t <= end) {
      priorityAnchors.push({ time: Math.min(end, t + 1.5), priority: 100 });
      priorityAnchors.push({ time: Math.min(end, t + 4.5), priority: 95 });
    }
  }

  const visualCuePattern = /图|表|公式|推导|电路|波形|架构|流程|代码|终端|运行|面板|寄存器|矩阵|曲线|框图|板书|ppt|slide|demo|如图所示|如下图所示|屏幕/i;
  for (const cue of parseTranscriptCues(transcript)) {
    if (cue.seconds <= end && visualCuePattern.test(cue.text)) {
      priorityAnchors.push({ time: Math.min(end, cue.seconds + 2.5), priority: 80 });
    }
  }

  for (const m of String(markdown || "").matchAll(/^##\s+[^\n]*\[(\d{1,2}:\d{2}(?::\d{2})?)\]/gm)) {
    const t = Keji.parseTime(m[1]!);
    if (t !== null && t >= 0 && t <= end) {
      priorityAnchors.push({ time: Math.min(end, t + 4), priority: 70 });
    }
  }

  priorityAnchors.sort((a, b) => b.priority - a.priority || a.time - b.time);
  const candidates: number[] = [];
  const addCandidate = (value: number) => {
    const sec = Math.min(end, Math.max(0, Math.floor(value)));
    if (candidates.every((c) => Math.abs(c - sec) >= 4)) {
      candidates.push(sec);
      return true;
    }
    return false;
  };

  for (const anchor of priorityAnchors) {
    if (candidates.length >= Math.floor(count * 0.78)) break;
    addCandidate(anchor.time);
  }

  while (candidates.length < count) {
    const ordered = [0, ...candidates].sort((a, b) => a - b);
    ordered.push(end);
    let largestGap = 0;
    let midpoint: number | null = null;
    for (let i = 1; i < ordered.length; i += 1) {
      const gap = ordered[i]! - ordered[i - 1]!;
      if (gap > largestGap) {
        largestGap = gap;
        midpoint = (ordered[i]! + ordered[i - 1]!) / 2;
      }
    }
    if (midpoint === null || largestGap < 12) break;
    if (!addCandidate(midpoint)) break;
  }

  return candidates.sort((a, b) => a - b).slice(0, count);
}

/** Score an RGBA image buffer for edge detail and detect blank/fade transition frames. */
export function scoreRgbaFrameQuality(
  rgba: ArrayLike<number>,
  width: number,
  height: number
): { score: number; isBlankOrFade: boolean; edgeDensity: number } {
  const w = Math.max(4, Math.floor(width));
  const h = Math.max(4, Math.floor(height));
  const x0 = Math.max(0, Math.floor(w * 0.1));
  const x1 = Math.min(w - 1, Math.floor(w * 0.9));
  const y0 = Math.max(0, Math.floor(h * 0.1));
  const y1 = Math.min(h - 1, Math.floor(h * 0.9));

  const lumaAt = (x: number, y: number): number => {
    const idx = (y * w + x) * 4;
    if (idx + 2 >= rgba.length) return 0;
    return 0.299 * rgba[idx]! + 0.587 * rgba[idx + 1]! + 0.114 * rgba[idx + 2]!;
  };

  const step = w > 64 ? 3 : 1;
  let samples = 0;
  let sumLuma = 0;
  let sumSq = 0;
  let edgeSum = 0;

  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const l = lumaAt(x, y);
      const lx = lumaAt(x + 1, y);
      const ly = lumaAt(x, y + 1);
      samples += 1;
      sumLuma += l;
      sumSq += l * l;
      edgeSum += Math.abs(lx - l) + Math.abs(ly - l);
    }
  }

  if (!samples) return { score: 0, isBlankOrFade: true, edgeDensity: 0 };
  const meanLuma = sumLuma / samples;
  const variance = Math.max(0, sumSq / samples - meanLuma * meanLuma);
  const edgeDensity = edgeSum / samples;
  const isBlankOrFade = variance < 65 || meanLuma < 14 || meanLuma > 246;
  const rawScore = edgeDensity * 2 + Math.sqrt(variance) * 0.6;
  const score = isBlankOrFade ? rawScore * 0.1 : rawScore;
  return { score, isBlankOrFade, edgeDensity };
}
