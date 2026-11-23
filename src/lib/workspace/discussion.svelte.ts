import type { ConversationItem, DiscussionMode, KeyFrameItem } from '../keji.ts';
import { restoreScreenshotEmbeds } from '../markdown.ts';
import { callBackground, showNotice } from './ui.ts';

interface DiscussionHostHooks {
  getContext: () => {
    noteId: string | null;
    markdown: string;
    transcript: string;
    videoUrl: string;
    frames: KeyFrameItem[];
  };
  resolveTranscript: () => Promise<string>;
  applyNoteRevision: (revisedMarkdown: string, conversation: ConversationItem[]) => Promise<void>;
  saveConversationOnly: (conversation: ConversationItem[]) => Promise<void>;
}

export const discussionState = $state({
  mode: 'qa' as DiscussionMode,
  input: '',
  sending: false,
  items: [] as ConversationItem[],
});

let host: DiscussionHostHooks = {
  getContext: () => ({ noteId: null, markdown: '', transcript: '', videoUrl: '', frames: [] }),
  resolveTranscript: async () => '',
  applyNoteRevision: async () => {},
  saveConversationOnly: async () => {},
};

export function configureDiscussionHost(hooks: DiscussionHostHooks): void {
  host = hooks;
}

export function setDiscussionItems(items: ConversationItem[] = []): void {
  discussionState.items = Array.isArray(items) ? [...items] : [];
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
  if (!request || !ctx.markdown || discussionState.sending) return;

  const mode = discussionState.mode;
  const referenceTranscript = ctx.transcript || await host.resolveTranscript();
  const noticeText = mode === 'qa'
    ? (ctx.frames.length ? '正在结合讲稿与关键画面解答问题…' : '正在结合课程内容解答你的问题…')
    : mode === 'feynman'
      ? '正在对照课程讲稿评估你的费曼复述…'
      : (ctx.frames.length ? '正在结合文字稿、当前笔记和关键画面调整笔记…' : '正在结合当前内容调整笔记…');
  showNotice(noticeText, 'info');

  discussionState.sending = true;
  try {
    const result = await callBackground('DISCUSS_NOTE', {
      payload: {
        mode,
        request,
        markdown: ctx.markdown,
        transcript: referenceTranscript,
        conversation: discussionState.items,
        frames: ctx.frames.slice(0, 8),
      }
    });
    if (!result?.ok) throw new Error(result?.error || '学习互动请求失败。');

    const previousItems = discussionState.items;
    const now = new Date().toISOString();
    if (result.result?.mode === 'revise') {
      const revisedMarkdown = restoreScreenshotEmbeds(result.result.markdown, ctx.markdown);
      const nextItems: ConversationItem[] = [
        ...previousItems,
        { role: 'user', mode: 'revise', content: request, createdAt: now },
        { role: 'assistant', mode: 'revise', content: result.result.summary, createdAt: now },
      ];
      discussionState.items = nextItems;
      try {
        await host.applyNoteRevision(revisedMarkdown, nextItems);
      } catch (error) {
        discussionState.items = previousItems;
        throw new Error(`本机保存调整结果失败，已恢复原笔记：${(error as Error).message || '存储空间不足'}`);
      }
      discussionState.input = '';
      showNotice('笔记已按讨论更新并保存。', 'success');
      return;
    }

    const reply = String(result.result?.reply || '').trim();
    if (!reply) throw new Error('模型没有返回有效回复。');
    const nextItems: ConversationItem[] = [
      ...previousItems,
      { role: 'user', mode, content: request, createdAt: now },
      { role: 'assistant', mode, content: reply, createdAt: now },
    ];
    discussionState.items = nextItems;
    try {
      await host.saveConversationOnly(nextItems);
    } catch (error) {
      discussionState.items = previousItems;
      throw new Error(`本机保存互动记录失败：${(error as Error).message || '存储空间不足'}`);
    }
    discussionState.input = '';
    showNotice(mode === 'feynman' ? '费曼复述批改完成。' : '课程答疑已回复。', 'success');
  } catch (error) {
    showNotice((error as Error).message || '学习互动失败。', 'error');
  } finally {
    discussionState.sending = false;
  }
}

export async function clearDiscussionHistory(): Promise<void> {
  if (!discussionState.items.length || discussionState.sending) return;
  if (!window.confirm('清空本节的答疑、费曼复述与修订记录？（不会改动笔记正文）')) return;
  const previous = discussionState.items;
  discussionState.items = [];
  try {
    await host.saveConversationOnly([]);
    showNotice('已清空本节互动记录。', 'success');
  } catch (error) {
    discussionState.items = previous;
    showNotice((error as Error).message || '清空记录失败。', 'error');
  }
}
