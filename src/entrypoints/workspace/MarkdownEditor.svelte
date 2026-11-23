<script lang="ts">
  import * as ctrl from '../../lib/workspace/controller.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';
</script>

<section class="markdown-editor-panel" class:hidden={!workspace.hasMarkdown} id="markdown-editor-panel" data-mode={workspace.markdownMode} aria-label="编辑 Markdown 笔记">
  <div class="markdown-editor-toolbar">
    <div class="markdown-view-modes" role="group" aria-label="笔记查看模式">
      <button class="mode-tab" id="markdown-mode-preview" type="button" aria-pressed={workspace.markdownMode === 'preview'} onclick={() => ctrl.setMarkdownEditMode('preview')}>预览</button>
      <button class="mode-tab" id="edit-markdown" type="button" aria-pressed={workspace.markdownMode === 'edit'} onclick={() => ctrl.setMarkdownEditMode('edit')}>编辑</button>
    </div>
    <div class="markdown-editor-actions" class:hidden={!workspace.markdownEditing || (workspace.markdownMode === 'preview' && !workspace.hasUnsavedMarkdown)} id="markdown-editor-actions">
      <button class="text-button" id="cancel-markdown-edit" type="button" onclick={() => ctrl.cancelMarkdownEditing()}>放弃修改</button>
      <button class="secondary-button" id="save-markdown-edit" type="button" title="快捷键 Ctrl/Cmd + S" disabled={workspace.markdownSaving} onclick={() => ctrl.saveMarkdownEditing()}>{workspace.markdownSaving ? '正在保存…' : '保存修改'}</button>
    </div>
  </div>

  <div class="markdown-edit-layout" id="markdown-edit-layout">
    <label class="sr-only" for="markdown-editor">Markdown 笔记内容</label>
    <textarea class:hidden={!workspace.markdownEditing || workspace.markdownMode === 'preview'} id="markdown-editor" bind:value={workspace.markdownDraft} oninput={() => ctrl.updateMarkdownDraftPreview()} spellcheck="false"></textarea>
    <article class="markdown-output" class:hidden={workspace.markdownEditing && workspace.markdownMode === 'edit'} id="markdown-output" aria-label="Markdown 笔记预览"></article>
  </div>

  <div class="markdown-editor-footer" class:hidden={!workspace.markdownEditing}>
    <span>保存后写入本机笔记；Ctrl/Cmd + S 可快速保存。</span>
  </div>
</section>

<style>
  .markdown-editor-panel {
    min-width: 0;
    margin-top: 16px;
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

  .markdown-editor-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
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
    padding: 16px 0;
    background: var(--surface);
    color: var(--ink);
  }

  .markdown-editor-panel textarea {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: 65vh;
    resize: vertical;
    margin-top: 16px;
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
    .markdown-editor-panel textarea {
      min-height: 60vh;
      padding: 16px;
    }
  }
</style>
