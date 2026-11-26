<script lang="ts">
  import { getNoteStructure, isNoteViewKey } from '../../lib/note-structures.ts';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  interface OutlineItem {
    index: number;
    level: number;
    text: string;
  }

  let outlineOpen = $state(false);
  let outlineItems = $state<OutlineItem[]>([]);

  const activeStructure = $derived(getNoteStructure(isNoteViewKey(workspace.noteTab) ? workspace.noteTab : 'study'));
  const isCustomTab = $derived(workspace.noteTab === 'custom');
  const isGeneratingThisTab = $derived(workspace.activeNoteGenerating && workspace.generatingView === workspace.noteTab);
  const isFailedThisTab = $derived(Boolean(workspace.generationError && workspace.failedView === workspace.noteTab));

  $effect(() => {
    workspace.noteTab;
    workspace.markdownEditing;
    workspace.markdownMode;
    outlineOpen = false;
  });

  function refreshOutline(forceOpen = outlineOpen) {
    if (!forceOpen) return;
    const container = document.getElementById('markdown-output');
    if (!container) {
      outlineItems = [];
      return;
    }
    outlineItems = [...container.querySelectorAll<HTMLElement>('h2, h3')].map((heading, index) => ({
      index,
      level: heading.tagName === 'H3' ? 3 : 2,
      text: heading.textContent?.trim() || `第 ${index + 1} 节`,
    }));
  }

  $effect(() => {
    if (outlineOpen) refreshOutline(true);
  });

  function jumpToOutlineHeading(index: number) {
    outlineOpen = false;
    const container = document.getElementById('markdown-output');
    const target = container?.querySelectorAll<HTMLElement>('h2, h3')[index];
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
</script>

<section class="markdown-editor-panel" id="markdown-editor-panel" data-mode={workspace.markdownMode} aria-label="编辑 Markdown 笔记">
  <div class="markdown-editor-toolbar" class:hidden={!workspace.hasMarkdown || !workspace.markdownEditing}>
    <div class="markdown-toolbar-left">
      <div class="markdown-view-modes" role="group" aria-label="编辑查看模式">
        <button class="mode-tab" id="markdown-mode-edit" type="button" aria-pressed={workspace.markdownMode === 'edit'} onclick={() => ctrl.setMarkdownEditMode('edit')}>编辑</button>
        <button class="mode-tab" id="markdown-mode-preview" type="button" aria-pressed={workspace.markdownMode === 'preview'} onclick={() => ctrl.setMarkdownEditMode('preview')}>预览</button>
      </div>
      {#if workspace.markdownMode === 'preview'}
        <details
          class="action-menu note-outline"
          bind:open={outlineOpen}
          ontoggle={(event) => {
            const el = event.currentTarget as HTMLDetailsElement;
            if (el.open) refreshOutline(true);
          }}
        >
          <summary class="text-button">章节目录</summary>
          <div class="action-menu-content note-outline-menu">
            {#each outlineItems as item (item.index)}
              <button
                type="button"
                class="text-button note-outline-item"
                class:is-sub={item.level === 3}
                onclick={() => jumpToOutlineHeading(item.index)}
              >{item.text}</button>
            {:else}
              <span class="note-outline-empty">当前笔记暂无章节标题</span>
            {/each}
          </div>
        </details>
      {/if}
    </div>

    <div class="markdown-toolbar-right">
      <div class="markdown-editor-actions" class:hidden={!workspace.markdownEditing} id="markdown-editor-actions">
        <button class="text-button" id="cancel-markdown-edit" type="button" onclick={() => ctrl.cancelMarkdownEditing()}>{workspace.hasUnsavedMarkdown ? '放弃修改' : '退出编辑'}</button>
        <button class="secondary-button" id="save-markdown-edit" type="button" title="快捷键 Ctrl/Cmd + S" disabled={workspace.markdownSaving || !workspace.hasUnsavedMarkdown} onclick={() => ctrl.saveMarkdownEditing()}>{workspace.markdownSaving ? '正在保存…' : '保存修改'}</button>
      </div>
    </div>
  </div>

  {#if isCustomTab && workspace.hasMarkdown && !workspace.markdownEditing}
    <details class="custom-tab-prompt-bar">
      <summary class="text-button">自定义生成要求</summary>
      <div class="custom-tab-prompt-body">
        <label class="sr-only" for="custom-tab-prompt-inline">自定义笔记要求</label>
        <textarea
          id="custom-tab-prompt-inline"
          class="custom-tab-textarea"
          rows="3"
          bind:value={workspace.customPrompt}
          placeholder="描述你希望模型如何整理本节课程内容…"
          aria-label="自定义笔记要求"
        ></textarea>
        <div class="custom-tab-prompt-actions">
          <button
            class="secondary-button"
            type="button"
            disabled={!workspace.canRegenerateActiveTab || workspace.generating || !workspace.customPrompt.trim()}
            onclick={() => ctrl.regenerateActiveNoteTab()}
          >按此要求重新生成</button>
        </div>
      </div>
    </details>
  {/if}

  {#if !workspace.hasMarkdown}
    <div class="note-tab-empty-card">
      {#if isGeneratingThisTab}
        <div class="note-tab-empty-copy">
          <strong>等待本节「{activeStructure.label}」首段内容…</strong>
          <p>完成后将自动展示并保存到本机，期间可切换其他标签页查看已有笔记或自测。</p>
        </div>
      {:else}
        <div class="note-tab-empty-copy">
          <strong>{isFailedThisTab ? `本节「${activeStructure.label}」生成未完成` : `还没有本节「${activeStructure.label}」`}</strong>
          <p>
            {isFailedThisTab
              ? '检查模型配置或 API 额度后可直接重试，也可以切换其他标签页查看已有内容。'
              : `${activeStructure.description}。生成后将独立保存，不会覆盖其他形式的内容。`}
          </p>
        </div>
        {#if isCustomTab}
          <label class="sr-only" for="custom-tab-prompt">自定义笔记要求</label>
          <textarea
            id="custom-tab-prompt"
            class="custom-tab-textarea"
            rows="3"
            bind:value={workspace.customPrompt}
            placeholder="描述你希望模型如何整理本节课程内容…"
            aria-label="自定义笔记要求"
          ></textarea>
        {/if}
        {#if !workspace.canRegenerateActiveTab}
          <p class="note-tab-empty-hint">当前缺少课程文字稿；请先返回「当前课程」获取字幕或语音转写，或在设置中改用支持音视频理解的模型。</p>
        {/if}
        <button
          class="primary-button note-tab-generate-button"
          type="button"
          disabled={workspace.generating || !workspace.canRegenerateActiveTab || (isCustomTab && !workspace.customPrompt.trim())}
          onclick={() => ctrl.generateActiveNoteTab()}
        >{workspace.generating && !workspace.activeNoteGenerating ? '后台已有任务生成中…' : isFailedThisTab ? `重试生成${activeStructure.label}` : `生成本节${activeStructure.label}`}</button>
      {/if}
    </div>
  {/if}

  <div
    class="markdown-edit-layout"
    class:is-preview-sheet={workspace.markdownEditing && workspace.markdownMode === 'preview'}
    id="markdown-edit-layout"
  >
    <label class="sr-only" for="markdown-editor">Markdown 笔记内容</label>
    <textarea
      class:hidden={!workspace.hasMarkdown || !workspace.markdownEditing || workspace.markdownMode === 'preview'}
      id="markdown-editor"
      bind:value={workspace.markdownDraft}
      oninput={() => ctrl.updateMarkdownDraftPreview()}
      spellcheck="false"
    ></textarea>
    <article class="markdown-output" class:hidden={!workspace.hasMarkdown || (workspace.markdownEditing && workspace.markdownMode === 'edit')} id="markdown-output" aria-label="Markdown 笔记预览"></article>
  </div>

  <div class="markdown-editor-footer" class:hidden={!workspace.hasMarkdown || !workspace.markdownEditing}>
    <span>截图已自动折叠为短标记（保存时无损还原）· 修改仅存本机 · Ctrl/Cmd + S 快速保存</span>
  </div>
</section>

<style>
  .markdown-editor-panel {
    min-width: 0;
    margin-top: 4px;
  }

  .markdown-editor-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 10px;
  }

  .markdown-toolbar-left {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .markdown-toolbar-right {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .markdown-editor-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .note-outline-menu {
    width: 260px;
  }

  .note-outline-item.is-sub {
    padding-left: 22px;
    font-size: 12px;
  }

  .note-outline-empty {
    padding: 8px 10px;
    color: var(--muted);
    font-size: 12px;
  }

  .custom-tab-prompt-bar {
    margin-top: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 6px 12px;
    background: var(--well);
  }

  .custom-tab-prompt-bar > summary {
    list-style: none;
    justify-content: flex-start;
    color: var(--ink);
    font-weight: 500;
  }

  .custom-tab-prompt-body {
    display: grid;
    gap: 10px;
    padding: 8px 0 4px;
  }

  .custom-tab-prompt-actions {
    display: flex;
    justify-content: flex-end;
  }

  .custom-tab-textarea {
    display: block;
    width: 100%;
    min-height: 88px;
    resize: vertical;
    border: 1px solid var(--control);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--surface);
    color: var(--ink);
    font-size: 13px;
    line-height: 1.65;
  }

  .note-tab-empty-card {
    display: grid;
    max-width: 820px;
    gap: 14px;
    margin: 16px auto 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    background: var(--well);
  }

  .note-tab-empty-copy strong {
    display: block;
    font-size: 16px;
    font-weight: 600;
  }

  .note-tab-empty-copy p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }

  .note-tab-empty-hint {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .note-tab-generate-button {
    width: auto;
    justify-self: start;
    margin-top: 0;
  }

  .markdown-edit-layout {
    min-width: 0;
  }

  .markdown-output {
    min-width: 0;
    min-height: 30vh;
    max-height: none;
    margin: 0;
    border: 0;
    padding: 12px 0 16px;
    background: var(--surface);
    color: var(--ink);
  }

  .markdown-edit-layout.is-preview-sheet > .markdown-output {
    margin-top: 14px;
    border: 1px dashed var(--control);
    border-radius: 10px;
    padding: 20px 24px;
    background: var(--surface);
  }

  .markdown-editor-panel > .markdown-edit-layout > textarea {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: 65vh;
    resize: vertical;
    margin-top: 14px;
    border: 1px solid var(--control);
    border-radius: 8px;
    padding: 20px;
    background: var(--well);
    color: var(--ink);
    font: 14px/1.8 var(--font-code);
    tab-size: 2;
  }

  .markdown-editor-footer {
    margin-top: 12px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
  }

  @media (max-width: 700px) {
    .markdown-editor-panel > .markdown-edit-layout > textarea {
      min-height: 60vh;
      padding: 16px;
    }

    .custom-tab-textarea {
      font-size: 16px;
    }
  }
</style>
