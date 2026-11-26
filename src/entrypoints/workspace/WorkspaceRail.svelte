<script lang="ts">
  import { Keji, type NoteSummary, type VideoPart } from '../../lib/keji.ts';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  const filteredParts = $derived.by(() => {
    const query = workspace.partSearch.trim().toLowerCase();
    if (!query) return workspace.parts;
    return workspace.parts.filter((part) => {
      const pageStr = String(part.page || '');
      return pageStr.includes(query)
        || `p${pageStr}`.includes(query)
        || String(part.part || '').toLowerCase().includes(query);
    });
  });

  async function choosePart(part: VideoPart) {
    ctrl.closeCourseDrawer();
    await ctrl.selectPart(part);
  }

  function openPartNote(savedNote: NoteSummary) {
    const returnView = workspace.activeView === 'note' ? workspace.noteReturnView : 'create';
    ctrl.closeCourseDrawer();
    void ctrl.openSavedNote(savedNote, { returnView });
  }
</script>

<div
  class="course-drawer-backdrop"
  class:open={workspace.courseDrawerOpen}
  class:hidden={workspace.parts.length <= 1}
  onclick={() => ctrl.closeCourseDrawer()}
  aria-hidden="true"
></div>

<aside
  class="course-drawer"
  class:open={workspace.courseDrawerOpen}
  class:hidden={workspace.parts.length <= 1}
  id="course-drawer"
  aria-label="课程选集"
  aria-hidden={!workspace.courseDrawerOpen}
>
  <header class="course-drawer-header">
    <div class="course-drawer-top">
      <p class="section-label">课程选集</p>
      <button class="drawer-close" type="button" aria-label="关闭课程选集" onclick={() => ctrl.closeCourseDrawer()}>×</button>
    </div>
    <h3 id="course-title">{workspace.courseTitle}</h3>
    <p id="course-meta" class="course-meta">
      共 {workspace.parts.length} 节 · 已记笔记 {Object.keys(workspace.courseNotesByPage).length} 节
    </p>
    {#if workspace.parts.length >= 6}
      <label class="sr-only" for="course-part-search">搜索选集</label>
      <input
        id="course-part-search"
        class="part-search-input"
        type="search"
        bind:value={workspace.partSearch}
        placeholder="搜索集数或小节标题…"
      >
    {/if}
  </header>

  <nav id="part-list" class="course-drawer-list" aria-label="课程选集列表">
    {#each filteredParts as part (part.page)}
      {@const savedNote = workspace.courseNotesByPage[Number(part.page)]}
      {@const isCurrent = Number(part.page) === workspace.currentPage}
      <div class="part-row" class:is-current={isCurrent}>
        <button class="part-item" type="button" aria-current={isCurrent ? 'true' : undefined} aria-label={`第 ${part.page} 节：${part.part}`} onclick={() => choosePart(part)}>
          <span class="part-number">{String(part.page).padStart(2, '0')}</span>
          <span class="part-copy">
            <span class="part-name">{part.part}</span>
            <span class="part-duration">{part.duration ? Keji.formatTime(part.duration) : ''}</span>
          </span>
          {#if isCurrent}<span class="part-current-state">当前</span>{/if}
        </button>
        {#if savedNote}
          <button class="part-note-badge" type="button" title="打开本节已保存的笔记" onclick={() => openPartNote(savedNote)}>已记 · 查看</button>
        {/if}
      </div>
    {:else}
      <p class="part-empty">{workspace.parts.length ? '没有匹配的小节。' : '当前视频仅 1 节，无选集目录。'}</p>
    {/each}
  </nav>
</aside>
