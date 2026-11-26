<svelte:options runes={true} />

<script lang="ts">
  import { NOTE_STRUCTURES } from '../../lib/note-structures.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  const primaryStructures = NOTE_STRUCTURES.filter((item) => ['study', 'brief', 'tutorial', 'timeline'].includes(item.id));
  const secondaryOrder = ['quiz', 'flashcards', 'custom'] as const;
  const secondaryStructures = secondaryOrder
    .map((id) => NOTE_STRUCTURES.find((item) => item.id === id))
    .filter((item): item is (typeof NOTE_STRUCTURES)[number] => Boolean(item));
  const tagByStructure: Record<string, string> = {
    quiz: '练习',
    flashcards: '练习',
    custom: '自由',
  };
</script>

<div class="structure-picker" id="template-list" role="group" aria-label="笔记形式">
  <p class="structure-hint">选择先生成的内容形式，之后可在笔记页随时补充或切换其他形式。</p>
  <div class="structure-grid primary">
    {#each primaryStructures as template (template.id)}
      <button
        class="structure-card"
        type="button"
        aria-pressed={workspace.selectedTemplate === template.id}
        onclick={() => (workspace.selectedTemplate = template.id)}
      >
        <div class="structure-card-head">
          <strong>{template.label}</strong>
          <span class="structure-check" aria-hidden="true"></span>
        </div>
        <small>{template.description}</small>
      </button>
    {/each}
  </div>
  <div class="structure-grid secondary">
    {#each secondaryStructures as template (template.id)}
      {@const badge = tagByStructure[template.id] || ''}
      <button
        class="structure-card"
        type="button"
        aria-pressed={workspace.selectedTemplate === template.id}
        onclick={() => (workspace.selectedTemplate = template.id)}
      >
        <div class="structure-card-head">
          <span class="structure-card-title">
            <strong>{template.label}</strong>
            {#if badge}<em class="structure-tag">{badge}</em>{/if}
          </span>
          <span class="structure-check" aria-hidden="true"></span>
        </div>
        <small>{template.description}</small>
      </button>
    {/each}
  </div>
</div>

<style>
  .structure-picker {
    display: grid;
    gap: 8px;
    margin-top: 4px;
  }

  .structure-hint {
    margin: 0 0 2px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .structure-grid {
    display: grid;
    gap: 8px;
  }

  .structure-grid.primary {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .structure-grid.secondary {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .structure-card {
    display: grid;
    min-width: 0;
    min-height: 68px;
    align-content: center;
    gap: 4px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 13px;
    background: var(--surface);
    color: var(--ink);
    text-align: left;
  }

  .structure-card:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--well);
  }

  .structure-card[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--active);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .structure-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .structure-card-title {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
  }

  .structure-card-head strong {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.35;
  }

  .structure-tag {
    border-radius: 999px;
    padding: 0 6px;
    background: var(--well);
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 10px;
    font-style: normal;
    font-weight: 500;
    line-height: 1.6;
  }

  .structure-card[aria-pressed='true'] .structure-tag {
    background: var(--surface);
    border-color: var(--control);
    color: var(--accent);
  }

  .structure-check {
    width: 14px;
    height: 14px;
    flex: none;
    border: 1.5px solid var(--control);
    border-radius: 50%;
    background: transparent;
    transition: border-color 150ms ease, background-color 150ms ease;
  }

  .structure-card[aria-pressed='true'] .structure-check {
    border: 4px solid var(--accent);
    background: var(--surface);
  }

  .structure-card small {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
  }

  @media (max-width: 820px) {
    .structure-grid.primary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 640px) {
    .structure-grid.secondary {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (max-width: 540px) {
    .structure-grid.primary {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
