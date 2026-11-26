import type { ConversationItem, DiscussionMode, KeyFrameItem } from '../keji.ts';
import { restoreScreenshotEmbeds } from '../markdown.ts';
import { callBackground, showNotice } from './ui.ts';

interface DiscussionHostHooks {
  getContext: () => {
    noteId: string | null;
    markdown: string;
    targetViewKey: string;
    targetViewLabel: string;
    transcript: string;
    videoUrl: string;
    frames: KeyFrameItem[];
  };
  resolveTranscript: () => Promise<string>;
  applyNoteRevision: (input: {
    noteId: string | null;
    viewKey: string;
    baseMarkdown: string;
    revisedMarkdown: string;
    messages: ConversationItem[];
    requestId: string;
  }) => Promise<{ noteId: string; viewKey: string; label: string; previousMarkdown: string; revisedMarkdown: string } | null>;
  undoNoteRevision: (snapshot: { noteId: string; viewKey: string; previousMarkdown: string; revisedMarkdown: string }) => Promise<void>;
  saveConversationOnly: (conversation: ConversationItem[], targetNoteId: string | null) => Promise<void>;
}

export const discussionState = $state({
  mode: 'qa' as DiscussionMode,
  input: '',
  sending: false,
  items: [] as ConversationItem[],
  targetViewLabel: '',
  hasRevisableMarkdown: false,
  lastRevisionUndo: null as { noteId: string; viewKey: string; label: string; previousMarkdown: string; revisedMarkdown: string } | null,
});

let host: DiscussionHostHooks = {
  getContext: () => ({
    noteId: null,
    markdown: '',
    targetViewKey: 'study',
    targetViewLabel: '详细笔记',
    transcript: '',
    videoUrl: '',
    frames: [],
  }),
  resolveTranscript: async () => '',
  applyNoteRevision: async () => null,
  undoNoteRevision: async () => {},
  saveConversationOnly: async () => {},
};
let activeDiscussionTaskId = '';

export function configureDiscussionHost(hooks: DiscussionHostHooks): void {
  host = hooks;
}

export function syncDiscussionContextState(): void {
  const ctx = host.getContext();
  discussionState.targetViewLabel = ctx.targetViewLabel || '当前笔记';
  discussionState.hasRevisableMarkdown = Boolean(ctx.markdown.trim());
}

export function setDiscussionItems(items: ConversationItem[] = []): void {
  discussionState.items = Array.isArray(items) ? [...items] : [];
  discussionState.lastRevisionUndo = null;
}

export function getDiscussionItems(): ConversationItem[] {
  return [...discussionState.items];
}

export function setDiscussionMode(mode: DiscussionMode): void {
  discussionState.mode = mode;
}

export function getActiveDiscussionVideoUrl(): string {
  return host.getContext().videoUrl;
}

export async function sendDiscussion(): Promise<void> {
  const request = discussionState.input.trim();
  const ctx = host.getContext();
  const targetNoteId = ctx.noteId;
  if (!request || discussionState.sending) return;

  const mode = discussionState.mode;
  if (mode === 'revise' && !ctx.markdown) {
    showNotice('当前标签页还没有可修订的笔记内容，请先生成笔记。', 'error');
    return;
  }
  const referenceTranscript = ctx.transcript || await host.resolveTranscript();
  if (mode !== 'revise' && !ctx.markdown && !referenceTranscript) {
    showNotice('当前缺少笔记和课程文字稿，无法开始互动。', 'error');
    return;
  }
  const noticeText = mode === 'qa'
    ? (ctx.frames.length ? '正在结合文字稿与关键画面解答问题…' : '正在结合课程内容解答你的问题…')
    : mode === 'feynman'
      ? '正在对照课程文字稿评估你的费曼复述…'
      : (ctx.frames.length ? '正在结合文字稿、当前笔记和关键画面修订笔记…' : '正在结合当前内容修订笔记…');
  showNotice(noticeText, 'info');

  discussionState.sending = true;
  const taskId = crypto.randomUUID();
  activeDiscussionTaskId = taskId;
  const requestItems = [...discussionState.items];
  try {
    const result = await callBackground('DISCUSS_NOTE', {
      payload: {
        taskId,
        mode,
        request,
        markdown: ctx.markdown,
        transcript: referenceTranscript,
        conversation: requestItems,
        frames: ctx.frames.slice(0, 8),
      }
    });
    if (!result?.ok) throw new Error(result?.error || '学习互动请求失败。');

    const now = new Date().toISOString();
    const stillViewingSameNote = host.getContext().noteId === targetNoteId;
    if (result.result?.mode === 'revise') {
      const revisedMarkdown = restoreScreenshotEmbeds(result.result.markdown, ctx.markdown);
      const messages: ConversationItem[] = [
        { role: 'user', mode: 'revise', content: request, createdAt: now },
        { role: 'assistant', mode: 'revise', content: result.result.summary, createdAt: now },
      ];
      let undoSnapshot: typeof discussionState.lastRevisionUndo = null;
      try {
        undoSnapshot = await host.applyNoteRevision({
          noteId: targetNoteId, viewKey: ctx.targetViewKey, baseMarkdown: ctx.markdown,
          revisedMarkdown, messages, requestId: crypto.randomUUID(),
        });
      } catch (error) {
        throw new Error(`本机保存调整结果失败，已恢复原笔记：${(error as Error).message || '存储空间不足'}`);
      }
      if (stillViewingSameNote) {
        discussionState.items = [...discussionState.items, ...messages];
        discussionState.lastRevisionUndo = undoSnapshot;
        discussionState.input = '';
        showNotice(
          undoSnapshot?.label ? `已更新「${undoSnapshot.label}」并保存到本机。` : '已按修订要求更新并保存到本机。',
          'success',
        );
      } else {
        showNotice('原笔记的 AI 修订已在后台保存。', 'success');
      }
      return;
    }

    const reply = String(result.result?.reply || '').trim();
    if (!reply) throw new Error('模型没有返回有效回复。');
    const nextItems: ConversationItem[] = [
      ...requestItems,
      { role: 'user', mode, content: request, createdAt: now },
      { role: 'assistant', mode, content: reply, createdAt: now },
    ];
    try {
      await host.saveConversationOnly(nextItems, targetNoteId);
    } catch (error) {
      throw new Error(`本机保存互动记录失败：${(error as Error).message || '存储空间不足'}`);
    }
    if (stillViewingSameNote) {
      discussionState.items = nextItems;
      discussionState.input = '';
      showNotice(mode === 'feynman' ? '费曼复述批改完成。' : '课程答疑已回复。', 'success');
    } else {
      showNotice('原笔记的 AI 助教回复已保存到后台。', 'success');
    }
  } catch (error) {
    showNotice((error as Error).message || '学习互动失败。', 'error');
  } finally {
    if (activeDiscussionTaskId === taskId) activeDiscussionTaskId = '';
    discussionState.sending = false;
  }
}

export function cancelDiscussion(): void {
  if (!activeDiscussionTaskId) return;
  void callBackground('CANCEL_GENERATION', { taskId: activeDiscussionTaskId });
}

export function applyStarterPrompt(prompt: string, autoSend = true): void {
  if (discussionState.sending) return;
  discussionState.input = prompt;
  if (autoSend) {
    void sendDiscussion();
  } else {
    requestAnimationFrame(() => document.getElementById('discussion-input')?.focus());
  }
}

export async function undoLastRevision(): Promise<void> {
  const snapshot = discussionState.lastRevisionUndo;
  if (!snapshot || discussionState.sending) return;
  discussionState.lastRevisionUndo = null;
  try {
    await host.undoNoteRevision(snapshot);
    showNotice('已撤回本次 AI 修订。', 'success');
  } catch (error) {
    discussionState.lastRevisionUndo = snapshot;
    showNotice((error as Error).message || '撤回修订失败。', 'error');
  }
}

export async function clearDiscussionHistory(): Promise<void> {
  if (!discussionState.items.length || discussionState.sending) return;
  if (!window.confirm('清空本节的答疑、费曼复述与修订记录？（不会改动笔记正文）')) return;
  const targetNoteId = host.getContext().noteId;
  const previous = discussionState.items;
  discussionState.items = [];
  try {
    await host.saveConversationOnly([], targetNoteId);
    showNotice('已清空本节互动记录。', 'success');
  } catch (error) {
    if (host.getContext().noteId === targetNoteId) discussionState.items = previous;
    showNotice((error as Error).message || '清空记录失败。', 'error');
  }
}
