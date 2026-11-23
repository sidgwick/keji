<script lang="ts">
  import type { ConversationItem, DiscussionMode } from '../../lib/keji.ts';
  import { renderMessageWithTimestamps } from '../../lib/markdown.ts';
  import * as disc from '../../lib/workspace/discussion.svelte.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  const modes: Array<{ id: DiscussionMode; label: string; hint: string; placeholder: string; submitLabel: string }> = [
    {
      id: 'qa',
      label: '课程答疑',
      hint: '针对概念、推导或代码细节提问，模型会对照讲稿解答并附原视频时间戳（不改动笔记正文）。',
      placeholder: '例如：为什么这里要先做这一步初始化？请结合原视频对应片段解释一下',
      submitLabel: '发送提问',
    },
    {
      id: 'feynman',
      label: '费曼复述',
      hint: '尝试用自己的话复述本节核心逻辑，模型会对照原课程指出理解准确处、遗漏偏差与边界追问（不改动笔记正文）。',
      placeholder: '用自己的话复述一遍这节课讲了什么原理、怎么推出来的、有什么限制条件…',
      submitLabel: '提交复述并批改',
    },
    {
      id: 'revise',
      label: '修订笔记',
      hint: '直接修改或补充当前笔记排版与内容，修订结果会写回本机笔记并保留原有截图。',
      placeholder: '例如：把第三章的概念对比整理成表格，并保留原有截图和时间戳',
      submitLabel: '发送并更新笔记',
    },
  ];

  const activeMode = $derived(modes.find((item) => item.id === disc.discussionState.mode) || modes[0]!);

  function speakerLabel(item: ConversationItem): string {
    const mode = item.mode || 'revise';
    if (item.role === 'user') {
      return mode === 'qa' ? '你的提问' : mode === 'feynman' ? '我的费曼复述' : '修订要求';
    }
    return mode === 'qa' ? '课程答疑' : mode === 'feynman' ? '费曼点评' : '调整记录';
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

<details class="discussion-disclosure" class:hidden={!workspace.showDiscussion}>
  <summary>学习互动与完善 <span>课程答疑、费曼复述批改或修订笔记</span></summary>
  <section class="discussion-panel" id="discussion-panel" aria-labelledby="discussion-title">
    <header class="discussion-heading">
      <div>
        <p class="section-label">加深理解</p>
        <h3 id="discussion-title">课程答疑 · 费曼复述 · 修订笔记</h3>
        <p class="discussion-hint">{activeMode.hint}</p>
      </div>
      <div class="discussion-toolbar">
        <div class="markdown-view-modes" role="group" aria-label="互动模式">
          {#each modes as item (item.id)}
            <button
              type="button"
              class="mode-tab"
              aria-pressed={disc.discussionState.mode === item.id}
              onclick={() => disc.setDiscussionMode(item.id)}
            >{item.label}</button>
          {/each}
        </div>
        <button
          type="button"
          class="text-button"
          class:hidden={!disc.discussionState.items.length}
          disabled={disc.discussionState.sending}
          onclick={() => disc.clearDiscussionHistory()}
        >清空记录</button>
      </div>
    </header>

    <div class="conversation-history" id="conversation-history" aria-live="polite">
      {#each disc.discussionState.items as item, index (index)}
        <article class:from-user={item.role === 'user'} class:from-assistant={item.role !== 'user'} class="conversation-message">
          <strong>{speakerLabel(item)}</strong>
          <div
            class="conversation-message-body"
            use:timestampedText={{ text: item.content || '', videoUrl: disc.getActiveDiscussionVideoUrl() }}
          ></div>
        </article>
      {/each}
    </div>

    <label class="sr-only" for="discussion-input">学习互动输入内容</label>
    <textarea
      id="discussion-input"
      class="discussion-input"
      rows="3"
      bind:value={disc.discussionState.input}
      onkeydown={(event) => event.key === 'Enter' && (event.ctrlKey || event.metaKey) && (event.preventDefault(), disc.sendDiscussion())}
      placeholder={activeMode.placeholder}
      disabled={disc.discussionState.sending}
    ></textarea>
    <div class="discussion-footer">
      <span>互动记录随笔记保存在本机 · Ctrl/Cmd + Enter 发送</span>
      <button
        class="secondary-button"
        id="send-discussion"
        type="button"
        disabled={disc.discussionState.sending || !disc.discussionState.input.trim()}
        onclick={() => disc.sendDiscussion()}
      >{disc.discussionState.sending ? '正在处理…' : activeMode.submitLabel}</button>
    </div>
  </section>
</details>

<style>
  .discussion-disclosure {
    margin-top: 32px;
    border-top: 1px solid var(--border);
  }

  .discussion-disclosure > summary {
    display: flex;
    min-height: 44px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-radius: 8px;
    padding: 8px 0;
    color: var(--muted);
    font-size: 13px;
    list-style: none;
  }

  .discussion-disclosure > summary::-webkit-details-marker {
    display: none;
  }

  .discussion-disclosure > summary::after {
    width: 6px;
    height: 6px;
    flex: none;
    margin: -4px 4px 0;
    border-right: 1px solid currentColor;
    border-bottom: 1px solid currentColor;
    content: "";
    transform: rotate(45deg);
    transition: transform 150ms ease;
  }

  .discussion-disclosure[open] > summary::after {
    margin-top: 4px;
    transform: rotate(225deg);
  }

  .discussion-disclosure > summary:hover {
    color: var(--accent);
  }

  .discussion-panel {
    margin-top: 8px;
  }

  .discussion-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px 16px;
  }

  .discussion-heading > div:first-child {
    min-width: 0;
    flex: 1 1 320px;
  }

  .discussion-heading h3 {
    margin: 4px 0 0;
    font-size: 18px;
    font-weight: 600;
  }

  .discussion-hint {
    max-width: 640px;
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .discussion-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .conversation-history {
    display: grid;
    gap: 12px;
    margin-top: 16px;
  }

  .conversation-message {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    background: var(--well);
  }

  .conversation-message.from-user {
    background: var(--active);
  }

  .conversation-message strong {
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }

  .conversation-message-body {
    margin: 4px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 15px;
    line-height: 1.8;
  }

  .discussion-input {
    display: block;
    width: 100%;
    min-height: 112px;
    resize: vertical;
    margin-top: 16px;
    border: 1px solid var(--control);
    border-radius: 8px;
    padding: 12px;
    background: var(--surface);
    color: var(--ink);
    line-height: 1.8;
  }

  .discussion-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    margin-top: 12px;
  }

  .discussion-footer > span {
    min-width: 0;
    flex: 1 1 240px;
    color: var(--muted);
    font-size: 12px;
  }

  @media (max-width: 700px) {
    .discussion-input {
      font-size: 16px;
    }
  }
</style>
