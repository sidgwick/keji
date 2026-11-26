<script lang="ts">
  import { tick } from 'svelte';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import * as fc from '../../lib/workspace/flashcards.svelte.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  const statusTabs = [
    { id: '', label: '全部' },
    { id: 'completed', label: '已完成' },
    { id: 'processing', label: '进行中' },
    { id: 'incomplete', label: '未完成' },
  ];

  function focusRenameInput(node: HTMLInputElement) {
    void tick().then(() => { node.focus(); node.select(); });
  }
</script>

<section class="recent-notes" class:hidden={workspace.activeView !== 'library'} id="recent-notes" aria-label="本机笔记库">
  {#if workspace.dashboardStats.length}
    <div class="library-stats-grid" aria-label="学习资料统计">
      {#each workspace.dashboardStats as stat (`${stat.label}:${stat.value}`)}
        <div class="library-stat-card"><strong>{stat.value}</strong><span>{stat.label}</span></div>
      {/each}
    </div>
  {/if}

  <header class="notes-library-heading">
    <div>
      <p class="section-label">本机资料</p>
      <h2>已保存笔记 <span id="notes-count">{workspace.noteCountLabel}</span></h2>
    </div>
    <div class="notes-library-actions">
      <button
        class="secondary-button"
        id="review-due-flashcards"
        type="button"
        disabled={fc.flashcardState.loadingDue}
        onclick={() => fc.startDueFlashcardReview()}
        title={fc.flashcardState.dueButtonTitle}
      >{fc.flashcardState.dueButtonLabel}</button>
      <details class="library-tools">
        <summary>管理与同步</summary>
        <div class="library-tools-menu">
          <button class="text-button" id="remote-notes-sync" type="button" onclick={() => ctrl.transferRemoteNotesBackup('sync')} title="先拉取并合并远程更改，再上传本机笔记">双向同步</button>
          <button class="text-button" id="remote-notes-upload" type="button" onclick={() => ctrl.transferRemoteNotesBackup('upload')} title="将本机笔记库上传到 WebDAV 备份地址">上传到远程</button>
          <button class="text-button" id="remote-notes-download" type="button" onclick={() => ctrl.transferRemoteNotesBackup('download')} title="下载远程备份，按更新时间合并到本机">从远程拉取合并</button>
          <button class="text-button" type="button" onclick={() => ctrl.exportLocalNotesBackup()}>导出完整备份 (.json)</button>
          <button class="text-button" type="button" onclick={() => document.getElementById('local-backup-file')?.click()}>导入完整备份</button>
          <button class="text-button" type="button" onclick={() => ctrl.restoreRecentRecoveryNote()}>恢复最近被覆盖的笔记</button>
          <input id="local-backup-file" type="file" accept="application/json,.json" hidden onchange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void ctrl.importLocalNotesBackup(file); event.currentTarget.value = ''; }} />
          <button class="text-button" id="export-all-flashcards" type="button" onclick={() => fc.exportAllFlashcardsToAnki()} title="将所有课程的闪卡合并导出为 Anki 文件 (.tsv)">导出全部闪卡 (.tsv)</button>
          <button class="text-button" class:hidden={!workspace.totalCacheBytes || workspace.generating} id="library-clear-cache" type="button" disabled={workspace.clearingCache} title="删除所有课程缓存的音轨、原视频与转写过程文件，不影响已保存的笔记" onclick={() => ctrl.clearAllProcessCache()}>清理媒体缓存 · {workspace.totalCacheLabel}</button>
        </div>
      </details>
    </div>
  </header>

  <div class="notes-library-toolbar" aria-label="筛选与显示方式">
    <label class="sr-only" for="notes-search">搜索笔记</label>
    <input id="notes-search" bind:value={workspace.notesSearch} oninput={() => ctrl.onNotesSearchInput()} type="search" placeholder="搜索课程、小节标题或正文关键词">
    <div class="status-pills" role="group" aria-label="按状态筛选">
      {#each statusTabs as tab (tab.id)}
        <button
          type="button"
          class="mode-tab"
          aria-pressed={workspace.notesStatusFilter === tab.id}
          onclick={() => ctrl.setNotesStatusFilter(tab.id)}
        >{tab.label}</button>
      {/each}
    </div>
    <label class="sr-only" for="notes-review-filter">按学习标记筛选</label>
    <select
      id="notes-review-filter"
      bind:value={workspace.notesReviewFilter}
      onchange={() => ctrl.setNotesReviewFilter(workspace.notesReviewFilter)}
    >
      <option value="">全部标记</option>
      <option value="star">⭐ 重点</option>
      <option value="question">❓ 待消化</option>
      <option value="mastered">✓ 已掌握</option>
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
      class:hidden={!workspace.notesSearch.trim() && !workspace.notesStatusFilter && !workspace.notesModelFilter && !workspace.notesReviewFilter}
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
        <button class="notes-library-open" type="button" title={row.modelTooltip || undefined} onclick={() => ctrl.openSavedNote(row.note, { returnView: 'library' })}>
          {#if !compact && row.coverUrl}<img class="notes-library-thumbnail" src={row.coverUrl} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={(event) => event.currentTarget.remove()}>{/if}
          <span class="notes-library-copy">
            <span class="note-title-line">
              <strong>{compact ? (row.partLabel || row.title) : row.title}</strong>
              {#if row.reviewMark === 'star'}<span class="note-mark-badge">⭐ 重点</span>{/if}
              {#if row.reviewMark === 'question'}<span class="note-mark-badge">❓ 待消化</span>{/if}
              {#if row.reviewMark === 'mastered'}<span class="note-mark-badge is-mastered">✓ 已掌握</span>{/if}
              {#if row.hasPersonalNote}<span class="note-mark-badge">✍️ 批注</span>{/if}
            </span>
            {#if row.summaryPreview}
              <span class="note-summary-preview">{row.summaryPreview}</span>
            {/if}
            <span class="note-meta-line">
              <span class="note-status-pill" data-tone={row.statusTone}>{row.statusText}</span>
              {#if compact ? row.compactMeta : row.meta}
                <span class="note-meta-text">{compact ? row.compactMeta : row.meta}</span>
              {/if}
            </span>
            {#if row.error && (row.statusTone === 'failed' || row.statusTone === 'incomplete')}
              <small class="note-row-error" title={row.error}>{row.error}</small>
            {/if}
          </span>
        </button>
        <div class="notes-library-actions">
          <details class="action-menu row-more-menu">
            <summary class="text-button row-more-trigger" aria-label="更多操作">···</summary>
            <div class="action-menu-content">
              {#if row.originalVideoUrl}<a class="text-button" href={row.originalVideoUrl} target="_blank" rel="noopener noreferrer">原视频 ↗</a>{/if}
              <button class="text-button" type="button" disabled={!row.canExport} title={row.canExport ? '' : '暂无已生成的笔记内容'} onclick={() => ctrl.exportSavedNoteBundle(row.note)}>导出资源包 (.zip)</button>
              <button class="text-button" type="button" onclick={() => ctrl.startInlineRename(row.note, compact && Boolean(row.note.part))}>重命名</button>
              <button class="text-button danger-button" type="button" onclick={() => ctrl.deleteSavedNote(row.note)}>删除笔记</button>
            </div>
          </details>
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
                <span>{group.progressLabel}{group.updatedLabel ? ` · ${group.updatedLabel}` : ''}</span>
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
        <p class="notes-empty">{workspace.noteCountLabel === '0 篇' ? '还没有保存的笔记。生成课程笔记后会保存在这里。' : '没有找到匹配的笔记，可尝试调整关键词或筛选条件。'}</p>
      {/each}
    {:else}
      {#each workspace.noteRows as row (row.note.id)}
        {@render noteRowItem(row, false)}
      {:else}
        <p class="notes-empty">{workspace.noteCountLabel === '0 篇' ? '还没有保存的笔记。生成课程笔记后会保存在这里。' : '没有找到匹配的笔记，可尝试调整关键词或筛选条件。'}</p>
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

  .library-stats-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 20px;
  }

  .library-stat-card {
    display: grid;
    min-width: 0;
    gap: 4px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    background: var(--well);
  }

  .library-stat-card strong {
    font-size: 19px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .library-stat-card span {
    color: var(--muted);
    font-size: 12px;
  }

  .status-pills {
    display: inline-flex;
    flex-wrap: wrap;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--well);
    gap: 2px;
  }

  .row-more-trigger {
    min-width: 32px;
    justify-content: center !important;
    font-weight: 700;
    letter-spacing: 1px;
  }

  :global(.row-more-menu > summary::after) {
    display: none !important;
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
  }

  .course-group:has(details[open]) {
    position: relative;
    z-index: 25;
  }

  .course-group-summary {
    display: flex;
    align-items: center;
    gap: 12px;
    border-radius: 9px;
    padding: 12px 14px;
    background: var(--well);
    list-style: none;
  }

  .course-group[open] > .course-group-summary {
    border-radius: 9px 9px 0 0;
    border-bottom: 1px solid var(--border);
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
    padding: 4px 12px;
  }

  .course-group-items .notes-library-row:last-child {
    border-bottom: 0;
  }

  .notes-library-row {
    position: relative;
    display: flex;
    min-height: 68px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--rule);
    padding: 8px 6px;
    border-radius: 8px;
    transition: background-color 140ms ease;
  }

  .notes-library-row:hover,
  .notes-library-row:has(details[open]) {
    background: var(--well);
  }

  .notes-library-row:has(details[open]) {
    z-index: 26;
  }

  .notes-library-row.is-course-child {
    min-height: 54px;
    padding: 6px 6px;
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

  .note-title-line {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
  }

  .note-mark-badge {
    flex: none;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 6px;
    background: var(--well);
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }

  .note-mark-badge.is-mastered {
    border-color: var(--success-border);
    background: var(--success-fill);
    color: var(--success);
  }

  .note-summary-preview {
    overflow: hidden;
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.45;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note-meta-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
  }

  .note-status-pill {
    display: inline-flex;
    flex: none;
    align-items: center;
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.5;
    background: var(--well);
    color: var(--muted);
    border: 1px solid var(--border);
  }

  .note-status-pill[data-tone='completed'] {
    background: var(--success-fill);
    border-color: var(--success-border);
    color: var(--success);
  }

  .note-status-pill[data-tone='processing'] {
    background: var(--active);
    border-color: var(--control);
    color: var(--accent);
  }

  .note-status-pill[data-tone='failed'] {
    background: var(--danger-fill);
    border-color: var(--danger-border);
    color: var(--danger);
  }

  .note-status-pill[data-tone='incomplete'] {
    background: var(--warning-fill);
    border-color: var(--warning-border);
    color: #8a651b;
  }

  .note-meta-text {
    min-width: 0;
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .note-row-error {
    display: block;
    overflow: hidden;
    color: var(--danger);
    font-size: 11.5px;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
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

    .library-stats-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
