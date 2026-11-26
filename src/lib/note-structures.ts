export type NoteViewKey = "study" | "brief" | "tutorial" | "timeline" | "custom";
export type TemplateId = NoteViewKey | "flashcards" | "quiz";

interface NoteStructure {
  id: TemplateId;
  label: string;
  tabLabel?: string;
  description: string;
  category?: "note" | "practice";
  prompt: string;
  supportsFlashcards?: boolean;
  supportsQuiz?: boolean;
}

export const NOTE_STRUCTURES: readonly NoteStructure[] = [
  {
    id: "study",
    label: "详细笔记",
    description: "问题动机、层级原理、代码/寄存器与速查",
    category: "note",
    prompt: "按人类深度学习讲义组织：先提炼核心问题与全课关键结论，再分节先交代引入背景与解决的矛盾，用子标题与层级要点拆解机制原理、公式推导、对比表格、关键代码/寄存器配置与易错边界；完整保留硬核参数、寄存器位定义与公式，删去寒暄与空泛套话。"
  },
  {
    id: "brief",
    label: "精简总结",
    description: "一页速览：核心主旨、因果链与必记结论",
    category: "note",
    prompt: "提炼考前一页纸速览：1句核心命题、清晰因果推进链（A → B → C）与3-6条带成立条件的关键结论。"
  },
  {
    id: "tutorial",
    label: "实操步骤",
    description: "前置条件、分步命令/代码与验证排错",
    category: "note",
    prompt: "整理为可执行的实操步骤指南：目标、前置准备、有序步骤、验证方法与常见排错；只保留课程实际提及的命令、寄存器或参数，不补造未出现的配置。"
  },
  {
    id: "timeline",
    label: "时间线梳理",
    tabLabel: "时间线",
    description: "按课程推进串联阶段起止时间与转折脉络",
    category: "note",
    prompt: "按视频讲解推进顺序划分关键阶段，写明起止时间、该阶段核心内容、前后逻辑承接关系与转折重点。"
  },
  {
    id: "flashcards",
    label: "记忆闪卡",
    description: "用问答卡片主动回忆，支持导出 Anki",
    category: "practice",
    supportsFlashcards: true,
    prompt: "提炼最值得长期记忆的概念辨析、公式物理意义、适用条件与关键步骤；每张卡片只考一个明确问题，答案简洁精准。"
  },
  {
    id: "quiz",
    label: "随堂自测",
    description: "情景单选与错因解析，检验是否真懂",
    category: "practice",
    supportsQuiz: true,
    prompt: "围绕课程核心原理、因果推导、边界条件与常见误区设计高质量单选题，干扰项应具教学区分度，解析写清正误原因。"
  },
  {
    id: "custom",
    label: "自定义",
    description: "按你的要求自由组织笔记结构",
    category: "note",
    prompt: ""
  }
];

export const NOTE_DOCUMENT_STRUCTURES: readonly (NoteStructure & { id: NoteViewKey })[] =
  NOTE_STRUCTURES.filter((item): item is NoteStructure & { id: NoteViewKey } => item.category !== "practice");

export function isNoteStructureId(id: unknown): id is TemplateId {
  return typeof id === "string" && NOTE_STRUCTURES.some((item) => item.id === id);
}

export function isNoteViewKey(id: unknown): id is NoteViewKey {
  return typeof id === "string" && NOTE_DOCUMENT_STRUCTURES.some((item) => item.id === id);
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
