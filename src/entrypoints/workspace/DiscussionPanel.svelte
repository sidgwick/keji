<script lang="ts">
  import type { ConversationItem, DiscussionMode } from '../../lib/keji.ts';
  import { renderMessageWithTimestamps } from '../../lib/markdown.ts';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import * as disc from '../../lib/workspace/discussion.svelte.ts';
  import * as fc from '../../lib/workspace/flashcards.svelte.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  const modes: Array<{
    id: DiscussionMode;
    label: string;
    hint: string;
    placeholder: string;
    submitLabel: string;
    starters: Array<{ label: string; prompt: string; autoSend?: boolean }>;
  }> = [
    {
      id: 'qa',
      label: '答疑',
      hint: '结合文字稿、笔记与关键画面答疑（不改动笔记）',
      placeholder: '问个概念、推导或代码细节…',
      submitLabel: '发送提问',
      starters: [
        { label: '通俗解释本节核心原理', prompt: '请用通俗直观的语言和例子，解释这节课最核心的原理与来龙去脉。' },
        { label: '列出最容易混淆的概念', prompt: '这节课里哪些概念或边界条件最容易混淆？请帮我做对比辨析。' },
        { label: '梳理关键前提与结论', prompt: '请列出本节结论成立的前提条件、关键假设和适用边界。' },
      ],
    },
    {
      id: 'feynman',
      label: '费曼复述',
      hint: '用自己的话复述，AI 对照原课程指出遗漏与盲区',
      placeholder: '用自己的话复述核心逻辑与限制条件…',
      submitLabel: '提交复述并批改',
      starters: [
        { label: '给我一份复述提纲', prompt: '先别直接给出全部答案，请给我 3 到 4 个关键提示词作为费曼复述提纲，让我自己试着讲清楚这节课。' },
        { label: '按「原理-例子-边界」考我', prompt: '请按“核心原理、典型例子、适用边界”出 2 个追问考考我，等我作答后再点评。' },
        { label: '直接开始我的复述…', prompt: '我试着用自己的话复述这节课的核心内容：\n1. 它主要解决什么问题：\n2. 核心机制是：\n3. 适用前提或限制：', autoSend: false },
      ],
    },
    {
      id: 'revise',
      label: '修订',
      hint: '按你的要求直接修订当前笔记，并自动保留截图',
      placeholder: '例如：把第三章概念对比整理成表格并精简冗余…',
      submitLabel: '发送并修订笔记',
      starters: [
        { label: '精简冗余表述', prompt: '精简当前笔记的冗余表述与重复段落，保留所有核心概念、公式、时间戳和截图标记。' },
        { label: '把核心对比整理成表格', prompt: '把当前笔记中最适合对比的概念、方法或优缺点整理成清晰 Markdown 表格，保留原有内容与时间戳。' },
        { label: '补充易错点小结', prompt: '结合原始文字稿，在当前笔记末尾补充一个「常见易错点与注意事项」小节，保留现有结构和截图。' },
      ],
    },
  ];

  const activeMode = $derived(modes.find((item) => item.id === disc.discussionState.mode) || modes[0]!);
  const sheetOpen = $derived(
    workspace.activeView === 'note'
    && workspace.resultVisible
    && workspace.assistantOpen
    && !workspace.markdownEditing
    && !fc.flashcardState.crossNote
  );

  function speakerLabel(item: ConversationItem): string {
    const mode = item.mode || 'revise';
    if (item.role === 'user') {
      return mode === 'qa' ? '你的提问' : mode === 'feynman' ? '我的费曼复述' : '修订要求';
    }
    return mode === 'qa' ? 'AI 答疑' : mode === 'feynman' ? '费曼点评' : '修订记录';
  }

  function timestampedText(node: HTMLElement, params: { text: string; videoUrl: string }) {
    renderMessageWithTimestamps(node, params.text, params.videoUrl);
    return {
      update(next: { text: string; videoUrl: string }) {
        renderMessageWithTimestamps(node, next.text, next.videoUrl);
      }
    };
  }
</script>

<div class="discussion-sheet-shell">
  <aside
    class="discussion-panel"
    class:is-open={sheetOpen}
    id="discussion-panel"
    aria-label="AI 助教"
    aria-hidden={!sheetOpen}
    inert={!sheetOpen}
  >
    <header class="assistant-topbar">
      <div class="assistant-topbar-main">
        <div class="markdown-view-modes" role="group" aria-label="助教模式">
          {#each modes as item (item.id)}
            <button
              type="button"
              class="mode-tab"
              aria-pressed={disc.discussionState.mode === item.id}
              onclick={() => { disc.setDiscussionMode(item.id); disc.syncDiscussionContextState(); }}
            >{item.label}</button>
          {/each}
        </div>
        <span class="assistant-context-inline">
          {#if activeMode.id === 'revise'}
            {#if disc.discussionState.hasRevisableMarkdown}
              <span class="context-target">将修订：<strong>{disc.discussionState.targetViewLabel}</strong></span>
            {:else}
              <span class="context-warn">当前暂无可修订的笔记，请先生成任意形式的笔记</span>
            {/if}
          {:else}
            {activeMode.hint}
          {/if}
        </span>
      </div>
      <div class="assistant-topbar-actions">
        <button
          type="button"
          class="text-button"
          class:hidden={!disc.discussionState.items.length}
          disabled={disc.discussionState.sending}
          onclick={() => disc.clearDiscussionHistory()}
        >清空</button>
        <button
          type="button"
          class="text-button assistant-close"
          aria-label="收起 AI 助教"
          onclick={() => ctrl.closeAssistantPane()}
        >收起 ▾</button>
      </div>
    </header>

    {#if disc.discussionState.lastRevisionUndo}
      <div class="revision-undo-bar" role="status">
        <span>已更新「{disc.discussionState.lastRevisionUndo.label}」</span>
        <button
          type="button"
          class="text-button"
          disabled={disc.discussionState.sending}
          onclick={() => disc.undoLastRevision()}
        >撤回修订</button>
      </div>
    {/if}

    {#if disc.discussionState.items.length}
      <div class="conversation-history" id="conversation-history" aria-live="polite">
        {#each disc.discussionState.items as item, index (index)}
          <article class:from-user={item.role === 'user'} class:from-assistant={item.role !== 'user'} class="conversation-message">
            <strong>{speakerLabel(item)}</strong>
            <div
              class="conversation-message-body"
              use:timestampedText={{ text: item.content || '', videoUrl: disc.getActiveDiscussionVideoUrl() }}
            ></div>
            {#if item.role !== 'user' && (item.mode || 'revise') !== 'revise'}
              <div class="conversation-message-actions">
                <button
                  type="button"
                  class="text-button conversation-pin-btn"
                  onclick={() => ctrl.saveDiscussionItemToPersonalNote(index)}
                >📌 记入批注</button>
              </div>
            {/if}
          </article>
        {/each}
      </div>
    {:else}
      <div class="assistant-starters" aria-label="快捷提问示例">
        <span class="assistant-starters-label">试试这样开始：</span>
        <div class="assistant-starters-list">
          {#each activeMode.starters as chip (chip.label)}
            <button
              type="button"
              class="starter-chip"
              disabled={disc.discussionState.sending || (activeMode.id === 'revise' && !disc.discussionState.hasRevisableMarkdown)}
              onclick={() => disc.applyStarterPrompt(chip.prompt, chip.autoSend !== false)}
            >{chip.label}</button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="discussion-composer">
      <label class="sr-only" for="discussion-input">AI 助教输入内容</label>
      <textarea
        id="discussion-input"
        class="discussion-input"
        rows="2"
        bind:value={disc.discussionState.input}
        onkeydown={(event) => event.key === 'Enter' && (event.ctrlKey || event.metaKey) && (event.preventDefault(), disc.sendDiscussion())}
        placeholder={activeMode.placeholder}
        disabled={disc.discussionState.sending}
      ></textarea>
      <div class="discussion-footer">
        <span>Ctrl/Cmd + Enter 发送</span>
        {#if disc.discussionState.sending}<button class="text-button" type="button" onclick={() => disc.cancelDiscussion()}>取消</button>{/if}
        <button
          class="secondary-button"
          id="send-discussion"
          type="button"
          disabled={disc.discussionState.sending || !disc.discussionState.input.trim() || (activeMode.id === 'revise' && !disc.discussionState.hasRevisableMarkdown)}
          onclick={() => disc.sendDiscussion()}
        >{disc.discussionState.sending ? '正在处理…' : activeMode.submitLabel}</button>
      </div>
    </div>
  </aside>
</div>

<style>
  .discussion-sheet-shell {
    position: fixed;
    left: 200px;
    right: 0;
    bottom: 0;
    z-index: 48;
    display: flex;
    justify-content: center;
    padding: 0 32px;
    pointer-events: none;
  }

  .discussion-panel {
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    width: min(960px, 100%);
    max-height: min(62vh, 540px);
    min-width: 0;
    margin: 0;
    border: 1px solid var(--control);
    border-bottom: 0;
    border-radius: 14px 14px 0 0;
    padding: 12px 20px 14px;
    background: var(--surface);
    box-shadow: 0 -12px 36px #20262224;
    transform: translateY(calc(100% + 24px));
    visibility: hidden;
    transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1), visibility 220ms;
  }

  .discussion-panel.is-open {
    transform: translateY(0);
    visibility: visible;
  }

  .assistant-topbar {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
  }

  .assistant-topbar-main {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }

  .assistant-context-inline {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
  }

  .assistant-topbar-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
  }

  .assistant-close {
    min-height: 28px;
    padding: 2px 8px;
    color: var(--muted);
    font-size: 12.5px;
    font-weight: 500;
  }

  .assistant-close:hover {
    background: var(--well);
    color: var(--ink);
  }

  .context-target strong {
    color: var(--accent);
    font-weight: 600;
  }

  .context-warn {
    color: var(--danger);
  }

  .revision-undo-bar {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 8px;
    border: 1px solid var(--success-border);
    border-radius: 8px;
    padding: 6px 10px;
    background: var(--success-fill);
    font-size: 12px;
    color: var(--success);
  }

  .revision-undo-bar :global(.text-button) {
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
  }

  .conversation-history {
    display: grid;
    flex: 1 1 auto;
    min-height: 0;
    max-height: 30vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    gap: 10px;
    margin-top: 10px;
  }

  .conversation-message {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--well);
  }

  .conversation-message.from-user {
    background: var(--active);
  }

  .conversation-message strong {
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }

  .conversation-message-body {
    margin: 4px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 14px;
    line-height: 1.75;
  }

  .conversation-message-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 6px;
  }

  .conversation-pin-btn {
    min-height: 24px;
    padding: 2px 6px;
    color: var(--accent);
    font-size: 12px;
    font-weight: 500;
  }

  .assistant-starters {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    margin-top: 10px;
  }

  .assistant-starters-label {
    color: var(--muted);
    font-size: 12px;
  }

  .assistant-starters-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .starter-chip {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 10px;
    background: var(--well);
    color: var(--ink);
    font-size: 12px;
    line-height: 1.4;
    text-align: left;
  }

  .starter-chip:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--active);
    color: var(--accent);
  }

  .discussion-composer {
    flex: none;
    margin-top: 10px;
  }

  .discussion-input {
    display: block;
    width: 100%;
    min-height: 64px;
    max-height: 160px;
    resize: vertical;
    border: 1px solid var(--control);
    border-radius: 8px;
    padding: 8px 12px;
    background: var(--surface);
    color: var(--ink);
    font-size: 14px;
    line-height: 1.65;
  }

  .discussion-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    margin-top: 8px;
  }

  .discussion-footer > span {
    color: var(--muted);
    font-size: 12px;
  }

  @media (max-width: 1100px) {
    .discussion-sheet-shell {
      left: 176px;
      padding: 0 24px;
    }
  }

  @media (max-width: 700px) {
    .discussion-sheet-shell {
      left: 0;
      padding: 0 12px;
    }

    .discussion-panel {
      max-height: 75vh;
      padding: 12px 14px;
    }

    .discussion-input {
      font-size: 16px;
    }
  }
</style>
