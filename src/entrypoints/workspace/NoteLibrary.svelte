<script lang="ts">
  import { tick } from 'svelte';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import * as fc from '../../lib/workspace/flashcards.svelte.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  async function focusRenameInput(node: HTMLInputElement) {
    await tick();
    node.focus();
    node.select();
  }
</script>

<section class="recent-notes" class:hidden={workspace.activeView !== 'library'} id="recent-notes" aria-label="本机笔记库">
  <header class="notes-library-heading">
    <div>
      <p class="section-label">本机资料</p>
      <h2>已保存笔记 <span id="notes-count">{workspace.noteCountLabel}</span></h2>
    </div>
    <div class="notes-library-actions">
      <button class="text-button" class:hidden={!workspace.totalCacheBytes || workspace.generating} id="library-clear-cache" type="button" disabled={workspace.clearingCache} title="删除所有课程的音轨、原视频与转写过程数据，仅保留笔记结果" onclick={() => ctrl.clearAllProcessCache()}>清理缓存 · {workspace.totalCacheLabel}</button>
      <button class="text-button" id="review-due-flashcards" type="button" disabled={fc.flashcardState.loadingDue} onclick={() => fc.startDueFlashcardReview()} title={fc.flashcardState.dueButtonTitle}>{fc.flashcardState.dueButtonLabel}</button>
      <button class="text-button" id="export-all-flashcards" type="button" onclick={() => fc.exportAllFlashcardsToAnki()} title="将所有课程的闪卡合并导入 Anki">导出全部闪卡</button>
      <details class="library-tools">
        <summary>远程同步</summary>
        <div class="library-tools-menu">
          <button class="text-button" id="remote-notes-sync" type="button" onclick={() => ctrl.transferRemoteNotesBackup('sync')} title="先合并远程更改，再安全上传本机笔记">立即同步</button>
          <button class="text-button" id="remote-notes-upload" type="button" onclick={() => ctrl.transferRemoteNotesBackup('upload')} title="将本机笔记库上传到设置的远程同步端点">上传远程备份</button>
          <button class="text-button" id="remote-notes-download" type="button" onclick={() => ctrl.transferRemoteNotesBackup('download')} title="下载远程备份，并按更新时间合并到本机">合并远程备份</button>
        </div>
      </details>
    </div>
  </header>

  <div class="notes-library-toolbar" aria-label="筛选与显示方式">
    <label class="sr-only" for="notes-search">搜索笔记</label>
    <input id="notes-search" bind:value={workspace.notesSearch} oninput={() => ctrl.onNotesSearchInput()} type="search" placeholder="搜索课程、分 P 或正文关键词">
    <label class="sr-only" for="notes-status-filter">按状态筛选</label>
    <select id="notes-status-filter" bind:value={workspace.notesStatusFilter} onchange={() => ctrl.onNotesFilterChange()}>
      <option value="">全部状态</option>
      <option value="completed">已完成</option>
      <option value="processing">进行中</option>
      <option value="incomplete">未完成 / 失败</option>
    </select>
    <label class="sr-only" for="notes-model-filter">按模型筛选</label>
    <select id="notes-model-filter" class:hidden={workspace.availableNoteModels.length <= 1} bind:value={workspace.notesModelFilter} onchange={() => ctrl.onNotesFilterChange()}>
      <option value="">全部模型</option>
      {#each workspace.availableNoteModels as model (model)}
        <option value={model}>{model}</option>
      {/each}
    </select>
    <button
      class="text-button"
      class:hidden={!workspace.notesSearch.trim() && !workspace.notesStatusFilter && !workspace.notesModelFilter}
      id="reset-notes-filters"
      type="button"
      onclick={() => ctrl.resetNotesFilters()}
    >重置</button>
    <div class="library-view-toggle" role="group" aria-label="笔记显示方式">
      <button class="mode-tab" type="button" aria-pressed={workspace.libraryViewMode === 'grouped'} onclick={() => ctrl.setLibraryViewMode('grouped')}>按课程</button>
      <button class="mode-tab" type="button" aria-pressed={workspace.libraryViewMode === 'flat'} onclick={() => ctrl.setLibraryViewMode('flat')}>按时间</button>
    </div>
  </div>

  <p
    id="remote-backup-status"
    class="remote-backup-status"
    class:hidden={!workspace.remoteBackupConfigured || !workspace.remoteBackupStatusText}
    role="status"
    aria-live="polite"
  >{workspace.remoteBackupStatusText}</p>

  {#snippet noteRowItem(row: (typeof workspace.noteRows)[number], compact = false)}
    <article class="notes-library-row" class:is-course-child={compact}>
      {#if workspace.renamingNoteId === row.note.id}
        <div class="inline-rename-row">
          <input
            class="inline-rename-input"
            type="text"
            aria-label="修改笔记名称"
            bind:value={workspace.renamingTitle}
            use:focusRenameInput
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                ctrl.commitInlineRename(row.note);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                ctrl.cancelInlineRename();
              }
            }}
          >
          <div class="notes-library-actions">
            <button class="secondary-button" type="button" onclick={() => ctrl.commitInlineRename(row.note)}>保存</button>
            <button class="text-button" type="button" onclick={() => ctrl.cancelInlineRename()}>取消</button>
          </div>
        </div>
      {:else}
        <button class="notes-library-open" type="button" onclick={() => ctrl.openSavedNote(row.note, { returnView: 'library' })}>
          {#if !compact && row.coverUrl}<img class="notes-library-thumbnail" src={row.coverUrl} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={(event) => event.currentTarget.remove()}>{/if}
          <span class="notes-library-copy">
            <strong>{compact ? (row.partLabel || row.title) : row.title}</strong>
            <span title={row.error}>{row.meta}</span>
          </span>
        </button>
        <div class="notes-library-actions">
          {#if row.originalVideoUrl}<a class="text-button" href={row.originalVideoUrl} target="_blank" rel="noopener noreferrer" title="在新标签页打开对应的 B 站分 P">原视频</a>{/if}
          <button class="text-button" type="button" title="导出 Markdown 和截图文件夹 ZIP" onclick={() => ctrl.exportSavedNoteBundle(row.note)}>资源包</button>
          <button class="text-button" type="button" onclick={() => ctrl.startInlineRename(row.note)}>改名</button>
          <button class="text-button danger-button" type="button" onclick={() => ctrl.deleteSavedNote(row.note)}>删除</button>
        </div>
      {/if}
    </article>
  {/snippet}

  <div id="notes-list" class="notes-list">
    {#if workspace.libraryViewMode === 'grouped'}
      {#each workspace.noteGroups as group (group.key)}
        {#if group.type === 'course'}
          <details class="course-group" open>
            <summary class="course-group-summary">
              {#if group.coverUrl}<img class="notes-library-thumbnail" src={group.coverUrl} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={(event) => event.currentTarget.remove()}>{/if}
              <span class="course-group-copy">
                <strong>{group.title}</strong>
                <span>{group.rows.length} 篇分 P 笔记 · {group.updatedLabel}</span>
              </span>
            </summary>
            <div class="course-group-items">
              {#each group.rows as row (row.note.id)}
                {@render noteRowItem(row, true)}
              {/each}
            </div>
          </details>
        {:else}
          {@render noteRowItem(group.row, false)}
        {/if}
      {:else}
        <p class="notes-empty">{workspace.noteCountLabel === '0 篇' ? '还没有保存的笔记。生成课程笔记后会保存在这里。' : '没有匹配的笔记。'}</p>
      {/each}
    {:else}
      {#each workspace.noteRows as row (row.note.id)}
        {@render noteRowItem(row, false)}
      {:else}
        <p class="notes-empty">{workspace.noteCountLabel === '0 篇' ? '还没有保存的笔记。生成课程笔记后会保存在这里。' : '没有匹配的笔记。'}</p>
      {/each}
    {/if}
  </div>
  <button class="secondary-button" class:hidden={!workspace.moreNotes} id="notes-load-more" type="button" onclick={() => ctrl.loadMoreNotes()}>加载更多笔记</button>
</section>

<style>
  .recent-notes {
    min-width: 0;
    margin: 0;
  }

  .notes-library-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 14px;
  }

  .notes-library-heading > div {
    min-width: 0;
  }

  .notes-library-heading h2 {
    margin: 4px 0 0;
    font-size: 22px;
    font-weight: 600;
  }

  #notes-count {
    margin-left: 6px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 400;
  }

  .notes-library-actions {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 4px 8px;
  }

  .notes-library-actions a {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }

  .notes-library-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }

  #notes-search {
    flex: 1 1 220px;
    height: 38px;
    border: 1px solid var(--control);
    border-radius: 8px;
    padding: 0 12px;
    background: var(--surface);
    color: var(--ink);
    font-size: 13px;
  }

  .notes-library-toolbar select {
    height: 38px;
    border: 1px solid var(--control);
    border-radius: 8px;
    padding: 0 10px;
    background: var(--surface);
    color: var(--ink);
    font-size: 13px;
  }

  .remote-backup-status {
    margin: 10px 0 0;
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .notes-list {
    margin-top: 8px;
  }

  .course-group {
    margin: 12px 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    overflow: hidden;
  }

  .course-group-summary {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--well);
    list-style: none;
  }

  .course-group-summary::-webkit-details-marker {
    display: none;
  }

  .course-group-summary::after {
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

  .course-group[open] > .course-group-summary::after {
    margin-top: 4px;
    transform: rotate(225deg);
  }

  .course-group-summary:hover {
    background: var(--active);
  }

  .course-group-copy {
    display: grid;
    min-width: 0;
    flex: 1;
    gap: 2px;
  }

  .course-group-copy strong {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .course-group-copy span {
    font-size: 12px;
    color: var(--muted);
  }

  .course-group-items {
    padding: 0 12px;
  }

  .course-group-items .notes-library-row:last-child {
    border-bottom: 0;
  }

  .notes-library-row {
    display: flex;
    min-height: 68px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--rule);
    padding: 8px 4px;
  }

  .notes-library-row.is-course-child {
    min-height: 54px;
    padding: 6px 4px;
  }

  .notes-library-open {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 12px;
    border: 0;
    border-radius: 8px;
    padding: 4px;
    background: transparent;
    color: var(--ink);
    text-align: left;
  }

  .notes-library-thumbnail {
    width: 88px;
    height: 52px;
    flex: none;
    border-radius: 4px;
    object-fit: cover;
    background: var(--well);
  }

  .notes-library-copy {
    display: grid;
    min-width: 0;
    gap: 3px;
  }

  .notes-library-open:hover strong {
    color: var(--accent);
  }

  .notes-library-open strong {
    overflow: hidden;
    color: var(--ink);
    font-size: 14px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .notes-library-open span {
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .inline-rename-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 8px;
  }

  .inline-rename-input {
    flex: 1;
    height: 36px;
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 0 10px;
    background: var(--surface);
    color: var(--ink);
    font-size: 14px;
  }

  .notes-empty {
    margin: 0;
    padding: 24px 4px;
    color: var(--muted);
    font-size: 13px;
  }

  #notes-load-more {
    margin-top: 16px;
  }

  @media (max-width: 700px) {
    #notes-search {
      font-size: 16px;
    }

    .notes-library-toolbar {
      flex-direction: column;
      align-items: stretch;
    }

    .notes-library-row {
      flex-direction: column;
      align-items: stretch;
      gap: 4px;
      padding: 12px 0;
    }

    .notes-library-actions {
      justify-content: flex-start;
    }
  }
</style>
