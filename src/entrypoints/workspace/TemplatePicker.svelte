<svelte:options runes={true} />

<script lang="ts">
  import { NOTE_STRUCTURES } from '../../lib/note-structures.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';
</script>

<div class="template-toolbar">
  <p class="template-instruction">选一种整理方式，生成后仍可编辑。</p>
</div>
<div class="template-list" id="template-list" role="group" aria-label="笔记模板">
  {#each NOTE_STRUCTURES as template (template.id)}
    <button class="template-chip" type="button" aria-pressed={workspace.selectedTemplate === template.id} onclick={() => (workspace.selectedTemplate = template.id)}>
      <span class="template-copy"><strong>{template.label}</strong><small>{template.description}</small></span>
    </button>
  {/each}
</div>
