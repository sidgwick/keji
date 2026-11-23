import {
  Keji,
  type ApiProtocol,
  type DiscussionMode,
  type KejiSettings,
  type KeyFrameItem,
  type VideoTarget,
} from "../keji.ts";
import { downloadAndCacheVideo, getCachedVideo, isBilibiliCdnUrl } from "../lesson-cache.ts";
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
  normalized.apiProtocol = Keji.normalizeProtocol(stored.apiProtocol, normalized.baseUrl);
  normalized.modelCapability = Keji.normalizeCapability(stored.modelCapability, stored.videoInputMode);
  delete (normalized as Record<string, unknown>).underlyingModel;
  delete (normalized as Record<string, unknown>).videoInputMode;
  if (!Object.prototype.hasOwnProperty.call(stored, "transcriptionApiKey")) {
    normalized.transcriptionApiKey = stored.apiKey || "";
  }
  return normalized;
}

function buildImageBlock(protocol: ApiProtocol, dataUrl: string) {
  if (protocol === "mimo") {
    return { type: "image_url" as const, image_url: { url: String(dataUrl || "") } };
  }
  return { type: "image_url" as const, image_url: { url: String(dataUrl || ""), detail: "high" as const } };
}

function buildVideoBlock(protocol: ApiProtocol, videoDataUrl: string, durationSeconds = 0) {
  const url = String(videoDataUrl || "");
  if (protocol === "mimo") {
    const seconds = Math.max(0, Number(durationSeconds) || 0);
    const fps = seconds ? Number(Math.min(2, Math.max(0.2, 600 / seconds)).toFixed(2)) : 1;
    return {
      type: "video_url" as const,
      video_url: { url },
      fps: Math.max(0.1, Math.min(10, fps)),
      media_resolution: "default" as const
    };
  }
  return { type: "video_url" as const, video_url: { url } };
}

function buildAudioBlock(protocol: ApiProtocol, base64Audio: string, format: "wav" | "mp3" = "wav") {
  const raw = String(base64Audio || "").replace(/^data:[^;]+;base64,/i, "");
  if (protocol === "mimo") {
    const mime = format === "mp3" ? "audio/mpeg" : "audio/wav";
    return { type: "input_audio" as const, input_audio: { data: `data:${mime};base64,${raw}` } };
  }
  return { type: "input_audio" as const, input_audio: { data: raw, format } };
}

async function resolveChatClient(overrideSettings: Partial<KejiSettings> | null = null, { fallbackTemperature = 0.3 } = {}) {
  const storedSettings = overrideSettings || (await chrome.storage.local.get("settings")).settings;
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
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^`{3,}[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n`{3,}$/);
  return match ? match[1]!.trim() : trimmed;
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
  const lockedHeadings = [...new Set(priorMarkdown.match(/^#{2,3}\s+.+$/gm) || [])];
  let index = 0;
  let totalCount = 1;
  let continuation = false;
  let messages: Array<{ role: "system" | "user"; content: any }>;

  if (payload.audioChunk) {
    if (settings.modelCapability !== "video_audio") {
      throw new Error("当前模型未开启「支持视频且理解音轨」能力，无法直接分析音轨。");
    }
    const chunk = payload.audioChunk as { index?: number; total?: number; start?: number; end?: number };
    index = Math.max(0, Math.floor(Number(chunk.index) || 0));
    totalCount = Math.max(1, Math.floor(Number(chunk.total) || 1));
    continuation = index > 0;
    if (continuation && !priorMarkdown) throw new Error("续跑数据缺失，请从头重新生成笔记。");
    const start = Math.max(0, Number(chunk.start) || 0);
    const end = Math.max(start, Number(chunk.end) || 0);

    const wavBase64 = await encodeAudioChunk({ video, start, end });
    const audioBlock = buildAudioBlock(settings.apiProtocol, wavBase64, "wav");
    const timeRangeLabel = end > start ? `${Keji.formatTime(start)}–${Keji.formatTime(end)}` : `从 ${Keji.formatTime(start)} 起`;
    const system = [
      "你是一名严谨的课程笔记助手。请仔细聆听这段课程音频，使用中文生成结构清楚、方便复习的 Markdown。",
      "只根据音频中实际讲授的内容写作；不得补造课程未提及的结论或代码。",
      `本段音频在整节视频中的绝对起始时间为 ${Keji.formatTime(start)}（+${Math.floor(start)} 秒）。请在每个要点旁标注叠加该起始时间后的完整视频时间戳 [MM:SS] 或 [HH:MM:SS]。`,
      totalCount === 1
        ? "请根据课程讲解重点挑选 1 到 5 个最值得配图或回看的时刻，在对应段落后输出 [[KEYFRAME: HH:MM:SS | 该时刻讲解重点]]。"
        : `这是第 ${index + 1}/${totalCount} 个音频分段（视频时间范围 ${timeRangeLabel}）。请只整理本分段新增内容，并挑选最多 1 个值得配图的时刻输出 [[KEYFRAME: HH:MM:SS | 该时刻讲解重点]]；不得复用前面分段的内容。`,
      continuation ? "章节锁定：沿用已有章节标题与顺序，只把本段新增内容归入对应章节；确实无法归类时才在末尾新增章节。" : "",
      continuation && lockedHeadings.length ? `已锁定章节：\n${lockedHeadings.join("\n")}` : "",
      "不要输出代码围栏包裹的整篇文档。"
    ].filter(Boolean);
    const userText = [
      `视频：${video.title || "未命名视频"}`,
      `分 P：${video.part || "当前分 P"}（第 ${video.page || 1}/${video.pageCount || 1} 节）`,
      `音频范围：${timeRangeLabel}（第 ${index + 1}/${totalCount} 段）`,
      `整理模板：${template.label}`,
      `任务：${task}`,
      continuation && lockedHeadings.length ? `已锁定章节标题：\n${lockedHeadings.join("\n")}` : ""
    ].filter(Boolean).join("\n\n");
    messages = [
      { role: "system", content: system.join("\n") },
      { role: "user", content: [{ type: "text", text: userText }, audioBlock] }
    ];
  } else {
    const transcript = String(payload.transcript || "").trim();
    if (!transcript) throw new Error("请先读取字幕，或粘贴一份文字稿。");
    const chunks = Keji.splitTranscript(transcript);
    totalCount = chunks.length;
    index = Math.max(0, Math.min(totalCount - 1, Math.floor(Number(payload.resumeFrom) || 0)));
    continuation = index > 0;
    if (continuation && !priorMarkdown) throw new Error("续跑数据缺失，请从头重新生成笔记。");

    const system = [
      "你是一名严谨的课程笔记助手。请使用中文生成结构清楚、方便复习的 Markdown。",
      "只根据提供的课程文字写作；不确定的信息要明确标注，不得补造视频没有讲过的内容。",
      "文字稿中的时间戳要保留在相关段落旁，使用 [时间] 格式。",
      totalCount === 1
        ? "请根据课程讲解内容，从文字稿中判断 1 到 5 个最值得回看或配图的时刻，并在对应笔记段落后单独输出标记 [[KEYFRAME: HH:MM:SS | 该时刻讲解重点]]。选择应由课程内容的重要性和上下文决定，不要按固定时间间隔抽样。"
        : "这是长视频分段整理的一部分。请只处理当前片段，并从当前片段中挑选最多 1 个最值得回看或配图的时刻；在对应笔记段落后单独输出标记 [[KEYFRAME: HH:MM:SS | 该时刻讲解重点]]。选择应由讲解内容的重要性决定，不要按固定时间间隔抽样。",
      "标记时间必须取自文字稿中已有的时间戳；不要编造时间。你只能看到文字稿，不能判断视频画面中具体出现了什么，因此说明只概括该时刻讲解的内容，不描述未经文字稿确认的画面。没有可靠时间戳时不要生成截图标记。",
      "每个标记会由扩展截取对应时刻的实际视频画面，并嵌入笔记。",
      "不要输出代码围栏包裹的整篇文档。"
    ];
    if (totalCount > 1) {
      system.push(`当前是第 ${index + 1}/${totalCount} 个连续文字片段。只整理本片段中新增的内容，保留其细节、例子、步骤、数据和时间戳；不要写整段视频的总结或结论。`);
      system.push("相邻片段文字仅用于理解跨边界的语意、术语和未完句；不要把当前片段以外的信息整理进笔记，也不要重复已处理的内容。");
    }
    if (continuation) {
      system.push("章节锁定：沿用首段及后续已建立的章节标题与顺序；只把本段新信息追加到最合适的已有章节。只有确实无法归入现有章节时，才在末尾新增章节。不得重写、压缩或复制前面片段已经整理的内容。输出 Markdown 章节标题和本段新增内容即可。");
      if (lockedHeadings.length) system.push(`已锁定章节：\n${lockedHeadings.join("\n")}`);
    }

    const previousContext = index > 0 ? chunks[index - 1]!.slice(-600) : "";
    const nextContext = index + 1 < totalCount ? chunks[index + 1]!.slice(0, 600) : "";
    const user = [
      `视频：${video.title || "未命名视频"}`,
      `分 P：${video.part || "当前分 P"}（第 ${video.page || 1}/${video.pageCount || 1} 节）`,
      `整理模板：${template.label}`,
      `任务：${task}`,
      continuation ? `续写要求：只输出第 ${index + 1} 段新增的笔记内容。` : "",
      "",
      previousContext ? `前一段末尾上下文（仅用于理解承接，不要复述）：\n${previousContext}` : "",
      continuation ? "以下章节标题已锁定：" : "本段字幕、转写或用户文字稿：",
      continuation && lockedHeadings.length ? lockedHeadings.join("\n") : "",
      "",
      `视频原时间戳不因分段而重置。文字稿片段 ${index + 1}/${totalCount}：`,
      chunks[index],
      nextContext ? `后一段开头上下文（仅用于理解承接，不要提前整理）：\n${nextContext}` : ""
    ].filter((line) => line !== "").join("\n");
    messages = [{ role: "system", content: system.join("\n") }, { role: "user", content: user }];
  }

  const { signal, release } = acquireGenerationSignal(payload.generationTaskId);
  try {
    if (signal?.aborted) throw new CancelledError();
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({ model, messages, temperature, stream: false })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(`第 ${index + 1}/${totalCount} 段模型请求失败：${result?.error?.message || result?.message || `HTTP ${response.status}`}`);
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
    const markdown = extractMessageText(choice).trim();
    if (!markdown) throw new Error(`模型没有返回第 ${index + 1}/${totalCount} 段内容。`);
    return { markdown, model: resolvedModel };
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
  if (!noteMarkdown) throw new Error("当前没有可供出题的笔记内容。");
  const transcriptText = String(payload.transcript || "").trim();
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
    `参考课程笔记：\n${noteMarkdown}`
  ].filter(Boolean).join("\n\n");

  const userContent = frames.length
    ? [
      { type: "text", text: `${promptText}\n\n以下为课程笔记中的关键画面（可结合板书/公式出题）：` },
      ...frames.flatMap((frame) => [
        { type: "text", text: `${frame.timestamp || "关键帧"}${frame.caption ? ` · ${frame.caption}` : ""}` },
        buildImageBlock(settings.apiProtocol, frame.dataUrl)
      ])
    ]
    : promptText;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature,
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            "你是专注课程理解检验的命题导师。请仅根据提供的课程笔记、讲稿与关键画面设计 5 到 8 道高质量单选题。",
            "重点考察核心原理、因果推导、适用条件与常见误区，干扰项应具教学区分度，不要出机械背诵页码的无效题。",
            "严格使用以下格式输出，禁止用代码围栏包裹整篇回复：",
            "### Q1. 题干内容 [MM:SS]",
            "- A. 选项A",
            "- B. 选项B",
            "- C. 选项C",
            "- D. 选项D",
            "> 答案：B",
            "> 解析：解释为什么选 B，以及其余典型错误选项错在哪里。"
          ].join("\n")
        },
        { role: "user", content: userContent }
      ]
    })
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || result?.message || `自测生成请求失败：HTTP ${response.status}`);
  const rawMarkdown = unwrapOuterCodeFence(extractMessageText(requireCompleteModelChoice(result, "随堂自测生成")));
  const parsed = parseQuizQuestions(rawMarkdown);
  if (!parsed.length) throw new Error("模型生成了内容，但未能解析出有效的随堂自测题目，请重试。");
  return { markdown: rawMarkdown, count: parsed.length };
}

export async function discussNote(payload: any): Promise<
  | { mode: "revise"; summary: string; markdown: string }
  | { mode: "qa" | "feynman"; reply: string }
> {
  const { settings, model, endpoint, headers, temperature } = await resolveChatClient();
  const mode: DiscussionMode = payload.mode === "qa" || payload.mode === "feynman" ? payload.mode : "revise";
  const request = String(payload.request || "").trim();
  const markdown = stripInlineImagesForPrompt(payload.markdown || "");
  if (!request || !markdown) throw new Error("互动内容和当前笔记都不能为空。");

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
    payload.transcript ? `\n原始课程文字稿（用于核对事实与时间戳）：\n${String(payload.transcript)}` : "",
    `\n当前笔记 Markdown：\n${markdown}`
  ].join("\n");
  const discussionContent = frames.length
    ? [
      { type: "text", text: `${discussionText}\n\n以下为笔记中已选关键帧，按时间戳对应：` },
      ...frames.flatMap((frame) => [
        { type: "text", text: `${frame.timestamp || "关键帧"}${frame.caption ? ` · ${frame.caption}` : ""}` },
        buildImageBlock(settings.apiProtocol, frame.dataUrl)
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
        "你是课程笔记的协作编辑助手。根据用户讨论要求，直接修订当前整篇 Markdown 笔记并保留未要求改动的内容。",
        "只根据提供的笔记、文字稿和可能附带的关键帧修订；不得补造事实。用户没有要求改变的关键内容、时间戳、章节结构与截图标记应保留。",
        frameRule,
        "输出必须严格包含两个区块：[[KEJI_CHANGE_SUMMARY]]一两句中文说明改动[[/KEJI_CHANGE_SUMMARY]]，然后 [[KEJI_UPDATED_NOTE]] 和 [[/KEJI_UPDATED_NOTE]] 之间放完整的更新后 Markdown。",
        "不要把整个答案包在代码围栏中。"
      ];

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
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
    })
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message || result?.message || `模型请求失败：HTTP ${response.status}`);
  const opLabel = mode === "qa" ? "课程答疑" : mode === "feynman" ? "费曼复述批改" : "笔记讨论修订";
  const text = extractMessageText(requireCompleteModelChoice(result, opLabel)).trim();
  if (!text) throw new Error("模型没有返回内容。");

  if (mode === "qa" || mode === "feynman") {
    return { mode, reply: text };
  }
  const summary = text.match(/\[\[KEJI_CHANGE_SUMMARY\]\]([\s\S]*?)\[\[\/KEJI_CHANGE_SUMMARY\]\]/)?.[1]?.trim() || "已根据讨论更新笔记。";
  const updated = text.match(/\[\[KEJI_UPDATED_NOTE\]\]([\s\S]*?)\[\[\/KEJI_UPDATED_NOTE\]\]/)?.[1]?.trim();
  if (!updated) throw new Error("模型响应缺少完整笔记区块，请重试或换一个兼容模型。");
  return { mode: "revise", summary, markdown: updated };
}

export async function enrichNoteWithFrames(payload: any): Promise<string> {
  const { settings, model, endpoint, headers } = await resolveChatClient(null, { fallbackTemperature: 0.2 });
  if (!Keji.supportsImage(settings.modelCapability)) throw new Error("当前模型能力不支持图片视觉理解。");
  const frames: KeyFrameItem[] = Array.isArray(payload.frames) ? payload.frames.slice(0, payload.discoverKeyframes ? 24 : 8) : [];
  if (!frames.length) throw new Error("没有成功截取可供模型分析的视频关键帧。");
  const transcriptText = String(payload.transcript || "").trim();
  const noteWithoutImages = stripInlineImagesForPrompt(payload.markdown || "");
  const content: any[] = [{
    type: "text",
    text: [
      payload.discoverKeyframes
        ? "随后的图片是按时间从整段视频中抽取的候选画面，不是预先挑好的重点。请先逐张查看候选画面，结合当前笔记与讲解内容，从中选出最有学习价值的 1 到 8 张；然后用选中的画面对笔记做联合校对。候选图片前的编号和时间戳与后续图片顺序对应。"
        : "请对这份课程笔记做音视频联合校对。当前笔记与讲解内容提供主线，随后的图片是课程视频帧，图片标题包含时间戳与对应讲解重点。",
      "阅读画面里的板书、幻灯片、终端输出、图表和演示状态，只补充图像中清楚可辨且对理解有帮助的信息，并把它们放进对应章节。纠正与实际画面明显冲突的描述。不要臆测模糊文字，不要把视频播放器 UI 当课程内容。保留原笔记的事实、章节顺序和时间戳。",
      payload.discoverKeyframes
        ? "删除笔记中原有的关键帧占位标记。仅对你选中的候选帧，在相关段落后输出 [[KEYFRAME: HH:MM:SS | 该画面对学习的价值]]。时间戳必须逐字使用候选画面给出的时间。最终输出完整修订后的 Markdown。"
        : "保留原笔记中的截图标记；未被图像支持的内容不要改写。严格输出完整的修订后 Markdown，不要解释处理过程，也不要用代码围栏。",
      `视频：${payload.title || "未命名视频"}`,
      transcriptText ? `课程文字稿：\n${transcriptText}` : "说明：当前课程未附带文字稿（由全模态模型直接理解音轨生成初稿）。",
      `当前笔记：\n${noteWithoutImages}`,
      ...frames.map((frame, index) => `候选画面 ${index + 1} · ${frame.timestamp}${frame.caption ? ` · ${frame.caption}` : ""}`)
    ].join("\n\n")
  }];
  let imageCount = 0;
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    if (!/^data:image\/(jpeg|png|webp);base64,/i.test(frame.dataUrl || "")) continue;
    content.push({ type: "text", text: `候选画面 ${index + 1} · ${frame.timestamp}` });
    content.push(buildImageBlock(settings.apiProtocol, frame.dataUrl));
    imageCount += 1;
  }
  if (!imageCount) throw new Error("关键帧图片格式无效。");
  const { signal, release } = acquireGenerationSignal(payload.generationTaskId);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "你是严谨的多模态课程笔记编辑。结合视频画面与课程文字稿，只添加画面直接支持的信息。" },
          { role: "user", content }
        ],
        temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.2,
        stream: false
      })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error?.message || result?.message || `多模态模型请求失败：HTTP ${response.status}`);
    const markdown = extractMessageText(requireCompleteModelChoice(result, "关键帧校对")).trim();
    if (!markdown) throw new Error("模型没有返回音视频联合校对后的笔记。");
    return markdown;
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
    const cached = await getCachedVideo(lessonTarget, { expectedCid: lessonTarget.cid });
    const providerLabel = settings.apiProtocol === "mimo" ? "小米 MiMo" : "OpenAI 兼容接口";
    let videoBlob: Blob;
    let totalBytes = 0;

    if (cached?.file && cached.size <= MAX_INLINE_VIDEO_BYTES) {
      videoBlob = cached.file;
      totalBytes = cached.size;
      await writeVideoProgress(taskId, {
        stage: "downloading",
        provider: settings.apiProtocol,
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
          void writeVideoProgress(taskId, { stage: "downloading", provider: settings.apiProtocol, loadedBytes, totalBytes: expectedBytes });
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
      provider: settings.apiProtocol,
      loadedBytes: totalBytes,
      totalBytes
    });
    const base64Video = Keji.bytesToBase64(new Uint8Array(await videoBlob.arrayBuffer()));
    const videoDataUrl = `data:${videoBlob.type || "video/mp4"};base64,${base64Video}`;
    const videoInput = buildVideoBlock(settings.apiProtocol, videoDataUrl, payload.duration);
    const transcriptText = String(payload.transcript || "").trim();

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: [
              "你是严谨的音视频课程笔记编辑。你会结合课程讲解内容与当前分 P 的视频画面修订笔记（注意：视频流不含伴随音轨，口述内容来自已有讲解/初稿）。",
              "结合视频中的幻灯片、板书、终端输出、图表、操作步骤和时间变化修订笔记。补充视觉信息时只写画面中清楚可辨的内容；不要臆测。",
              "保留已有知识点、例子、步骤、数据和章节结构；修正被视频证据推翻的描述。",
              "从整段视频中选出 1 到 5 个最值得回看或截图的时刻，在对应章节后输出标记 [[KEYFRAME: HH:MM:SS | 画面与讲解的重点]]；时间戳必须与课程时间线一致，不要按固定间隔取样。",
              "输出完整 Markdown，不要包在代码围栏中，也不要描述你看不到的内容。"
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
                  `当前分段笔记，请在此基础上结合视频画面完整修订：\n${String(payload.markdown || "")}`
                ].filter(Boolean).join("\n\n")
              },
              videoInput
            ]
          }
        ],
        temperature,
        stream: false
      })
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error?.message || result?.message || `整段视频模型请求失败：HTTP ${response.status}`);
    const markdown = extractMessageText(requireCompleteModelChoice(result, "完整视频笔记校对")).trim();
    if (!markdown) throw new Error("模型没有返回视频理解后的笔记。");
    if (!/\[\[KEYFRAME:\s*\d{1,2}:\d{2}(?::\d{2})?\s*\|\s*[^\]]+\]\]/i.test(markdown)) {
      throw new Error("视频模型没有返回可截图的关键时刻标记；将尝试按候选画面分析。");
    }
    return markdown;
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || signal?.aborted) throw new CancelledError();
    throw error;
  } finally {
    release();
  }
}
