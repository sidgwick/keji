import { parseFlashcards } from "../flashcards.ts";
import {
  Keji,
  type DiscussionMode,
  type KejiSettings,
  type KeyFrameItem,
  type ModelPreset,
  type VideoTarget,
} from "../keji.ts";
import { downloadAndCacheVideo, getCachedMuxedVideo, getCachedVideo, isBilibiliCdnUrl } from "../lesson-cache.ts";
import {
  applyGlobalSynthesisResult,
  applyVisualFrameReviewToMarkdown,
  applyVisualPatchToMarkdown,
  buildGlobalSynthesisPrompts,
  buildStructuredNotePrompts,
  compileFlashcardsResponseToMarkdown,
  compileQuizResponseToMarkdown,
  compileStructuredNoteToMarkdown,
  extractMarkdownOutline,
  parseDiscussionReviseResponse,
  parseModelJson,
  parseStructuredNoteResponse,
  salvageLooseJsonToMarkdown,
  type OutlineSectionItem,
  type StructuredNoteData,
} from "../note-schema.ts";
import { resolveNoteStructurePrompt } from "../note-structures.ts";
import { parseQuizQuestions } from "../quiz.ts";
import { configureBilibiliCdnRequestHeaders } from "./bilibili.ts";

class CancelledError extends Error {
  cancelled = true;
  constructor(message = "已停止生成。") {
    super(message);
  }
}

const MAX_INLINE_VIDEO_BYTES = 36 * 1024 * 1024;
const activeGenerationTasks = new Map<string, Set<AbortController>>();

function acquireGenerationSignal(taskId?: string) {
  const key = String(taskId || "").trim();
  if (!key) return { signal: undefined as AbortSignal | undefined, release() {} };
  const controller = new AbortController();
  let controllers = activeGenerationTasks.get(key);
  if (!controllers) {
    controllers = new Set();
    activeGenerationTasks.set(key, controllers);
  }
  controllers.add(controller);
  return {
    signal: controller.signal,
    release() {
      controllers.delete(controller);
      if (!controllers.size) activeGenerationTasks.delete(key);
    }
  };
}

export function hasActiveGenerationTasks(): boolean {
  return activeGenerationTasks.size > 0;
}

export function cancelGenerationTask(taskId = ""): void {
  const key = String(taskId || "").trim();
  if (key) {
    const controllers = activeGenerationTasks.get(key);
    if (controllers) {
      for (const controller of controllers) controller.abort();
      activeGenerationTasks.delete(key);
    }
    return;
  }
  for (const controllers of activeGenerationTasks.values()) {
    for (const controller of controllers) controller.abort();
  }
  activeGenerationTasks.clear();
}

export function normalizeSettings(storedSettings: Partial<KejiSettings> | null | undefined): KejiSettings {
  const stored = (storedSettings || {}) as Partial<KejiSettings> & Record<string, unknown>;
  const normalized: KejiSettings = { ...Keji.defaultSettings, ...stored };
  normalized.modelCapability = Keji.normalizeCapability(stored.modelCapability, stored.videoInputMode);
  delete (normalized as unknown as Record<string, unknown>).apiProtocol;
  delete (normalized as unknown as Record<string, unknown>).underlyingModel;
  delete (normalized as unknown as Record<string, unknown>).videoInputMode;
  delete (normalized as unknown as Record<string, unknown>).transcriptionLanguage;
  delete (normalized as unknown as Record<string, unknown>).transcriptionConcurrency;
  normalized.modelPresets = Array.isArray(stored.modelPresets)
    ? stored.modelPresets
      .filter((preset): preset is ModelPreset => Boolean(preset && typeof preset.id === "string"))
      .map((preset) => ({
        id: String(preset.id),
        name: String(preset.name || preset.model || "预设"),
        baseUrl: String(preset.baseUrl || "").trim().replace(/\/+$/, ""),
        model: String(preset.model || "").trim(),
        modelCapability: Keji.normalizeCapability(preset.modelCapability),
        apiKey: String(preset.apiKey || "").trim()
      }))
    : [];
  normalized.activePresetId = String(stored.activePresetId || "");
  return normalized;
}

function buildImageBlock(dataUrl: string) {
  return { type: "image_url" as const, image_url: { url: String(dataUrl || ""), detail: "high" as const } };
}

function buildVideoBlock(videoDataUrl: string) {
  return { type: "video_url" as const, video_url: { url: String(videoDataUrl || "") } };
}

function buildAudioBlock(base64Audio: string, format: "wav" | "mp3" = "wav") {
  const raw = String(base64Audio || "").replace(/^data:[^;]+;base64,/i, "");
  return { type: "input_audio" as const, input_audio: { data: raw, format } };
}

async function resolveChatClient(overrideSettings: Partial<KejiSettings> | null = null, { fallbackTemperature = 0.3 } = {}) {
  const storedSettings = overrideSettings || (await chrome.storage.local.get("settings")).settings as Partial<KejiSettings>;
  const settings = normalizeSettings(storedSettings);
  const baseUrl = String(settings.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(settings.model || "").trim();
  if (!baseUrl) throw new Error("请先在设置里填写 API 地址。");
  if (!model) throw new Error("请先在设置里填写模型名称。");

  let parsedUrl: URL;
  try { parsedUrl = new URL(baseUrl); } catch { throw new Error("API 地址格式不正确，请填写完整的 http(s) 地址。"); }
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("API 地址必须使用 HTTP 或 HTTPS。");
  if (!await chrome.permissions.contains({ origins: [`${parsedUrl.origin}/*`] })) {
    throw new Error("扩展还没有该 API 域名的访问权限。请打开设置并保存 API 地址以授权。");
  }

  const endpoint = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (String(settings.apiKey || "").trim()) headers.Authorization = `Bearer ${String(settings.apiKey).trim()}`;
  const temperature = Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : fallbackTemperature;
  return { settings, model, endpoint, headers, temperature };
}

function extractMessageText(choice: any): string {
  const content = choice?.message?.content;
  return Array.isArray(content)
    ? content.map((part: { text?: string }) => part.text || "").join("")
    : String(content || "");
}

function requireCompleteModelChoice(result: any, operation: string) {
  const choice = result?.choices?.[0];
  if (choice?.finish_reason === "length" || choice?.finish_reason === "max_tokens") {
    throw new Error(`${operation}被模型的生成长度上限截断；请提高服务商的最大输出 Token 后重试。`);
  }
  if (choice?.finish_reason === "content_filter") {
    throw new Error(`${operation}被模型的内容过滤器提前终止；请检查输入后重试。`);
  }
  return choice;
}

function stripInlineImagesForPrompt(markdown: string): string {
  return String(markdown || "")
    .replace(/!\[([^\]]*)\]\(data:image\/[^;]+;base64,[^)]+\)/g, "[视频关键帧：$1]")
    .trim();
}

function unwrapOuterCodeFence(text: string): string {
  const trimmed = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const match = trimmed.match(/^`{3,}[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n`{3,}$/);
  return match ? match[1]!.trim() : trimmed;
}

function stripRedundantMarkdownTitle(markdown: string): string {
  const trimmed = String(markdown || "").trim();
  if (!/^#\s+[^\n]+/.test(trimmed) || !/^##\s+/m.test(trimmed)) return trimmed;
  return trimmed
    .replace(/^#\s+[^\n]+\s*\r?\n+/, "")
    .replace(/^---+\s*\r?\n+/, "")
    .trim();
}

async function postChatCompletion({
  endpoint,
  headers,
  body,
  signal,
  jsonMode = false,
  timeoutMs = 300_000,
}: {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  jsonMode?: boolean;
  timeoutMs?: number;
}): Promise<{ response: Response; result: any }> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const send = async (useJsonFormat: boolean) => {
    const payload = useJsonFormat
      ? { ...body, response_format: { type: "json_object" } }
      : body;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: requestSignal,
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => null);
    return { response, result };
  };

  try {
    const first = await send(jsonMode);
    if (!first.response.ok && jsonMode && first.response.status === 400) {
      const errMsg = String(first.result?.error?.message || first.result?.message || "");
      if (/response_format|json_object|json_schema|structured|unsupported|grammar/i.test(errMsg)) {
        return send(false);
      }
    }
    return first;
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) throw new Error(`模型请求超时（${Math.round(timeoutMs / 1000)} 秒）。`);
    throw error;
  }
}

export async function testModelConnection(input: Partial<KejiSettings>) {
  const { model, endpoint, headers } = await resolveChatClient(input || {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: KEJI_OK" }],
        temperature: 0,
        stream: false
      })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error?.message || result?.message || `HTTP ${response.status}`);
    const text = extractMessageText(requireCompleteModelChoice(result, "模型连接测试"));
    if (!text.trim()) throw new Error("API 已响应，但没有返回文本内容。请确认模型支持 Chat Completions。");
    return { model, endpoint, response: text.trim().slice(0, 120) };
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw new Error("模型连接测试超时（20 秒）。");
    if (error instanceof TypeError) throw new Error("无法连接 API。请检查地址、域名权限、网络和跨域配置。");
    throw new Error(`模型连接测试失败：${(error as Error).message || "未知错误"}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateNote(
  payload: any,
  encodeAudioChunk: (params: {
    video: VideoTarget;
    start: number;
    end: number;
  }) => Promise<string>
) {
  const { settings, model, endpoint, headers, temperature } = await resolveChatClient();
  const { structure: template, task } = resolveNoteStructurePrompt(
    payload.template,
    payload.customPrompt,
    settings.customPrompt
  );
  if (!task) throw new Error("请填写自定义 Prompt。");

  const video = payload.video || {};
  const priorMarkdown = String(payload.partialMarkdown || "").trim();
  const providedOutline: OutlineSectionItem[] = Array.isArray(payload.partialOutline)
    ? payload.partialOutline.filter((item: any) => item && typeof item.title === "string")
    : [];
  const baseOutline = providedOutline.length ? providedOutline : extractMarkdownOutline(priorMarkdown, 18);

  let index = 0;
  let totalCount = 1;
  let continuation = false;
  let useJsonMode = false;
  let messages: Array<{ role: "system" | "user"; content: any }>;

  if (payload.audioChunk) {
    if (settings.modelCapability !== "video_audio") {
      throw new Error("当前模型未开启「支持视频且理解音轨」能力，无法直接分析音轨。");
    }
    const chunk = payload.audioChunk as { index?: number; total?: number; start?: number; end?: number };
    index = Math.max(0, Math.floor(Number(chunk.index) || 0));
    totalCount = Math.max(1, Math.floor(Number(chunk.total) || 1));
    continuation = index > 0;
    if (continuation && !priorMarkdown && !baseOutline.length) throw new Error("续跑数据缺失，请从头重新生成笔记。");
    const start = Math.max(0, Number(chunk.start) || 0);
    const end = Math.max(start, Number(chunk.end) || 0);

    const wavBase64 = await encodeAudioChunk({ video, start, end });
    const audioBlock = buildAudioBlock(wavBase64, "wav");
    const prompt = buildStructuredNotePrompts({
      templateId: template.id,
      task,
      templateLabel: template.label,
      videoTitle: video.title,
      videoPart: video.part,
      page: video.page,
      pageCount: video.pageCount,
      isAudioChunk: true,
      chunkIndex: index,
      totalChunks: totalCount,
      audioStart: start,
      audioEnd: end,
      outline: continuation ? baseOutline : undefined
    });
    messages = [
      { role: "system", content: prompt.system },
      { role: "user", content: [{ type: "text", text: prompt.userText }, audioBlock] }
    ];
  } else {
    const transcript = String(payload.transcript || "").trim();
    if (!transcript) throw new Error("请先读取字幕，或粘贴一份文字稿。");
    const chunkMaxChars = Math.max(1000, Math.min(12000, Math.floor(Number(payload.chunkMaxChars) || 12000)));
    const chunks = Keji.splitTranscript(transcript, chunkMaxChars);
    totalCount = chunks.length;
    index = Math.max(0, Math.min(totalCount - 1, Math.floor(Number(payload.resumeFrom) || 0)));
    continuation = index > 0;
    if (continuation && !priorMarkdown && !baseOutline.length) throw new Error("续跑数据缺失，请从头重新生成笔记。");
    const promptOutline = chunkMaxChars < 4000 ? baseOutline.slice(-12) : baseOutline;
    const contextOverlapChars = Math.min(600, Math.max(120, Math.floor(chunkMaxChars * 0.1)));
    const previousContext = index > 0 ? chunks[index - 1]!.slice(-contextOverlapChars) : "";
    const nextContext = index + 1 < totalCount ? chunks[index + 1]!.slice(0, contextOverlapChars) : "";

    const prompt = buildStructuredNotePrompts({
      templateId: template.id,
      task,
      templateLabel: template.label,
      videoTitle: video.title,
      videoPart: video.part,
      page: video.page,
      pageCount: video.pageCount,
      isAudioChunk: false,
      chunkIndex: index,
      totalChunks: totalCount,
      transcriptChunk: chunks[index],
      previousContext,
      nextContext,
      outline: continuation ? promptOutline : undefined
    });
    useJsonMode = true;
    messages = [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.userText }
    ];
  }

  const { signal, release } = acquireGenerationSignal(payload.generationTaskId);
  try {
    if (signal?.aborted) throw new CancelledError();
    const { response, result } = await postChatCompletion({
      endpoint,
      headers,
      signal,
      timeoutMs: payload.audioChunk ? 600_000 : 300_000,
      jsonMode: useJsonMode,
      body: { model, messages, temperature, stream: false }
    });
    if (!response.ok) {
      const rawMessage = String(result?.error?.message || result?.message || `HTTP ${response.status}`);
      const audioHint = payload.audioChunk && /audio\s+input\s+is\s+not\s+supported|input_audio|unsupported.*audio|mmproj/i.test(rawMessage)
        ? "（当前模型接口不支持直接输入音频；如使用本地服务请提供音频 mmproj，或在「设置 → 模型与生成」改用文本/图文能力并先语音转写）"
        : "";
      throw new Error(`第 ${index + 1}/${totalCount} 段模型请求失败：${rawMessage}${audioHint}`);
    }
    const resolvedModel = String(result?.model || model);
    const choice = result?.choices?.[0];
    const retryAction = continuation ? "调整设置后从本段继续" : "调整设置后重新生成";
    if (choice?.finish_reason === "length" || choice?.finish_reason === "max_tokens") {
      throw new Error(`第 ${index + 1}/${totalCount} 段输出被模型的生成长度上限截断；请提高服务商的最大输出 Token，${retryAction}。`);
    }
    if (choice?.finish_reason === "content_filter") {
      throw new Error(`第 ${index + 1}/${totalCount} 段被模型的内容过滤器提前终止；本段未标记完成，请检查原文后${continuation ? "从本段重试" : "重新生成"}。`);
    }
    const rawText = extractMessageText(choice).trim();
    if (!rawText) throw new Error(`模型没有返回第 ${index + 1}/${totalCount} 段内容。`);
    const structured = parseStructuredNoteResponse(rawText, template.id);
    if (structured) {
      const markdown = compileStructuredNoteToMarkdown(structured, template.id);
      if (markdown.trim()) return { markdown, model: resolvedModel, structured };
    }
    const fallbackObj = parseModelJson<Record<string, unknown> | unknown[]>(rawText);
    const directObj = !Array.isArray(fallbackObj) && fallbackObj && typeof fallbackObj === "object"
      ? fallbackObj
      : null;
    const directText = typeof directObj?.markdown === "string"
      ? directObj.markdown.trim()
      : typeof directObj?.note === "string"
        ? directObj.note.trim()
        : typeof directObj?.content === "string"
          ? directObj.content.trim()
          : "";
    const fallbackText = directText
      ? stripRedundantMarkdownTitle(unwrapOuterCodeFence(directText))
      : fallbackObj
        ? stripRedundantMarkdownTitle(salvageLooseJsonToMarkdown(fallbackObj))
        : stripRedundantMarkdownTitle(unwrapOuterCodeFence(rawText));
    if (!fallbackText.trim()) throw new Error(`模型没有返回第 ${index + 1}/${totalCount} 段有效笔记内容。`);
    return { markdown: fallbackText.trim(), model: resolvedModel };
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || signal?.aborted) throw new CancelledError();
    throw error;
  } finally {
    release();
  }
}

export async function synthesizeNoteOverview(payload: {
  structured: StructuredNoteData;
  video?: VideoTarget;
  generationTaskId?: string;
}): Promise<{ structured: StructuredNoteData; markdown: string; model: string }> {
  const prompts = buildGlobalSynthesisPrompts(payload.structured, {
    title: payload.video?.title,
    part: payload.video?.part,
  });
  if (!prompts) {
    return {
      structured: payload.structured,
      markdown: compileStructuredNoteToMarkdown(payload.structured, payload.structured.kind),
      model: "",
    };
  }
  const { model, endpoint, headers } = await resolveChatClient(null, { fallbackTemperature: 0.2 });
  const { signal, release } = acquireGenerationSignal(payload.generationTaskId);
  try {
    if (signal?.aborted) throw new CancelledError();
    const { response, result } = await postChatCompletion({
      endpoint,
      headers,
      signal,
      jsonMode: true,
      body: {
        model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: "system", content: prompts.system },
          { role: "user", content: prompts.userText },
        ],
      },
    });
    if (!response.ok) {
      throw new Error(result?.error?.message || result?.message || `全课统合请求失败：HTTP ${response.status}`);
    }
    const rawText = extractMessageText(requireCompleteModelChoice(result, "全课总纲收口")).trim();
    const synthesized = applyGlobalSynthesisResult(payload.structured, rawText);
    const markdown = compileStructuredNoteToMarkdown(synthesized, synthesized.kind);
    return {
      structured: synthesized,
      markdown: markdown || compileStructuredNoteToMarkdown(payload.structured, payload.structured.kind),
      model: String(result?.model || model),
    };
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || signal?.aborted) throw new CancelledError();
    throw error;
  } finally {
    release();
  }
}

export async function generateNoteQuiz(payload: any): Promise<{ markdown: string; count: number }> {
  const { settings, model, endpoint, headers, temperature } = await resolveChatClient();
  const noteMarkdown = stripInlineImagesForPrompt(payload.markdown || "");
  const transcriptText = String(payload.transcript || "").trim();
  if (!noteMarkdown && !transcriptText) throw new Error("当前没有可供出题的笔记或文字稿内容。");
  const allowImages = Keji.supportsImage(settings.modelCapability);
  const frames: KeyFrameItem[] = allowImages
    ? (Array.isArray(payload.frames) ? payload.frames : [])
      .filter((frame: KeyFrameItem) => /^data:image\/(jpeg|png|webp);base64,/i.test(frame?.dataUrl || ""))
      .slice(0, 6)
    : [];

  const quizTask = resolveNoteStructurePrompt("quiz").task;
  const promptText = [
    `课程标题：${payload.title || "课程笔记"}`,
    `出题要求：${quizTask}`,
    transcriptText ? `参考课程文字稿：\n${transcriptText}` : "",
    noteMarkdown ? `参考课程笔记：\n${noteMarkdown}` : ""
  ].filter(Boolean).join("\n\n");

  const userContent = frames.length
    ? [
      { type: "text", text: `${promptText}\n\n以下为课程笔记中的关键画面（可结合板书/公式出题）：` },
      ...frames.flatMap((frame) => [
        { type: "text", text: `${frame.timestamp || "关键帧"}${frame.caption ? ` · ${frame.caption}` : ""}` },
        buildImageBlock(frame.dataUrl)
      ])
    ]
    : promptText;

  const { response, result } = await postChatCompletion({
    endpoint,
    headers,
    jsonMode: true,
    body: {
      model,
      temperature,
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            "你是专注课程理解检验的命题导师。请仅根据提供的课程笔记、讲稿与关键画面设计 4 到 8 道高质量单选题（视内容密度决定，不硬凑数量）。",
            "重点考察核心原理、因果推导、适用条件与常见误区；严禁在题干中直接给出正确结论再反问（禁止送分题），必须给出 A/B/C/D 四个有教学区分度的同维选项。",
            "输出严格 JSON（禁止包裹代码围栏），格式：",
            '{"questions":[{"question":"具体问题表述（不含题号、不含“题干”字样、不自问自答泄露答案）","timestamp":"MM:SS","options":{"A":"选项A","B":"选项B","C":"选项C","D":"选项D"},"answer":"B","explanation":"解释为什么选 B，以及干扰项错因"}]}'
          ].join("\n")
        },
        { role: "user", content: userContent }
      ]
    }
  });
  if (!response.ok) throw new Error(result?.error?.message || result?.message || `自测生成请求失败：HTTP ${response.status}`);
  const rawText = extractMessageText(requireCompleteModelChoice(result, "随堂自测生成"));
  const compiledMarkdown = compileQuizResponseToMarkdown(rawText);
  const parsed = parseQuizQuestions(compiledMarkdown);
  if (!parsed.length) throw new Error("模型生成了内容，但未能解析出有效的随堂自测题目，请重试。");
  return { markdown: compiledMarkdown, count: parsed.length };
}

export async function generateNoteFlashcards(payload: any): Promise<{ markdown: string; count: number }> {
  const { settings, model, endpoint, headers, temperature } = await resolveChatClient();
  const noteMarkdown = stripInlineImagesForPrompt(payload.markdown || "");
  const transcriptText = String(payload.transcript || "").trim();
  if (!noteMarkdown && !transcriptText) throw new Error("当前没有可供提炼闪卡的笔记或文字稿内容。");
  const allowImages = Keji.supportsImage(settings.modelCapability);
  const frames: KeyFrameItem[] = allowImages
    ? (Array.isArray(payload.frames) ? payload.frames : [])
      .filter((frame: KeyFrameItem) => /^data:image\/(jpeg|png|webp);base64,/i.test(frame?.dataUrl || ""))
      .slice(0, 6)
    : [];

  const cardTask = resolveNoteStructurePrompt("flashcards").task;
  const promptText = [
    `课程标题：${payload.title || "课程笔记"}`,
    `提炼要求：${cardTask}`,
    transcriptText ? `参考课程文字稿：\n${transcriptText}` : "",
    noteMarkdown ? `参考课程笔记：\n${noteMarkdown}` : ""
  ].filter(Boolean).join("\n\n");

  const userContent = frames.length
    ? [
      { type: "text", text: `${promptText}\n\n以下为课程笔记中的关键画面（可结合要点提炼闪卡）：` },
      ...frames.flatMap((frame) => [
        { type: "text", text: `${frame.timestamp || "关键帧"}${frame.caption ? ` · ${frame.caption}` : ""}` },
        buildImageBlock(frame.dataUrl)
      ])
    ]
    : promptText;

  const { response, result } = await postChatCompletion({
    endpoint,
    headers,
    jsonMode: true,
    body: {
      model,
      temperature,
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            "你是专注主动回忆训练的课程助手。请仅根据提供的课程笔记、讲稿与关键画面按重点密度提炼 5 到 12 张高质量记忆闪卡（不硬凑重复卡）。",
            "每张卡片只考察一个核心概念、区别、公式物理含义或关键步骤，正面提问明确，背面答案精炼准确。",
            "输出严格 JSON（禁止包裹代码围栏），格式：",
            '{"cards":[{"front":"明确问题","back":"简明准确答案","tags":"主题标签","timestamp":"MM:SS"}]}'
          ].join("\n")
        },
        { role: "user", content: userContent }
      ]
    }
  });
  if (!response.ok) throw new Error(result?.error?.message || result?.message || `记忆闪卡生成请求失败：HTTP ${response.status}`);
  const rawText = extractMessageText(requireCompleteModelChoice(result, "记忆闪卡生成"));
  const compiledMarkdown = compileFlashcardsResponseToMarkdown(rawText);
  const parsed = parseFlashcards(compiledMarkdown);
  if (!parsed.length) throw new Error("模型生成了内容，但未能解析出有效的记忆闪卡表格，请重试。");
  return { markdown: compiledMarkdown, count: parsed.length };
}

export async function discussNote(payload: any): Promise<
  | { mode: "revise"; summary: string; markdown: string }
  | { mode: "qa" | "feynman"; reply: string }
> {
  const task = acquireGenerationSignal(payload.taskId);
  try { return await runDiscussion(payload, task.signal); }
  finally { task.release(); }
}

async function runDiscussion(payload: any, signal?: AbortSignal): ReturnType<typeof discussNote> {
  const { settings, model, endpoint, headers, temperature } = await resolveChatClient();
  const mode: DiscussionMode = payload.mode === "qa" || payload.mode === "feynman" ? payload.mode : "revise";
  const request = String(payload.request || "").trim();
  const markdown = stripInlineImagesForPrompt(payload.markdown || "");
  const transcriptText = String(payload.transcript || "").trim();
  if (!request) throw new Error("互动内容不能为空。");
  if (mode === "revise" && !markdown) throw new Error("当前没有可修订的笔记内容。");
  if (mode !== "revise" && !markdown && !transcriptText) throw new Error("当前缺少笔记和课程文字稿，无法回答。");

  const allowImages = Keji.supportsImage(settings.modelCapability);
  const frames: KeyFrameItem[] = allowImages
    ? (Array.isArray(payload.frames) ? payload.frames : [])
      .filter((frame: KeyFrameItem) => /^data:image\/(jpeg|png|webp);base64,/i.test(frame?.dataUrl || ""))
      .slice(0, 8)
    : [];
  const history = Array.isArray(payload.conversation) ? payload.conversation.slice(-12) : [];

  const interactionLabel = mode === "qa" ? "用户提问" : mode === "feynman" ? "用户费曼复述内容" : "用户修订要求";
  const discussionText = [
    `${interactionLabel}：\n${request}`,
    transcriptText ? `\n原始课程文字稿（用于核对事实与时间戳）：\n${transcriptText}` : "",
    markdown ? `\n当前笔记 Markdown：\n${markdown}` : ""
  ].filter(Boolean).join("\n");
  const discussionContent = frames.length
    ? [
      { type: "text", text: `${discussionText}\n\n以下为笔记中已选关键帧，按时间戳对应：` },
      ...frames.flatMap((frame) => [
        { type: "text", text: `${frame.timestamp || "关键帧"}${frame.caption ? ` · ${frame.caption}` : ""}` },
        buildImageBlock(frame.dataUrl)
      ])
    ]
    : discussionText;

  const frameRule = frames.length
    ? "关键帧图片与笔记中的截图标记按时间对应。用户若涉及画面内容，请直接查看对应图片；只描述清楚可见的内容。"
    : "当前没有附带关键帧图片，不要声称看到了视频画面。";

  const systemLines = mode === "qa"
    ? [
      "你是耐心且严谨的课程答疑助教。请只结合课程文字稿、当前笔记和可能附带的关键帧回答学习者的疑问。",
      "直接讲解概念原理、推导原因或排错思路，不要编造课程未讲授的结论，也不要改写整篇笔记。",
      "在引用课程内容处尽量附上方括号视频时间戳（例如 [12:34]），方便学习者跳回原视频。",
      frameRule
    ]
    : mode === "feynman"
      ? [
        "你是费曼学习法导师。学习者会尝试用自己的话复述本节课程核心内容，请你对照原课程文字稿、当前笔记和关键帧进行细致批改。",
        "不要改写原笔记。请严格按以下三段组织反馈：",
        "【理解准确】肯定复述正确且抓住本质的地方。",
        "【遗漏与偏差】指出逻辑跳跃、混淆的概念或重要前提遗漏，并尽可能附上原课程视频时间戳 [MM:SS] 以便回看对照。",
        "【启发追问】提出 1 个由浅入深的反问或边界条件思考题，引导学习者进一步确认是否真懂。",
        frameRule
      ]
      : [
        "你是课程笔记的协作编辑助手。根据用户讨论要求修订当前 Markdown 笔记，保留未要求改动的内容、章节结构、[视频关键帧：...] 占位和关键时间戳。",
        "只根据提供的笔记、文字稿和可能附带的关键帧修订；不得补造事实。",
        frameRule,
        "输出严格 JSON（禁止包裹代码围栏），格式：",
        '{"summary":"一两句中文说明做了哪些修订","updatedMarkdown":"完整修订后的 Markdown 正文"}'
      ];

  const { response, result } = await postChatCompletion({
    endpoint,
    headers,
    signal,
    jsonMode: mode === "revise",
    body: {
      model,
      temperature,
      stream: false,
      messages: [
        { role: "system", content: systemLines.join("\n") },
        ...history.map((item: { role: string; content?: string }) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: String(item.content || "")
        })),
        { role: "user", content: discussionContent }
      ]
    }
  });
  if (!response.ok) throw new Error(result?.error?.message || result?.message || `模型请求失败：HTTP ${response.status}`);
  const opLabel = mode === "qa" ? "课程答疑" : mode === "feynman" ? "费曼复述批改" : "笔记讨论修订";
  const text = extractMessageText(requireCompleteModelChoice(result, opLabel)).trim();
  if (!text) throw new Error("模型没有返回内容。");

  if (mode === "qa" || mode === "feynman") {
    return { mode, reply: text };
  }
  const revised = parseDiscussionReviseResponse(text);
  if (!revised) throw new Error("模型响应缺少有效修订结果，请重试或换一个兼容模型。");
  return { mode: "revise", summary: revised.summary, markdown: revised.markdown };
}

export async function enrichNoteWithFrames(payload: any): Promise<string> {
  const { settings, model, endpoint, headers } = await resolveChatClient(null, { fallbackTemperature: 0.2 });
  if (!Keji.supportsImage(settings.modelCapability)) throw new Error("当前模型能力不支持图片视觉理解。");
  const frames: KeyFrameItem[] = Array.isArray(payload.frames)
    ? payload.frames.slice(0, payload.discoverKeyframes ? 28 : 32)
    : [];
  if (!frames.length) throw new Error("没有成功截取可供模型分析的视频关键帧。");
  const transcriptText = String(payload.transcript || "").trim();
  const noteWithoutImages = stripInlineImagesForPrompt(payload.markdown || "");
  const isDiscover = Boolean(payload.discoverKeyframes);

  const instructionLines = isDiscover
    ? [
      "随后给出按内容热点采样的候选视频画面（编号与时间戳顺序对应）。请结合文字稿和当前笔记，评估每帧学习价值并给出 JSON 视觉补充补丁。",
      "【关键帧数量原则（0..N）】不设固定张数上下限：纯讲师露脸/空白/模糊转场帧一律跳过；同一板书或同页幻灯片只保留最完整清晰的一帧；若整课均无值得配图的板书、电路、公式、图表或界面演示，keyframes 直接输出 []。",
      "【就地修文原则】只记录图像里清晰可辨的板书公式、参数、图表曲线、代码结果；若发现初稿听错专有名词/寄存器名（如把 GPFCON 误写），写入 replacements 做原文替换；补充细节写入 supplements。",
      "输出严格 JSON（禁止代码围栏），无需重复输出整篇原笔记：",
      '{"keyframes":[{"candidateIndex":1,"timestamp":"MM:SS","sectionTitle":"对应笔记章节标题","caption":"简明图注","boardSupplement":"画面中补充的关键公式/参数（无则省略）"}],"replacements":[{"wrong":"误听词","right":"画面准确词"}],"supplements":[{"sectionTitle":"对应章节","detail":"需补充的视觉细节（无则省略）"}]}'
    ]
    : [
      "请结合下列已截取的关键帧（含编号与时间戳）对当前笔记做图文核对：补充板书细节、纠正文图不一致或听错术语；若某张仅为空白/纯人像无信息量画面可标记 keep: false。",
      "输出严格 JSON（禁止代码围栏），无需重抄整篇原笔记：",
      '{"frameUpdates":[{"frameIndex":1,"keep":true,"boardSupplement":"画面补充的关键公式/数据（无则省略）"}],"replacements":[{"wrong":"误听词","right":"画面准确词"}],"supplements":[{"sectionTitle":"对应章节","detail":"图文差异补充（无则省略）"}]}'
    ];

  const content: any[] = [{
    type: "text",
    text: [
      ...instructionLines,
      `视频：${payload.title || "未命名视频"}`,
      transcriptText ? `课程文字稿：\n${transcriptText}` : "说明：当前课程未附带文字稿。",
      `当前笔记：\n${noteWithoutImages}`,
      ...frames.map((frame, index) => `${isDiscover ? "候选画面" : "关键帧"} ${index + 1} · ${frame.timestamp}${frame.caption ? ` · ${frame.caption}` : ""}`)
    ].join("\n\n")
  }];
  let imageCount = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    if (!/^data:image\/(jpeg|png|webp);base64,/i.test(frame.dataUrl || "")) continue;
    content.push({ type: "text", text: `${isDiscover ? "候选画面" : "关键帧"} ${index + 1} · ${frame.timestamp}` });
    content.push(buildImageBlock(frame.dataUrl));
    imageCount += 1;
  }
  if (!imageCount) throw new Error("关键帧图片格式无效。");
  const { signal, release } = acquireGenerationSignal(payload.generationTaskId);
  try {
    const { response, result } = await postChatCompletion({
      endpoint,
      headers,
      signal,
      timeoutMs: 600_000,
      jsonMode: true,
      body: {
        model,
        messages: [
          { role: "system", content: "你是严谨的多模态课程笔记编辑。结合视频画面与课程文字稿，只输出高价值、画面直接支持的 JSON 校对补丁。" },
          { role: "user", content }
        ],
        temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.2,
        stream: false
      }
    });
    if (!response.ok) throw new Error(result?.error?.message || result?.message || `多模态模型请求失败：HTTP ${response.status}`);
    const rawReply = extractMessageText(requireCompleteModelChoice(result, "关键帧校对")).trim();
    if (!rawReply) throw new Error("模型没有返回音视频联合校对结果。");
    return isDiscover
      ? applyVisualPatchToMarkdown(noteWithoutImages, rawReply, frames)
      : applyVisualFrameReviewToMarkdown(noteWithoutImages, frames, rawReply);
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || signal?.aborted) throw new CancelledError();
    throw error;
  } finally {
    release();
  }
}

async function writeVideoProgress(taskId: string, progress: Record<string, unknown>) {
  if (!taskId || !chrome.storage.session) return;
  await chrome.storage.session.set({ [`videoProgress_${taskId}`]: { ...progress, taskId, updatedAt: Date.now() } }).catch(() => {});
}

export async function enrichNoteWithVideo(payload: any): Promise<string> {
  const taskId = String(payload.videoTaskId || "");
  const key = taskId ? `videoProgress_${taskId}` : "";
  try {
    return await enrichNoteWithVideoTask(payload, taskId);
  } finally {
    if (key && chrome.storage.session) await chrome.storage.session.remove(key).catch(() => {});
  }
}

async function enrichNoteWithVideoTask(payload: any, taskId: string): Promise<string> {
  const { signal, release } = acquireGenerationSignal(payload.generationTaskId || taskId);
  try {
    const { settings, model, endpoint, headers, temperature } = await resolveChatClient();
    if (!Keji.supportsVideo(settings.modelCapability)) throw new Error("当前模型能力未启用完整视频输入。");
    const lessonTarget: VideoTarget = {
      lessonKey: payload.lessonKey || "",
      bvid: payload.bvid || "",
      url: payload.pageUrl || "",
      page: payload.page || 1,
      cid: payload.cid || 0,
      title: payload.title || "",
      part: payload.part || "",
      duration: Number(payload.duration) || 0
    };
    const videoUrl = String(payload.videoUrl || "");
    const cachedCombined = settings.modelCapability === 'video_audio'
      ? await getCachedMuxedVideo(lessonTarget, { expectedCid: lessonTarget.cid }) : null;
    const cached = cachedCombined && cachedCombined.size <= MAX_INLINE_VIDEO_BYTES
      ? cachedCombined : await getCachedVideo(lessonTarget, { expectedCid: lessonTarget.cid });
    const videoHasAudio = Boolean(cachedCombined && cached === cachedCombined);
    const providerLabel = "OpenAI 兼容接口";
    let videoBlob: Blob;
    let totalBytes = 0;

    if (cached?.file && cached.size <= MAX_INLINE_VIDEO_BYTES) {
      videoBlob = cached.file;
      totalBytes = cached.size;
      await writeVideoProgress(taskId, {
        stage: "downloading",
        loadedBytes: totalBytes,
        totalBytes,
        cached: true
      });
    } else {
      if (!isBilibiliCdnUrl(videoUrl, true)) {
        throw new Error(cached?.file
          ? `本机缓存视频（${Math.round(cached.size / 1024 / 1024)} MB）超过内联上限 36 MB，将自动改用关键帧分析。`
          : "无法读取当前分 P 视频流地址，将改用关键帧分析。");
      }
      const originPattern = `${new URL(videoUrl).origin}/*`;
      if (!await chrome.permissions.contains({ origins: [originPattern] })) {
        throw new Error("尚未授予 B 站视频 CDN 访问权限；请重新保存设置并允许 B 站视频域名。");
      }
      await configureBilibiliCdnRequestHeaders();
      const downloaded = await downloadAndCacheVideo(lessonTarget, videoUrl, {
        maxBytes: MAX_INLINE_VIDEO_BYTES,
        providerLabel,
        expectedCid: lessonTarget.cid || 0,
        signal,
        meta: lessonTarget,
        onProgress: (loadedBytes, expectedBytes) => {
          void writeVideoProgress(taskId, { stage: "downloading", loadedBytes, totalBytes: expectedBytes });
        }
      });
      videoBlob = downloaded.file;
      totalBytes = downloaded.size;
    }

    if (totalBytes > MAX_INLINE_VIDEO_BYTES) {
      throw new Error(`${providerLabel} 内联视频上限约为 36 MB（Base64 约 48 MB），当前视频过大，将自动改用关键帧分析。`);
    }
    await writeVideoProgress(taskId, {
      stage: "analyzing",
      loadedBytes: totalBytes,
      totalBytes
    });
    const base64Video = Keji.bytesToBase64(new Uint8Array(await videoBlob.arrayBuffer()));
    const videoDataUrl = `data:${videoBlob.type || "video/mp4"};base64,${base64Video}`;
    const videoInput = buildVideoBlock(videoDataUrl);
    const transcriptText = String(payload.transcript || "").trim();
    const noteWithoutImages = stripInlineImagesForPrompt(payload.markdown || "");

    const { response, result } = await postChatCompletion({
      endpoint,
      headers,
      signal,
      timeoutMs: 600_000,
      jsonMode: false,
      body: {
        model,
        messages: [
          {
            role: "system",
            content: [
              videoHasAudio
                ? "你是严谨的音视频课程笔记编辑。当前视频包含画面与伴随音轨，请结合两者输出 JSON 视觉校对补丁。"
                : "你是严谨的音视频课程笔记编辑。你会结合课程讲解内容与视频画面输出 JSON 视觉校对补丁（视频流不含伴随音轨）。",
              "结合视频中的幻灯片、板书、终端输出、电路图或波形补充清楚可辨的信息；若发现听错术语用 replacements 做原文替换，额外细节放 supplements。",
              "【关键帧规则（0..N）】完全按重点画面出现位置决定数量，不设定机械张数；纯口述无板书重点直接返回 \"keyframes\": []。务必挑选板书/图表/演示内容完整清晰呈现在屏幕上的稳定时刻。",
              "输出严格 JSON（禁止包裹代码围栏），无需重写原笔记：",
              '{"keyframes":[{"timestamp":"MM:SS","sectionTitle":"对应笔记章节","caption":"画面重点简述","boardSupplement":"清晰可见的板书/公式补充（无则省略）"}],"replacements":[{"wrong":"误听词","right":"画面准确词"}],"supplements":[{"sectionTitle":"对应章节","detail":"需补充的视觉细节（无则省略）"}]}'
            ].join("\n")
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  `视频：${payload.title || "未命名视频"}`,
                  transcriptText ? `课程文字稿（含时间戳）：\n${transcriptText}` : "",
                  `当前笔记大纲与正文：\n${noteWithoutImages}`
                ].filter(Boolean).join("\n\n")
              },
              videoInput
            ]
          }
        ],
        temperature,
        stream: false
      }
    });
    if (!response.ok) throw new Error(result?.error?.message || result?.message || `整段视频模型请求失败：HTTP ${response.status}`);
    const rawReply = extractMessageText(requireCompleteModelChoice(result, "完整视频笔记校对")).trim();
    if (!rawReply) throw new Error("模型没有返回视频理解后的校对结果。");
    return applyVisualPatchToMarkdown(noteWithoutImages, rawReply);
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || signal?.aborted) throw new CancelledError();
    throw error;
  } finally {
    release();
  }
}
