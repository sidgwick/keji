import { Keji, type TranscriptSegment } from "./keji.ts";

export interface AsrEndpointSettings {
  endpoint: string;
  model: string;
  apiKey?: string;
  prompt?: string;
}

export interface AsrResponse {
  text: string;
  language: string;
  raw: string;
  protocol: "Ollama /api/chat" | "OpenAI /chat/completions";
}

interface SpeechChunkPlan {
  start: number;
  end: number;
  padPrev: boolean;
  padNext: boolean;
}

function roundSeconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text || "") : ""))
      .join("");
  }
  return "";
}

export function estimateAsrMaxTokens(durationSec: number): number {
  const seconds = Math.max(1, Number(durationSec) || 1);
  return Math.max(96, Math.min(1024, Math.ceil(seconds * 12)));
}

function findWindowRmsSplit(
  channels: Float32Array[],
  sampleRate: number,
  minSec: number,
  maxSec: number
): number {
  const targetDefault = minSec + (maxSec - minSec) * 0.7;
  const channelLength = channels[0]?.length || 0;
  const step = Math.max(1, Math.floor(sampleRate * 0.1));
  const startSample = Math.max(0, Math.floor(minSec * sampleRate));
  const endSample = Math.min(channelLength, Math.floor(maxSec * sampleRate));
  if (endSample <= startSample) return targetDefault;
  let bestTime = targetDefault;
  let bestEnergy = Infinity;
  for (let sample = startSample; sample <= endSample; sample += step) {
    const windowEnd = Math.min(channelLength, sample + step);
    let sumSq = 0;
    let count = 0;
    for (let i = sample; i < windowEnd; i += 4) {
      let mono = 0;
      for (let c = 0; c < channels.length; c += 1) mono += channels[c]![i] || 0;
      mono /= channels.length;
      sumSq += mono * mono;
      count += 1;
    }
    const energy = count ? sumSq / count : Infinity;
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestTime = sample / sampleRate;
    }
  }
  return Math.max(minSec, Math.min(maxSec, bestTime));
}

export function planSpeechChunks(
  channels: Float32Array[],
  sampleRate: number,
  duration: number
): SpeechChunkPlan[] {
  if (!Number.isFinite(duration) || duration <= 0 || !channels.length || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return [];
  }
  const channelLen = Math.min(channels[0]?.length || 0, Math.ceil(duration * sampleRate)) || (channels[0]?.length || 0);
  if (channelLen <= 0) {
    return [{ start: 0, end: roundSeconds(duration), padPrev: false, padNext: false }];
  }

  const frameSec = 0.05;
  const frameSamples = Math.max(1, Math.floor(sampleRate * frameSec));
  const totalFrames = Math.max(1, Math.ceil(channelLen / frameSamples));
  const rms = new Float32Array(totalFrames);
  for (let f = 0; f < totalFrames; f += 1) {
    const frameStart = f * frameSamples;
    const frameEnd = Math.min(channelLen, frameStart + frameSamples);
    let sumSq = 0;
    let count = 0;
    for (let s = frameStart; s < frameEnd; s += 4) {
      let mono = 0;
      for (let c = 0; c < channels.length; c += 1) mono += channels[c]![s] || 0;
      mono /= channels.length;
      sumSq += mono * mono;
      count += 1;
    }
    rms[f] = count ? Math.sqrt(sumSq / count) : 0;
  }

  const sampleStride = Math.max(1, Math.floor(totalFrames / 10000));
  const sampled: number[] = [];
  for (let f = 0; f < totalFrames; f += sampleStride) sampled.push(rms[f]!);
  sampled.sort((a, b) => a - b);
  const p10 = sampled[Math.floor((sampled.length - 1) * 0.1)] || 0;
  const p85 = sampled[Math.floor((sampled.length - 1) * 0.85)] || 0;
  const hasClearSilence = p85 > Math.max(0.002, p10 * 2.0);

  let regions: Array<{ start: number; end: number }> = [];
  if (!hasClearSilence) {
    regions = [{ start: 0, end: duration }];
  } else {
    const threshold = Math.min(
      p85 * 0.6,
      Math.max(Math.min(0.004, p85 * 0.25), p10 * 2.0, p10 + (p85 - p10) * 0.14)
    );
    const active = new Uint8Array(totalFrames);
    for (let f = 0; f < totalFrames; f += 1) {
      if (rms[f]! >= threshold) active[f] = 1;
    }

    // Bridge short breathing pauses (< 0.45s = 9 frames) inside speech.
    let i = 0;
    while (i < totalFrames) {
      if (active[i]) {
        i += 1;
        continue;
      }
      const gapStart = i;
      while (i < totalFrames && !active[i]) i += 1;
      if (gapStart > 0 && i < totalFrames && i - gapStart < 9) {
        active.fill(1, gapStart, i);
      }
    }

    // Drop brief isolated clicks/spikes (< 0.25s = 5 frames) and pad speech bounds by 0.2s.
    const padSec = 0.2;
    i = 0;
    while (i < totalFrames) {
      if (!active[i]) {
        i += 1;
        continue;
      }
      const runStart = i;
      while (i < totalFrames && active[i]) i += 1;
      if (i - runStart < 5) continue;
      const start = Math.max(0, runStart * frameSec - padSec);
      const end = Math.min(duration, i * frameSec + padSec);
      const prev = regions.at(-1);
      if (prev && start <= prev.end + 0.01) {
        prev.end = Math.max(prev.end, end);
      } else {
        regions.push({ start, end });
      }
    }
    if (!regions.length) regions = [{ start: 0, end: duration }];
  }

  // Coalesce adjacent segments within 1.2s pause if combined duration stays <= 15s.
  const merged: Array<{ start: number; end: number }> = [];
  for (const region of regions) {
    const prev = merged.at(-1);
    if (prev && region.start - prev.end <= 1.2 && region.end - prev.start <= 15) {
      prev.end = Math.max(prev.end, region.end);
    } else {
      merged.push({ start: region.start, end: region.end });
    }
  }

  const maxChunkSec = 18;
  const minSplitSec = 10;
  const minTailSec = 4;
  const plan: SpeechChunkPlan[] = [];
  for (const region of merged) {
    let cursor = region.start;
    let isFirstPiece = true;
    while (region.end - cursor > maxChunkSec) {
      const searchMin = Math.min(region.end - minTailSec, cursor + minSplitSec);
      const searchMax = Math.min(region.end - minTailSec, cursor + maxChunkSec);
      const splitAt = searchMax > searchMin
        ? findWindowRmsSplit(channels, sampleRate, searchMin, searchMax)
        : Math.min(region.end, cursor + maxChunkSec);
      const safeEnd = Math.max(cursor + 1, Math.min(region.end, splitAt));
      const continues = safeEnd < region.end - 0.05;
      plan.push({
        start: roundSeconds(cursor),
        end: roundSeconds(safeEnd),
        padPrev: !isFirstPiece,
        padNext: continues,
      });
      cursor = safeEnd;
      isFirstPiece = false;
    }
    if (region.end - cursor > 0.05) {
      plan.push({
        start: roundSeconds(cursor),
        end: roundSeconds(region.end),
        padPrev: !isFirstPiece,
        padNext: false,
      });
    }
  }
  return plan.length
    ? plan
    : [{ start: 0, end: roundSeconds(duration), padPrev: false, padNext: false }];
}

function spokenWeight(input: string): number {
  let weight = 0;
  const cjk = input.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  if (cjk) weight += cjk.length;
  const nonCjk = input.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, " ");
  const words = nonCjk.match(/[A-Za-z0-9]+(?:[._'/-][A-Za-z0-9]+)*/g);
  if (words) weight += words.length * 1.4;
  return weight;
}

function joinClauses(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return /[A-Za-z0-9.!?]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? `${a} ${b}` : `${a}${b}`;
}

function splitIntoSentences(clean: string): string[] {
  const closing = new Set(["”", "’", "」", "』", "）", ")"]);
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i]!;
    if (ch === "。" || ch === "！" || ch === "？" || ch === "；") {
      i += 1;
      while (i < clean.length && /[。！？；]/.test(clean[i]!)) i += 1;
      while (i < clean.length && closing.has(clean[i]!)) i += 1;
      const part = clean.slice(start, i).trim();
      if (part) out.push(part);
      while (i < clean.length && clean[i] === " ") i += 1;
      start = i;
      continue;
    }
    if (ch === "!" || ch === "?") {
      let j = i + 1;
      while (j < clean.length && (clean[j] === "!" || clean[j] === "?")) j += 1;
      while (j < clean.length && closing.has(clean[j]!)) j += 1;
      if (j === clean.length || clean[j] === " ") {
        const part = clean.slice(start, j).trim();
        if (part) out.push(part);
        i = j;
        while (i < clean.length && clean[i] === " ") i += 1;
        start = i;
        continue;
      }
    }
    if (ch === ".") {
      const prev = i > 0 ? clean[i - 1]! : "";
      const next = i + 1 < clean.length ? clean[i + 1]! : "";
      const isEllipsis = prev === "." || next === ".";
      const isVersionOrNumber = /\d/.test(next) || (/[A-Za-z0-9]/.test(next));
      const isInitialism = i >= 2 && clean[i - 2] === "." && /[A-Za-z]/.test(prev);
      if (!isEllipsis && !isVersionOrNumber && !isInitialism) {
        let j = i + 1;
        while (j < clean.length && closing.has(clean[j]!)) j += 1;
        if (j === clean.length || clean[j] === " ") {
          const part = clean.slice(start, j).trim();
          if (part) out.push(part);
          i = j;
          while (i < clean.length && clean[i] === " ") i += 1;
          start = i;
          continue;
        }
      }
    }
    i += 1;
  }
  const tail = clean.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function splitLongClause(clause: string): string[] {
  const totalWeight = spokenWeight(clause);
  if (totalWeight <= 42) return [clause];
  const commaPositions: number[] = [];
  for (let i = 0; i < clause.length; i += 1) {
    if (/[，,、：:]/.test(clause[i]!)) commaPositions.push(i + 1);
  }
  let bestSplit = -1;
  let bestDiff = Infinity;
  const targetWeight = totalWeight / 2;
  for (const pos of commaPositions) {
    const left = clause.slice(0, pos).trim();
    const right = clause.slice(pos).trim();
    const leftWeight = spokenWeight(left);
    const rightWeight = spokenWeight(right);
    if (leftWeight < 16 || rightWeight < 16) continue;
    const diff = Math.abs(leftWeight - targetWeight);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestSplit = pos;
    }
  }
  if (bestSplit <= 0) return [clause];
  const left = clause.slice(0, bestSplit).trim();
  const right = clause.slice(bestSplit).trim();
  return [...splitLongClause(left), ...splitLongClause(right)];
}

export function splitTextToTimedSegments(
  text: string,
  start: number,
  end: number,
  language = ""
): TranscriptSegment[] {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const s = Math.max(0, Number(start) || 0);
  const e = Math.max(s, Number(end) || s);
  const duration = e - s;
  const totalWeight = spokenWeight(clean);
  if (duration <= 4 || totalWeight < 20) {
    return [{ time: roundSeconds(s), end: roundSeconds(e), text: clean, ...(language ? { language } : {}) }];
  }

  const rawSentences = splitIntoSentences(clean);
  const merged: string[] = [];
  for (const sentence of rawSentences) {
    if (merged.length && spokenWeight(merged.at(-1)!) < 8) {
      merged[merged.length - 1] = joinClauses(merged.at(-1)!, sentence);
    } else if (merged.length && spokenWeight(sentence) < 8) {
      merged[merged.length - 1] = joinClauses(merged.at(-1)!, sentence);
    } else {
      merged.push(sentence);
    }
  }

  const preliminaryTotal = merged.reduce((sum, piece) => sum + spokenWeight(piece), 0) || totalWeight;
  const pieces: string[] = [];
  for (const piece of merged) {
    const w = spokenWeight(piece);
    const estDuration = preliminaryTotal > 0 ? duration * (w / preliminaryTotal) : duration;
    if (w > 42 && estDuration > 8) {
      pieces.push(...splitLongClause(piece));
    } else {
      pieces.push(piece);
    }
  }

  if (pieces.length <= 1) {
    return [{ time: roundSeconds(s), end: roundSeconds(e), text: pieces[0] || clean, ...(language ? { language } : {}) }];
  }

  const weights = pieces.map((piece) => spokenWeight(piece));
  const weightSum = weights.reduce((sum, w) => sum + w, 0) || pieces.length;
  const segments: TranscriptSegment[] = [];
  let cursor = s;
  for (let idx = 0; idx < pieces.length; idx += 1) {
    const segStart = idx === 0 ? s : cursor;
    const ratio = weights.reduce((sum, w) => sum + w, 0) > 0 ? (weights[idx]! / weightSum) : (1 / pieces.length);
    const segEnd = idx === pieces.length - 1 ? e : Math.min(e, segStart + duration * ratio);
    segments.push({
      time: roundSeconds(segStart),
      end: roundSeconds(Math.max(segStart, segEnd)),
      text: pieces[idx]!,
      ...(language ? { language } : {}),
    });
    cursor = segEnd;
  }
  return segments;
}

export function createSilentTestWav(durationSec = 0.5, sampleRate = 16000): Uint8Array {
  const frameCount = Math.max(1, Math.round(durationSec * sampleRate));
  const dataBytes = frameCount * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

export async function requestAsr(
  wavBytes: Uint8Array,
  settings: AsrEndpointSettings,
  signal?: AbortSignal,
  options?: { maxTokens?: number }
): Promise<AsrResponse> {
  const base64Wav = Keji.bytesToBase64(wavBytes);
  const prompt = Keji.normalizeTranscriptionPrompt(settings.prompt);
  const isOllamaNative = /\/api\/chat$/i.test(settings.endpoint);
  const maxTokens = options?.maxTokens && Number.isFinite(options.maxTokens)
    ? Math.max(32, Math.floor(options.maxTokens))
    : 0;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

  const body = isOllamaNative
    ? {
      model: settings.model,
      stream: false,
      keep_alive: "10m",
      options: {
        temperature: 0,
        ...(maxTokens ? { num_predict: maxTokens } : {}),
      },
      messages: [
        ...(prompt ? [{ role: "system", content: prompt }] : []),
        { role: "user", content: "", images: [base64Wav] }
      ]
    }
    : {
      model: settings.model,
      stream: false,
      temperature: 0,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: [
        ...(prompt ? [{ role: "system", content: prompt }] : []),
        {
          role: "user",
          content: [{
            type: "input_audio",
            input_audio: /aliyuncs\.com/i.test(settings.endpoint)
              ? { data: `data:audio/wav;base64,${base64Wav}` }
              : { data: base64Wav, format: "wav" }
          }]
        }
      ]
    };

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  });
  const result = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok) {
    if (response.status === 403 && /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/|$)/i.test(settings.endpoint)) {
      throw new Error("Ollama 拒绝了浏览器扩展请求（HTTP 403）。请设置环境变量 OLLAMA_ORIGINS=* 后重启 Ollama。");
    }
    const detail = result?.error?.message || (typeof result?.error === "string" ? result.error : "") || result?.message || `HTTP ${response.status}`;
    throw new Error(`语音识别接口错误：${detail}`);
  }
  if (!result || typeof result !== "object") throw new Error("服务返回了无效的 JSON 响应。");
  if (result.error) {
    const detail = result.error?.message || (typeof result.error === "string" ? result.error : "");
    if (detail) throw new Error(`语音识别接口错误：${detail}`);
  }

  let rawText = "";
  if (isOllamaNative) {
    if (!result.message || typeof result.message !== "object") {
      throw new Error("服务已响应，但返回格式不符合预期（缺少 message 或 choices 字段）。");
    }
    rawText = extractMessageText(result.message.content);
  } else {
    if (!Array.isArray(result.choices) || !result.choices.length) {
      throw new Error("服务已响应，但返回格式不符合预期（缺少 message 或 choices 字段）。");
    }
    rawText = extractMessageText(result.choices[0]?.message?.content);
  }

  const parsed = Keji.parseAsrText(rawText);
  return {
    ...parsed,
    raw: rawText.trim(),
    protocol: isOllamaNative ? "Ollama /api/chat" : "OpenAI /chat/completions"
  };
}
