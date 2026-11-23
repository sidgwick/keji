import { Keji, type TranscriptSegment } from "./keji.ts";

interface SelectedTranscriptRange {
  start: number;
  end: number;
  replaceStart: number;
  replaceEnd: number;
  suffix: string;
  firstTime: number;
  lastTime: number;
}

export function transcriptToSrt(
  transcript: string,
  durationSeconds = 0
): { srt: string; cueCount: number; unmatchedLines: number } {
  const entries: Array<{ start: number; text: string[] }> = [];
  let current: { start: number; text: string[] } | null = null;
  let unmatchedLines = 0;
  for (const line of String(transcript || "").split(/\r?\n/)) {
    const cue = line.match(/^\s*\[(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)\]\s*(.*)$/);
    if (cue) {
      if (current?.text.length) entries.push(current);
      const seconds = Keji.parseTime(cue[1]!);
      if (seconds === null) {
        current = null;
        unmatchedLines += 1;
        continue;
      }
      current = { start: Math.round(seconds * 1000), text: cue[2]!.trim() ? [cue[2]!.trim()] : [] };
    } else if (current) {
      if (line.trim()) current.text.push(line.trim());
    } else if (line.trim()) unmatchedLines += 1;
  }
  if (current?.text.length) entries.push(current);
  const format = (value: number) => {
    const total = Math.max(0, Math.floor(value));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
  };
  const output = entries.map((entry, index) => {
    const nextStart = entries[index + 1]?.start;
    const videoEnd = Math.round(Number(durationSeconds) * 1000);
    const suggestedEnd = nextStart ?? (videoEnd > entry.start ? Math.min(videoEnd, entry.start + 10000) : entry.start + 5000);
    const end = Math.max(entry.start + 1000, Math.min(suggestedEnd, entry.start + 10000));
    return `${index + 1}\n${format(entry.start)} --> ${format(end)}\n${entry.text.join("\n")}`;
  }).join("\n\n");
  return { srt: output ? `${output}\n` : "", cueCount: entries.length, unmatchedLines };
}

export function normalizeTranscriptFile(
  source: string,
  filename = ""
): { format: "text" | "srt" | "vtt"; transcript: string; cueCount: number } {
  const text = String(source || "").replace(/^\uFEFF/, "");
  const extension = (String(filename).split(".").pop() || "").toLowerCase();
  const hasCueTiming = /(?:^|\n)\s*\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\s*-->\s*\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?/m.test(text);
  if (!hasCueTiming) return { format: "text", transcript: text.trim(), cueCount: 0 };

  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  const decodeEntities = (value: string) => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
    const lower = code.toLowerCase();
    if (Object.hasOwn(named, lower)) return named[lower]!;
    const number = lower[1] === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    try { return Number.isFinite(number) ? String.fromCodePoint(number) : entity; } catch { return entity; }
  });

  const cues: Array<{ start: number; text: string[] }> = [];
  let current: { start: number; text: string[] } | null = null;
  let ignoredBlock = false;
  for (const originalLine of text.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line) {
      if (current?.text.length) cues.push(current);
      current = null;
      ignoredBlock = false;
      continue;
    }
    if (/^(?:WEBVTT\b|NOTE\b|STYLE\b|REGION\b|X-TIMESTAMP-MAP\b)/i.test(line)) {
      ignoredBlock = true;
      continue;
    }
    if (ignoredBlock) continue;
    const timing = line.match(/^((?:\d{1,3}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?)/);
    if (timing) {
      if (current?.text.length) cues.push(current);
      const start = Keji.parseTime(timing[1]!);
      current = start === null ? null : { start, text: [] };
      continue;
    }
    if (!current) continue;
    const clean = decodeEntities(line
      .replace(/<v(?:\s+([^>]+))?>/gi, (_tag, speaker: string) => speaker ? `${speaker}: ` : "")
      .replace(/<\/v>/gi, "")
      .replace(/<[^>]*>/g, "")).trim();
    if (clean) current.text.push(clean);
  }
  if (current?.text.length) cues.push(current);
  const transcript = cues.map((cue) => `[${Keji.formatTime(cue.start)}] ${cue.text.join(" ")}`).join("\n");
  return { format: extension === "vtt" || /^\s*WEBVTT\b/m.test(text) ? "vtt" : "srt", transcript, cueCount: cues.length };
}

export function summarizeTranscriptionLanguageRanges(segments?: TranscriptSegment[]): string[] {
  const ranges: Array<{ language: string; start: number; end: number }> = [];
  for (const segment of [...(Array.isArray(segments) ? segments : [])].sort((a, b) => a.time - b.time)) {
    const language = String(segment.language || "").trim();
    if (!language) continue;
    const time = Math.max(0, Number(segment.time) || 0);
    const end = Math.max(time, Number(segment.end) || time);
    const current = ranges.at(-1);
    if (current?.language === language) current.end = Math.max(current.end, end);
    else ranges.push({ language, start: time, end });
  }
  const summary = ranges.slice(0, 4).map((range) =>
    `${range.language} ${Keji.formatTime(range.start)}–${Keji.formatTime(range.end)}`
  );
  if (ranges.length > 4) summary.push(`另有 ${ranges.length - 4} 段语言区间`);
  return summary;
}

export function resolveSelectedTranscriptTimeRange(
  transcript: string,
  selectionStart: number,
  selectionEnd: number,
  segments: TranscriptSegment[] = []
): SelectedTranscriptRange {
  if (selectionStart === selectionEnd) {
    throw new Error("请先在文字稿中选中一条或多条带时间戳的文字。");
  }
  const timedLines: Array<{ start: number; end: number; time: number; text: string }> = [];
  let offset = 0;
  for (const line of String(transcript || "").split("\n")) {
    const lineEnd = offset + line.length;
    const match = line.match(/^\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/);
    const time = match ? Keji.parseTime(match[1]!) : null;
    if (match && time !== null) timedLines.push({ start: offset, end: lineEnd, time, text: match[2]! });
    offset = lineEnd + 1;
  }
  const lines = timedLines.filter((line) => line.start < selectionEnd && line.end > selectionStart);
  if (!lines.length) {
    throw new Error("所选内容没有带时间戳，请选中带 [时间] 的整行。");
  }
  const first = lines[0]!;
  const last = lines.at(-1)!;
  const start = first.time;
  const validSegments = (Array.isArray(segments) ? segments : []).filter((segment) => Number.isFinite(Number(segment.time)));
  const selectedSegments = validSegments.filter((segment) => {
    const time = Number(segment.time);
    return time >= first.time - 1.5 && time <= last.time + 1.5;
  });
  const lastSegment = selectedSegments.at(-1);
  const nextLine = timedLines.find((line) => line.time > last.time + 0.5);
  const inferredEnd = Number(lastSegment?.end) || nextLine?.time || last.time + 5;
  const end = Math.max(last.time + 1, inferredEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("无法确定所选片段的音频时间范围。");
  }
  const replaceStart = first.start;
  let replaceEnd = last.end;
  if (replaceEnd < transcript.length && transcript[replaceEnd] === "\n") replaceEnd += 1;
  const suffix = replaceEnd < transcript.length ? "\n" : "";
  return { start, end, replaceStart, replaceEnd, suffix, firstTime: first.time, lastTime: last.time };
}
