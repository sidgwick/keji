export type TemplateId = "study" | "brief" | "tutorial" | "timeline" | "flashcards" | "quiz" | "custom";

interface NoteStructure {
  id: TemplateId;
  label: string;
  description: string;
  prompt: string;
  supportsFlashcards?: boolean;
  supportsQuiz?: boolean;
}

export const NOTE_STRUCTURES: readonly NoteStructure[] = [
  {
    id: "study",
    label: "详细笔记",
    description: "概念、推导、例子与重点，系统掌握内容",
    prompt: "整理成适合复习的详细课程笔记。按主题分节，解释关键概念、推导或步骤与结论，保留有助于理解的例子、条件、数据和易错点；每个要点尽量附对应时间戳。"
  },
  {
    id: "brief",
    label: "精简总结",
    description: "提炼核心脉络与结论，快速回顾",
    prompt: "用精简清晰的分节结构提炼核心脉络、关键概念与最终结论，保留重要时间戳。"
  },
  {
    id: "tutorial",
    label: "实操步骤",
    description: "前置条件、分步操作与验证排错",
    prompt: "将内容整理成可实际操作的步骤指南：目标、前置条件或环境、分步操作、预期结果、验证方法和常见排错。只写文字稿明确讲到的操作，不补造命令或参数。"
  },
  {
    id: "timeline",
    label: "时间线梳理",
    description: "按视频推进顺序串联各阶段要点",
    prompt: "按视频推进顺序梳理脉络，每节以时间戳开头，说明该阶段讲了什么以及与前后内容的衔接关系。"
  },
  {
    id: "flashcards",
    label: "记忆闪卡",
    description: "用问答卡片主动回忆，支持导出 Anki",
    supportsFlashcards: true,
    prompt: "把内容整理成适合主动回忆的闪卡。输出 Markdown 表格，列为 Front、Back、Tags、Timestamp；每张卡只考一个明确事实或概念，答案简洁，避免重复。"
  },
  {
    id: "quiz",
    label: "随堂自测",
    description: "情景单选与错因解析，检验是否真懂",
    supportsQuiz: true,
    prompt: "围绕课程核心概念、因果逻辑、边界条件与易错点设计 5 到 8 道高质量单选题。每题严格使用以下 Markdown 格式：先写标题行 ### Q序号. 题干 [MM:SS]（附对应视频时间戳），再换行列出 - A. / - B. / - C. / - D. 四个选项，随后换行写 > 答案：X（单字母 A-D）与 > 解析：说明正确原因及干扰项错因。不要把整篇输出包在代码围栏中。"
  },
  {
    id: "custom",
    label: "自定义",
    description: "按你的要求自由组织笔记结构",
    prompt: ""
  }
];

export function isNoteStructureId(id: unknown): id is TemplateId {
  return typeof id === "string" && NOTE_STRUCTURES.some((item) => item.id === id);
}

export function getNoteStructure(id?: string | null): NoteStructure {
  return NOTE_STRUCTURES.find((item) => item.id === id) || NOTE_STRUCTURES[0]!;
}

export function resolveNoteStructurePrompt(
  templateId?: string | null,
  customPrompt = "",
  fallbackCustomPrompt = ""
): { structure: NoteStructure; task: string } {
  const structure = getNoteStructure(templateId);
  const task = structure.id === "custom"
    ? String(customPrompt || fallbackCustomPrompt || "").trim()
    : structure.prompt;
  return { structure, task };
}
