<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { NOTE_DOCUMENT_STRUCTURES, getNoteStructure, isNoteViewKey } from '../../lib/note-structures.ts';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import * as disc from '../../lib/workspace/discussion.svelte.ts';
  import * as fc from '../../lib/workspace/flashcards.svelte.ts';
  import * as qz from '../../lib/workspace/quiz.svelte.ts';
  import { workspace, type WorkspaceView } from '../../lib/workspace/state.svelte.ts';
  import { dismissNotice, triggerNoticeAction } from '../../lib/workspace/ui.ts';
  import DiscussionPanel from './DiscussionPanel.svelte';
  import FlashcardPanel from './FlashcardPanel.svelte';
  import MarkdownEditor from './MarkdownEditor.svelte';
  import NoteLibrary from './NoteLibrary.svelte';
  import QuizPanel from './QuizPanel.svelte';
  import TranscriptPanel from './TranscriptPanel.svelte';
  import TemplatePicker from './TemplatePicker.svelte';
  import WorkspaceRail from './WorkspaceRail.svelte';
  import SettingsPanel from './SettingsPanel.svelte';

  const viewHeadings: Record<WorkspaceView, string> = {
    create: '当前课程',
    library: '笔记库',
    note: '笔记详情',
    settings: '设置',
  };

  const selectedStructure = $derived(getNoteStructure(workspace.selectedTemplate));
  const idleGenerateLabel = $derived(
    selectedStructure.id === 'custom' ? '生成自定义笔记' : `生成${selectedStructure.label}`
  );
  const generatingTargetLabel = $derived(getNoteStructure(workspace.generatingView || 'study').label);
  const isSameNoteOtherTabGenerating = $derived(
    !fc.flashcardState.crossNote
    && workspace.activeNoteGenerating
    && Boolean(workspace.generatingView)
    && workspace.generatingView !== workspace.noteTab
  );
  const showGenerationStatus = $derived(
    !fc.flashcardState.crossNote
    && (
      (workspace.activeNoteGenerating && (!workspace.generatingView || workspace.generatingView === workspace.noteTab))
      || workspace.canResumeGeneration
      || (Boolean(workspace.generationError) && (!workspace.failedView || workspace.failedView === workspace.noteTab))
    )
  );
  let titleInputElement = $state<HTMLTextAreaElement | undefined>();
  let reviewMenuOpen = $state(false);
  let addViewMenuOpen = $state(false);
  let outlineOpen = $state(false);
  let exportMenuOpen = $state(false);
  let moreMenuOpen = $state(false);
  let outlineItems = $state<Array<{ index: number; level: number; text: string }>>([]);

  const hasAnyGeneratedDocView = $derived(
    NOTE_DOCUMENT_STRUCTURES.some((item) => Boolean(workspace.generatedViews[item.id])),
  );
  const visibleDocStructures = $derived(
    NOTE_DOCUMENT_STRUCTURES.filter(
      (item) =>
        item.id === workspace.noteTab
        || Boolean(workspace.generatedViews[item.id])
        || (workspace.activeNoteGenerating && workspace.generatingView === item.id)
        || (item.id === 'study' && !hasAnyGeneratedDocView),
    ),
  );
  const remainingDocStructures = $derived(
    NOTE_DOCUMENT_STRUCTURES.filter((item) => !visibleDocStructures.some((v) => v.id === item.id)),
  );
  const reviewMarkLabel = $derived(
    workspace.reviewMark === 'star'
      ? '⭐ 重点'
      : workspace.reviewMark === 'question'
        ? '❓ 待消化'
        : workspace.reviewMark === 'mastered'
          ? '✓ 已掌握'
          : '标记',
  );
  const hasKebabActions = $derived(
    (isNoteViewKey(workspace.noteTab) && workspace.hasMarkdown)
    || Boolean(workspace.noteVideoUrl)
    || (workspace.showRetryVisualAnalysis && !workspace.generating)
    || (Boolean(workspace.currentLessonCacheBytes) && !workspace.generating),
  );

  function closeAllMenus(except?: 'review' | 'add' | 'outline' | 'export' | 'more') {
    if (except !== 'review') reviewMenuOpen = false;
    if (except !== 'add') addViewMenuOpen = false;
    if (except !== 'outline') outlineOpen = false;
    if (except !== 'export') exportMenuOpen = false;
    if (except !== 'more') moreMenuOpen = false;
  }

  $effect(() => {
    workspace.activeView;
    workspace.noteTab;
    workspace.markdownEditing;
    closeAllMenus();
  });

  function refreshOutline(forceOpen = outlineOpen) {
    if (!forceOpen) return;
    closeAllMenus('outline');
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

  function pickReviewMark(mark: '' | 'star' | 'question' | 'mastered') {
    reviewMenuOpen = false;
    ctrl.setActiveNoteReviewMark(mark);
  }

  async function togglePersonalNoteFromTopbar() {
    closeAllMenus();
    const willOpen = !workspace.personalNoteOpen;
    ctrl.togglePersonalNoteCard();
    if (willOpen) {
      await tick();
      document.getElementById('personal-note-input')?.focus();
    }
  }

  function autoResizeTitle() {
    const el = titleInputElement;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }

  $effect(() => {
    workspace.noteTitle;
    workspace.activeView;
    workspace.resultVisible;
    requestAnimationFrame(autoResizeTitle);
  });

  function handleKeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      if (workspace.activeView === 'note' && workspace.markdownEditing) {
        event.preventDefault();
        void ctrl.saveMarkdownEditing();
        return;
      }
    }
    if (event.key === 'Escape') {
      const menu = document.querySelector<HTMLDetailsElement>('details.action-menu[open], details.library-tools[open]');
      if (menu) {
        event.preventDefault();
        menu.open = false;
        menu.querySelector<HTMLElement>('summary')?.focus();
        return;
      }
      if (workspace.courseDrawerOpen) {
        event.preventDefault();
        ctrl.closeCourseDrawer();
        return;
      }
      if (workspace.activeView === 'note' && workspace.assistantOpen && !workspace.markdownEditing) {
        event.preventDefault();
        ctrl.closeAssistantPane();
        return;
      }
    }
    fc.handleFlashcardKeydown(event, workspace.activeView === 'note' && workspace.noteTab === 'flashcards');
  }

  function closeMenus(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.action-menu[open], details.library-tools[open]')) {
      if (!target || !menu.contains(target) || target.closest('button:not(:disabled), a[href]')) {
        menu.open = false;
        delete menu.dataset.drop;
      }
    }
  }

  function handleMenuToggle(event: Event) {
    const menu = event.target;
    if (!(menu instanceof HTMLDetailsElement)) return;
    if (!menu.matches('details.action-menu, details.library-tools')) return;
    if (!menu.open) {
      delete menu.dataset.drop;
      return;
    }
    for (const other of document.querySelectorAll<HTMLDetailsElement>('details.action-menu[open], details.library-tools[open]')) {
      if (other !== menu) {
        other.open = false;
        delete other.dataset.drop;
      }
    }
    requestAnimationFrame(() => {
      if (!menu.open) return;
      const panel = menu.querySelector<HTMLElement>('.action-menu-content, .library-tools-menu');
      const summary = menu.querySelector<HTMLElement>('summary');
      if (!panel || !summary) return;
      delete menu.dataset.drop;
      const summaryRect = summary.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      if (panelRect.bottom > window.innerHeight - 12 && summaryRect.top > panelRect.height + 16) {
        menu.dataset.drop = 'up';
      }
    });
  }

  function handleTitleKeydown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      ctrl.revertNoteTitleInline(event.currentTarget);
    }
  }

  onMount(() => {
    ctrl.initWorkspace();
    document.addEventListener('toggle', handleMenuToggle, true);
    return () => document.removeEventListener('toggle', handleMenuToggle, true);
  });
</script>

<svelte:window
  onkeydown={handleKeydown}
  onclick={closeMenus}
  onpopstate={ctrl.handleWorkspacePopState}
  onresize={autoResizeTitle}
/>

<div class="app-frame" class:note-view={workspace.activeView === 'note'}>
  <aside class="app-sidebar" aria-label="工作空间导航">
    <div class="brand-lockup">
      <img class="brand-mark" src="/icons/keji.svg" alt="" width="36" height="36">
      <div><strong>课记</strong><small>让知识留下来</small></div>
    </div>
    <nav class="primary-nav" aria-label="主导航">
      <button class="primary-nav-item" id="open-create" type="button" data-view="create" aria-current={workspace.activeView === 'create' ? 'page' : undefined} onclick={() => ctrl.openCreateView()}>当前课程</button>
      <button class="primary-nav-item" id="open-notes" type="button" data-view="library" aria-current={workspace.activeView === 'library' || workspace.activeView === 'note' ? 'page' : undefined} onclick={() => ctrl.showNoteLibrary()}>笔记库</button>
    </nav>
    <footer class="sidebar-footer">
      <button class="rail-link" id="open-settings" type="button" aria-current={workspace.activeView === 'settings' ? 'page' : undefined} onclick={() => ctrl.openSettingsView()}>设置</button>
      <p>数据仅存本机<br>按需开启远程同步</p>
    </footer>
  </aside>

  <main class="work-sheet">
    <header class="topbar" class:is-note-view={workspace.activeView === 'note' && !fc.flashcardState.crossNote}>
      <div class="topbar-title">
        <h1
          id="workspace-heading"
          class:sr-only={workspace.activeView === 'note' && !fc.flashcardState.crossNote}
        >{viewHeadings[workspace.activeView] || '当前课程'}</h1>
        {#if workspace.activeView === 'note' && !fc.flashcardState.crossNote}
          <div class="note-topbar-left">
            <button class="text-button note-back-btn" type="button" onclick={() => ctrl.goBackFromNote()}>
              ← {workspace.noteReturnView === 'create' ? '当前课程' : '笔记库'}
            </button>
            {#if workspace.noteCourseLabel || workspace.noteEpisodeLabel}
              <span class="topbar-sep" aria-hidden="true">/</span>
              {#if workspace.sameCourseLoaded && workspace.parts.length > 1}
                <button
                  type="button"
                  class="text-button note-course-link"
                  title={(workspace.noteCourseLabel || workspace.noteEpisodeLabel) + '（点击打开课程选集目录）'}
                  onclick={() => ctrl.openCourseDrawer()}
                ><span class="note-course-name">{workspace.noteCourseLabel || workspace.noteEpisodeLabel}</span><span class="note-course-caret"> · 选集 ▾</span></button>
              {:else}
                <span class="note-episode-label" title={workspace.noteCourseLabel || workspace.noteEpisodeLabel}>{workspace.noteCourseLabel || workspace.noteEpisodeLabel}</span>
              {/if}
            {/if}
            {#if workspace.noteVideoUrl}
              <button type="button" class="text-button topbar-source-link" title="在 B 站打开原视频" onclick={() => ctrl.openNoteSourceVideo()}>原视频 ↗</button>
            {/if}
          </div>
        {/if}
      </div>
      <div class="topbar-actions">
        {#if workspace.activeView === 'note'}
          {#if fc.flashcardState.crossNote}
            <button class="secondary-button" type="button" onclick={() => ctrl.goBackFromNote()}>
              ← 返回{workspace.noteReturnView === 'create' ? '当前课程' : '笔记库'}
            </button>
          {:else if workspace.resultVisible && !workspace.markdownEditing}
            <details
              class="action-menu review-mark-menu"
              bind:open={reviewMenuOpen}
              ontoggle={() => { if (reviewMenuOpen) closeAllMenus('review'); }}
            >
              <summary class="secondary-button topbar-chip-btn" class:is-marked={Boolean(workspace.reviewMark)}>
                {reviewMarkLabel}
              </summary>
              <div class="action-menu-content review-mark-menu-content">
                <button type="button" class="text-button" aria-pressed={workspace.reviewMark === 'star'} onclick={() => pickReviewMark('star')}>
                  <span>⭐ 重点</span><span>{workspace.reviewMark === 'star' ? '✓' : ''}</span>
                </button>
                <button type="button" class="text-button" aria-pressed={workspace.reviewMark === 'question'} onclick={() => pickReviewMark('question')}>
                  <span>❓ 待消化</span><span>{workspace.reviewMark === 'question' ? '✓' : ''}</span>
                </button>
                <button type="button" class="text-button" aria-pressed={workspace.reviewMark === 'mastered'} onclick={() => pickReviewMark('mastered')}>
                  <span>✓ 已掌握</span><span>{workspace.reviewMark === 'mastered' ? '✓' : ''}</span>
                </button>
                {#if workspace.reviewMark}
                  <hr class="menu-divider">
                  <button type="button" class="text-button" onclick={() => pickReviewMark(workspace.reviewMark)}>
                    <span>清除标记</span>
                  </button>
                {/if}
              </div>
            </details>
            <button
              type="button"
              class="secondary-button topbar-chip-btn"
              class:is-marked={Boolean(workspace.personalNote.trim())}
              aria-pressed={workspace.personalNoteOpen}
              onclick={() => togglePersonalNoteFromTopbar()}
            >✍️ 批注{#if workspace.personalNote.trim() && !workspace.personalNoteOpen} · 已写{/if}</button>
            <button
              type="button"
              id="toggle-assistant-pane"
              class="secondary-button topbar-chip-btn assistant-toggle"
              aria-pressed={workspace.assistantOpen}
              onclick={() => ctrl.toggleAssistantPane()}
            >
              <span>AI 助教</span>{#if disc.discussionState.items.length}<small class="tab-badge">{disc.discussionState.items.length}</small>{/if}
            </button>
          {/if}
        {/if}
      </div>
    </header>

    <div class="toast-notice" id="notice" class:hidden={!workspace.notice.message} data-kind={workspace.notice.kind} role="status" aria-live="polite">
      <span>{workspace.notice.message}</span>
      <button class="text-button toast-action" class:hidden={!workspace.notice.actionLabel} type="button" onclick={() => triggerNoticeAction()}>{workspace.notice.actionLabel}</button>
      <button class="toast-close" type="button" aria-label="关闭提示" onclick={() => dismissNotice()}>×</button>
    </div>

    <div class="work-content" class:hidden={workspace.activeView === 'settings'} id="work-content" data-view={workspace.activeView}>
      {#if workspace.activeView === 'create' && !workspace.modelConfigured}
        <aside class="onboarding-banner" role="note">
          <div class="onboarding-copy">
            <strong>尚未配置笔记模型连接</strong>
            <span>先填写模型 API 地址和模型名称，即可开始整理课程笔记。</span>
          </div>
          <button class="secondary-button" type="button" onclick={() => ctrl.openSettingsView('connection')}>去配置模型 →</button>
        </aside>
      {/if}

      <header class="create-intro" class:hidden={workspace.activeView !== 'create' || Boolean(workspace.currentVideo)}>
        <h2>从一段 B 站课程开始</h2>
        <p>生成带时间戳、关键帧画面、随堂自测与记忆闪卡的结构化笔记。</p>
        <ol class="creation-steps" aria-label="生成笔记的步骤">
          <li data-complete={Boolean(workspace.currentVideo)}><span class="step-number">01</span>载入视频</li>
          <li data-complete={Boolean(workspace.transcript.trim()) || workspace.modelCapability === 'video_audio'}><span class="step-number">02</span>{workspace.modelCapability === 'video_audio' ? '准备素材' : '准备文字稿'}</li>
          <li><span class="step-number">03</span>生成笔记</li>
        </ol>
      </header>

      <div class="create-layout">
        <div class="source-context">
          <section class="source-section" class:hidden={Boolean(workspace.currentVideo) && !workspace.editingVideoUrl} aria-label="视频来源">
            <label for="video-url">B 站视频链接</label>
            <div class="source-controls">
              <input id="video-url" bind:value={workspace.videoUrl} onkeydown={(event) => event.key === 'Enter' && !workspace.loadingVideo && ctrl.loadVideoFromUrl()} type="url" inputmode="url" autocomplete="url" placeholder="粘贴 B 站视频链接…">
              <button class="secondary-button" id="load-video" type="button" disabled={workspace.loadingVideo || !workspace.videoUrl.trim()} onclick={() => ctrl.loadVideoFromUrl()}>{workspace.loadingVideo ? '正在载入…' : '载入视频'}</button>
              {#if workspace.currentVideo && workspace.editingVideoUrl}
                <button class="text-button" type="button" onclick={() => (workspace.editingVideoUrl = false)}>取消</button>
              {/if}
            </div>
            {#if !workspace.currentVideo && workspace.openBilibiliTabs.length}
              <div class="open-tabs-bar" aria-label="已打开的 B 站标签页">
                <span class="open-tabs-label">已打开的 B 站视频，点击直接载入：</span>
                <div class="open-tabs-list">
                  {#each workspace.openBilibiliTabs as tab (tab.tabId)}
                    <button
                      type="button"
                      class="open-tab-chip"
                      title={tab.url}
                      onclick={() => ctrl.selectOpenBilibiliTab(tab.tabId, tab.url)}
                    >{tab.title || tab.bvid}</button>
                  {/each}
                </div>
              </div>
            {:else}
              <p class="source-hint">也可在 B 站播放页点击工具栏「课记」图标自动载入。</p>
            {/if}
          </section>

          <section class="video-heading" class:hidden={!workspace.currentVideo && !workspace.loadingVideo} aria-live="polite">
            <div class="video-heading-copy">
              <h2 id="video-title">{workspace.videoTitle}</h2>
              <div class="video-meta" id="video-meta">{workspace.videoMeta}</div>
            </div>
            <div class="video-heading-side">
              <div class="video-heading-links">
                {#if workspace.currentVideo}
                  <button class="text-button" type="button" onclick={() => ctrl.returnToVideo()}>原视频 ↗</button>
                  <span class="video-link-sep" aria-hidden="true"></span>
                {/if}
                <button class="text-button" type="button" onclick={() => ctrl.toggleEditVideoUrl()}>{workspace.editingVideoUrl ? '收起链接' : '更换视频'}</button>
              </div>
              {#if workspace.parts.length > 1}
                <div class="part-stepper" role="group" aria-label="切换课程选集">
                  <button
                    class="part-stepper-nav"
                    type="button"
                    title="上一节"
                    aria-label="上一节"
                    disabled={workspace.loadingVideo || workspace.currentPage <= 1}
                    onclick={() => ctrl.selectAdjacentPart(-1)}
                  >‹</button>
                  <button
                    class="part-stepper-current"
                    type="button"
                    title="打开课程选集列表"
                    onclick={() => ctrl.openCourseDrawer()}
                  >选集 {workspace.currentPage}/{workspace.parts.length}</button>
                  <button
                    class="part-stepper-nav"
                    type="button"
                    title="下一节"
                    aria-label="下一节"
                    disabled={workspace.loadingVideo || workspace.currentPage >= workspace.parts.length}
                    onclick={() => ctrl.selectAdjacentPart(1)}
                  >›</button>
                </div>
              {/if}
            </div>
          </section>
        </div>

        {#if workspace.currentVideo && workspace.currentPartNote}
          <aside class="existing-note-banner" role="status">
            <div class="existing-note-copy">
              <strong>本节已生成过笔记</strong>
              <span>{workspace.currentPartNoteMeta} · 生成其他形式将独立保存，不会覆盖已有内容</span>
            </div>
            <button class="secondary-button" type="button" onclick={() => ctrl.openSavedNote(workspace.currentPartNote!, { returnView: 'create' })}>打开已有笔记 →</button>
          </aside>
        {/if}

        <div class="create-primary-column" class:hidden={!workspace.currentVideo}>
          <TranscriptPanel />

          <section class="work-panel note-panel">
            <header class="panel-heading">
              <div>
                <h2>选择笔记形式</h2>
              </div>
              {#if workspace.modelPresets.length}
                <div class="panel-heading-meta">
                  <label class="sr-only" for="create-model-preset">快速切换模型预设</label>
                  <select
                    id="create-model-preset"
                    class="preset-quick-select"
                    value={workspace.activePresetId}
                    onchange={(event) => ctrl.switchActiveModelPreset(event.currentTarget.value)}
                    aria-label="快速切换模型预设"
                  >
                    <option value="">当前：{workspace.currentModelLabel || '默认模型'}</option>
                    {#each workspace.modelPresets as preset (preset.id)}
                      <option value={preset.id}>{preset.name} · {preset.model}</option>
                    {/each}
                  </select>
                </div>
              {/if}
            </header>
            <TemplatePicker />
            <textarea id="custom-prompt" class="custom-prompt" class:hidden={workspace.selectedTemplate !== 'custom'} bind:value={workspace.customPrompt} placeholder="描述你希望模型如何整理这份课程内容…" aria-label="自定义笔记要求"></textarea>
            <div class="generation-actions">
              <button class="primary-button" id="generate" type="button" disabled={!workspace.canGenerate || workspace.generating} onclick={() => ctrl.generate(false)}>
                <span>{workspace.generating ? workspace.generateLabel : idleGenerateLabel}</span>{#if workspace.generating}<span class="button-spinner" aria-label="正在生成"></span>{:else}<span aria-hidden="true">→</span>{/if}
              </button>
              <p class="generate-hint">
                {#if !workspace.modelConfigured}
                  请先前往「设置」填写 API 地址与模型名称。
                {:else if !workspace.canGenerate}
                  {workspace.modelCapability === 'video_audio' ? '请先在上方确认新识别稿，再生成笔记。' : '请先获取字幕、语音转写或粘贴文字稿，再生成笔记。'}
                {:else if workspace.modelCapability === 'video_audio' && !workspace.transcript.trim()}
                  将直接提取视频画面与音轨生成笔记{workspace.currentModelLabel ? `（${workspace.currentModelLabel}）` : ''}。
                {:else if workspace.modelCapability === 'text'}
                  纯文本模式：仅发送文字稿{workspace.currentModelLabel ? `（${workspace.currentModelLabel}）` : ''}。
                {:else}
                  将发送文字稿与课程画面{workspace.currentModelLabel ? `（${workspace.currentModelLabel}）` : ''}。
                {/if}
              </p>
            </div>
          </section>
        </div>
      </div>

      {#if workspace.activeView === 'create' && !workspace.currentVideo && !workspace.loadingVideo && workspace.recentNotes.length}
        <section class="create-recent-notes" aria-label="最近学习的笔记">
          <header>
            <h3>最近学习</h3>
            <button class="text-button" type="button" onclick={() => ctrl.showNoteLibrary()}>进入笔记库 →</button>
          </header>
          <div class="create-recent-grid">
            {#each workspace.recentNotes as item (item.note.id)}
              <button class="create-recent-card" type="button" onclick={() => ctrl.openSavedNote(item.note, { returnView: 'create' })}>
                {#if item.coverUrl}<img src={item.coverUrl} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={(event) => event.currentTarget.remove()}>{/if}
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.meta}</small>
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      <section
        class="result-section"
        class:hidden={!workspace.resultVisible}
        class:has-assistant-sheet={workspace.assistantOpen && workspace.resultVisible && !workspace.markdownEditing && !fc.flashcardState.crossNote}
        id="result-section"
      >
        <header class="result-heading">
          <div>
            <label class="sr-only" for="note-title-input">笔记标题</label>
            <textarea
              id="note-title-input"
              class="note-title-input"
              rows="1"
              aria-label="笔记标题"
              placeholder="笔记标题"
              title="点击可修改标题，按回车或点其他位置自动保存"
              bind:this={titleInputElement}
              bind:value={workspace.noteTitle}
              oninput={(event) => {
                const clean = event.currentTarget.value.replace(/[\r\n]+/g, ' ');
                if (clean !== workspace.noteTitle) workspace.noteTitle = clean;
                autoResizeTitle();
              }}
              onblur={() => ctrl.saveNoteTitleInline()}
              onkeydown={handleTitleKeydown}
              disabled={!workspace.canEditTitle || workspace.titleSaving}
            ></textarea>
          </div>
        </header>

        {#if workspace.generating && !workspace.activeNoteGenerating && workspace.backgroundGeneratingTitle && !fc.flashcardState.crossNote}
          <aside class="bg-generation-banner" role="status" aria-live="polite">
            <span>后台正在生成「{workspace.backgroundGeneratingTitle}」，当前浏览不受影响</span>
            <button class="text-button" type="button" onclick={() => ctrl.openGeneratingNote()}>查看进度 →</button>
          </aside>
        {:else if isSameNoteOtherTabGenerating}
          <aside class="bg-generation-banner" role="status" aria-live="polite">
            <span>正在后台生成本节「{generatingTargetLabel}」· {workspace.generationStageText || '请稍候…'}</span>
            <div class="bg-banner-actions">
              <button class="text-button" type="button" onclick={() => ctrl.setNoteTab(workspace.generatingView as any)}>查看生成页 →</button>
              <button class="text-button" type="button" onclick={() => ctrl.cancelGeneration()}>停止</button>
            </div>
          </aside>
        {/if}

        <aside class="note-generation-status" class:hidden={!showGenerationStatus} data-kind={workspace.generationError ? 'error' : workspace.activeNoteGenerating ? 'info' : 'warning'} aria-live="polite" aria-atomic="true">
          <div class="note-generation-status-copy">
            <strong>{workspace.activeNoteGenerating ? `正在生成本节「${generatingTargetLabel}」` : workspace.generationError ? '生成未完成' : '生成已暂停，可继续'}</strong>
            <p>{workspace.generationError || workspace.generationStageText || '正在准备生成任务…'}</p>
            <div class="note-generation-status-actions">
              <button class="secondary-button" class:hidden={!workspace.activeNoteGenerating} id="cancel-generation" type="button" onclick={() => ctrl.cancelGeneration()}>停止生成</button>
              <button class="secondary-button" class:hidden={workspace.activeNoteGenerating || !workspace.canResumeGeneration} id="resume-generation" type="button" onclick={() => ctrl.generate(true)}>继续生成剩余分段</button>
            </div>
          </div>
          {#if (workspace.activeNoteGenerating || workspace.canResumeGeneration) && workspace.generationProgress.totalChunks > 1}
            <div class="note-generation-progress">
              <progress max={workspace.generationProgress.totalChunks} value={workspace.generationProgress.completedChunks} aria-label="分段整理进度"></progress>
              <span>已完成 {workspace.generationProgress.completedChunks}/{workspace.generationProgress.totalChunks} 段</span>
            </div>
          {/if}
        </aside>

        <div class="note-toolbar" class:hidden={!workspace.resultVisible || workspace.markdownEditing || fc.flashcardState.crossNote}>
          <div class="note-toolbar-left">
            <div class="note-tabs" role="tablist" aria-label="笔记形式与学习模式">
              {#each visibleDocStructures as item (item.id)}
                <button
                  type="button"
                  role="tab"
                  class="mode-tab"
                  title={item.label}
                  aria-selected={workspace.noteTab === item.id}
                  onclick={() => ctrl.setNoteTab(item.id)}
                >
                  <span>{item.tabLabel || item.label}</span>
                  {#if workspace.activeNoteGenerating && workspace.generatingView === item.id}
                    <span class="tab-dot is-generating" aria-label="生成中"></span>
                  {:else if workspace.generatedViews[item.id]}
                    <span class="tab-dot" aria-label="已生成"></span>
                  {/if}
                </button>
              {/each}
              {#if remainingDocStructures.length > 0}
                <details
                  class="action-menu add-view-menu"
                  bind:open={addViewMenuOpen}
                  ontoggle={() => { if (addViewMenuOpen) closeAllMenus('add'); }}
                >
                  <summary class="mode-tab add-view-trigger">+ 其他形式</summary>
                  <div class="action-menu-content add-view-menu-content">
                    {#each remainingDocStructures as item (item.id)}
                      <button
                        type="button"
                        class="text-button"
                        onclick={() => { addViewMenuOpen = false; ctrl.setNoteTab(item.id); }}
                      >
                        <span>{item.label}</span>
                      </button>
                    {/each}
                  </div>
                </details>
              {/if}
              <span class="note-tabs-divider" aria-hidden="true"></span>
              <button type="button" role="tab" id="open-quiz-panel" class="mode-tab" aria-selected={workspace.noteTab === 'quiz'} onclick={() => ctrl.setNoteTab('quiz')}>
                <span>随堂自测</span>{#if qz.quizState.tabBadge}<small class="tab-badge">{qz.quizState.tabBadge}</small>{/if}
              </button>
              <button type="button" role="tab" id="open-flashcard-review" class="mode-tab" aria-selected={workspace.noteTab === 'flashcards'} onclick={() => ctrl.setNoteTab('flashcards')}>
                <span>记忆闪卡</span>{#if fc.flashcardState.tabBadge}<small class="tab-badge">{fc.flashcardState.tabBadge}</small>{/if}
              </button>
            </div>
          </div>

          <div class="note-toolbar-right">
            {#if isNoteViewKey(workspace.noteTab) && workspace.hasMarkdown}
              <details
                class="action-menu note-outline"
                bind:open={outlineOpen}
                ontoggle={(event) => {
                  const el = event.currentTarget as HTMLDetailsElement;
                  if (el.open) refreshOutline(true);
                }}
              >
                <summary class="text-button toolbar-text-btn">目录</summary>
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
              <button
                class="text-button toolbar-text-btn"
                id="edit-markdown"
                type="button"
                onclick={() => ctrl.setMarkdownEditMode('edit')}
              >编辑</button>
            {/if}
            <button
              class="secondary-button toolbar-compact-btn"
              id="copy-note"
              type="button"
              disabled={!workspace.canCopyCurrentTab}
              onclick={() => ctrl.copyMarkdown()}
            >{workspace.copyButtonLabel}</button>
            <details
              class="action-menu"
              bind:open={exportMenuOpen}
              ontoggle={() => { if (exportMenuOpen) closeAllMenus('export'); }}
            >
              <summary class="secondary-button toolbar-compact-btn">导出</summary>
              <div class="action-menu-content">
                <button class="text-button" id="export-note-bundle" type="button" disabled={!workspace.canExportBundle} onclick={() => { exportMenuOpen = false; ctrl.exportCurrentNoteBundle(); }}>Markdown 资源包 (.zip)</button>
                <button class="text-button" class:hidden={!fc.flashcardState.showAnkiExport} id="export-anki" type="button" onclick={() => { exportMenuOpen = false; fc.exportAnkiTsv(); }}>Anki 闪卡 (.tsv)</button>
                <hr class="menu-divider">
                <button class="text-button" type="button" disabled={workspace.currentLessonMediaBusy || workspace.generating} onclick={() => { exportMenuOpen = false; ctrl.downloadCurrentLessonMedia('audio'); }}>下载纯音轨 (.m4a)</button>
                <button class="text-button" type="button" disabled={workspace.currentLessonMediaBusy || workspace.generating} onclick={() => { exportMenuOpen = false; ctrl.downloadCurrentLessonMedia('video'); }}>下载纯画面 (.mp4)</button>
                <button class="text-button" type="button" disabled={workspace.currentLessonMediaBusy || workspace.generating} onclick={() => { exportMenuOpen = false; ctrl.downloadCurrentLessonMedia('audiovisual'); }}>下载音画视频 (.mp4)</button>
              </div>
            </details>
            <details
              class="action-menu action-menu-kebab"
              class:hidden={!hasKebabActions}
              bind:open={moreMenuOpen}
              ontoggle={() => { if (moreMenuOpen) closeAllMenus('more'); }}
            >
              <summary class="text-button toolbar-kebab-btn" aria-label="更多操作">···</summary>
              <div class="action-menu-content">
                {#if isNoteViewKey(workspace.noteTab) && workspace.hasMarkdown}
                  <button
                    class="text-button"
                    id="regenerate-active-tab"
                    type="button"
                    disabled={!workspace.canRegenerateActiveTab || workspace.generating}
                    onclick={() => { moreMenuOpen = false; ctrl.regenerateActiveNoteTab(); }}
                  >{workspace.activeNoteGenerating && workspace.generatingView === workspace.noteTab ? '正在重新生成…' : '重新生成当前视图'}</button>
                  <button
                    class="text-button"
                    id="ai-revise-active-tab"
                    type="button"
                    disabled={workspace.generating}
                    onclick={() => { moreMenuOpen = false; ctrl.openAssistantInMode('revise'); }}
                  >用 AI 修订当前笔记</button>
                  {#if workspace.noteVideoUrl || (workspace.showRetryVisualAnalysis && !workspace.generating) || (workspace.currentLessonCacheBytes && !workspace.generating)}
                    <hr class="menu-divider">
                  {/if}
                {/if}
                <button class="text-button" class:hidden={!workspace.showRetryVisualAnalysis || workspace.generating} id="retry-visual-analysis" type="button" onclick={() => { moreMenuOpen = false; ctrl.retryVisualAnalysis(); }}>补充画面分析</button>
                <button class="text-button" class:hidden={!workspace.noteVideoUrl} type="button" onclick={() => { moreMenuOpen = false; ctrl.openNoteSourceVideo(); }}>打开原视频 ↗</button>
                <button class="text-button" class:hidden={!workspace.currentLessonCacheBytes || workspace.generating} id="clear-lesson-cache" type="button" disabled={workspace.clearingCache} onclick={() => { moreMenuOpen = false; ctrl.clearCurrentLessonCache(); }}>清理媒体缓存 · {workspace.currentLessonCacheLabel}</button>
              </div>
            </details>
          </div>
        </div>

        {#if workspace.resultVisible && !workspace.markdownEditing && !fc.flashcardState.crossNote && (workspace.personalNoteOpen || Boolean(workspace.personalNote.trim()))}
          <section class="personal-note-card" class:is-open={workspace.personalNoteOpen} aria-label="我的批注与待办">
            <div class="personal-note-header">
              <button
                type="button"
                class="personal-note-toggle"
                aria-expanded={workspace.personalNoteOpen}
                onclick={() => ctrl.togglePersonalNoteCard()}
              >
                <span class="personal-note-title">✍️ 我的批注与待办</span>
                {#if !workspace.personalNoteOpen}
                  <span class="personal-note-preview">
                    {workspace.personalNote.trim().replace(/\s+/g, ' ').slice(0, 80)}
                  </span>
                {/if}
              </button>
              <span class="personal-note-status">{workspace.personalNoteSaving ? '保存中…' : workspace.personalNote.trim() ? '自动保存' : ''}</span>
            </div>
            {#if workspace.personalNoteOpen}
              <div class="personal-note-body">
                <label class="sr-only" for="personal-note-input">个人批注与待办</label>
                <textarea
                  id="personal-note-input"
                  class="personal-note-textarea"
                  rows="3"
                  bind:value={workspace.personalNote}
                  onblur={() => ctrl.savePersonalNote()}
                  placeholder="记下你的理解、实验差异、自测错题或待查问题（离开输入框自动保存，重新生成 AI 笔记绝不覆盖此处）…"
                ></textarea>
              </div>
            {/if}
          </section>
        {/if}

        <div class="note-workspace-body">
          <div class="note-main-pane">
            <div class:hidden={!workspace.resultVisible || !isNoteViewKey(workspace.noteTab) || fc.flashcardState.crossNote}>
              <MarkdownEditor />
            </div>
            <QuizPanel />
            <FlashcardPanel />
          </div>
          <DiscussionPanel />
        </div>
      </section>

      <NoteLibrary />
    </div>

    <SettingsPanel />
  </main>

  <WorkspaceRail />
</div>

<style>
  .toast-action {
    flex: none;
    min-height: 24px;
    padding: 0 6px;
    color: var(--accent);
    font-weight: 600;
  }

  .open-tabs-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
  }

  :global(.topbar.is-note-view) {
    min-height: 52px;
    padding-top: 6px;
    padding-bottom: 6px;
  }

  :global(.topbar.is-note-view .topbar-title) {
    flex: 1 1 auto;
    min-width: 0;
  }

  .note-topbar-left {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
  }

  .note-back-btn {
    min-height: 30px;
    padding: 2px 8px;
    margin-left: -8px;
    color: var(--ink);
    font-size: 13px;
    font-weight: 500;
  }

  .topbar-sep {
    color: var(--control);
    font-size: 13px;
    user-select: none;
  }

  .note-course-link {
    display: inline-flex;
    min-height: 28px;
    min-width: 0;
    max-width: min(380px, 34vw);
    align-items: center;
    justify-content: flex-start;
    padding: 2px 8px;
    color: var(--muted);
    font-size: 12.5px;
    font-weight: 500;
    text-align: left;
  }

  .note-course-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note-course-caret {
    flex: none;
    white-space: nowrap;
  }

  .note-course-link:hover {
    color: var(--accent);
    background: var(--well);
  }

  .note-episode-label {
    max-width: min(380px, 36vw);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.45;
  }

  .topbar-source-link {
    min-height: 28px;
    padding: 2px 8px;
    color: var(--muted);
    font-size: 12.5px;
  }

  .topbar-source-link:hover {
    color: var(--accent);
  }

  :global(.topbar-chip-btn) {
    min-height: 32px;
    padding: 4px 10px;
    font-size: 12.5px;
    font-weight: 500;
  }

  :global(.topbar-chip-btn.is-marked) {
    border-color: var(--accent);
    background: var(--active);
    color: var(--accent);
    font-weight: 600;
  }

  .review-mark-menu-content {
    width: 170px;
    min-width: 170px;
  }

  .review-mark-menu-content button[aria-pressed='true'] {
    color: var(--accent);
    font-weight: 600;
    background: var(--active);
  }

  .bg-generation-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    margin: 12px 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 14px;
    background: var(--well);
    color: var(--muted);
    font-size: 12.5px;
  }

  .bg-banner-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .bg-generation-banner :global(.text-button) {
    color: var(--accent);
    font-weight: 600;
  }

  .personal-note-card {
    margin-top: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--well);
    padding: 8px 12px;
  }

  .personal-note-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .personal-note-toggle {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: baseline;
    gap: 10px;
    border: 0;
    padding: 2px 0;
    background: transparent;
    color: var(--ink);
    text-align: left;
  }

  .personal-note-title {
    flex: none;
    font-size: 13px;
    font-weight: 600;
    color: var(--ink);
  }

  .personal-note-preview {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
    font-size: 12.5px;
  }

  .personal-note-status {
    flex: none;
    color: var(--muted);
    font-size: 11.5px;
  }

  .personal-note-body {
    margin-top: 8px;
  }

  .personal-note-textarea {
    display: block;
    width: 100%;
    min-height: 76px;
    resize: vertical;
    border: 1px solid var(--control);
    border-radius: 8px;
    padding: 8px 10px;
    background: var(--surface);
    color: var(--ink);
    font-size: 13.5px;
    line-height: 1.65;
  }

  .open-tabs-label {
    color: var(--muted);
    font-size: 12px;
  }

  .open-tabs-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .open-tab-chip {
    max-width: 280px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 12px;
    background: var(--well);
    color: var(--ink);
    font-size: 12px;
  }

  .open-tab-chip:hover {
    border-color: var(--accent);
    background: var(--active);
    color: var(--accent);
  }

  .preset-quick-select {
    max-width: 240px;
    height: 32px;
    border: 1px solid var(--control);
    border-radius: 8px;
    padding: 0 8px;
    background: var(--surface);
    color: var(--ink);
    font-size: 12px;
  }

  .create-recent-notes {
    max-width: 960px;
    margin: 28px auto 0;
    border-top: 1px solid var(--border);
    padding-top: 20px;
  }

  .create-recent-notes > header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .create-recent-notes h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .create-recent-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .create-recent-card {
    display: grid;
    min-width: 0;
    gap: 8px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px;
    background: var(--well);
    color: var(--ink);
    text-align: left;
  }

  .create-recent-card:hover {
    border-color: var(--accent);
    background: var(--surface);
  }

  .create-recent-card img {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: 6px;
    background: var(--border);
  }

  .create-recent-card strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 600;
  }

  .create-recent-card small {
    display: block;
    margin-top: 2px;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .menu-divider {
    width: 100%;
    margin: 4px 0;
    border: 0;
    border-top: 1px solid var(--border);
  }

  .note-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    margin-top: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }

  .note-toolbar-left,
  .note-toolbar-right {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    min-width: 0;
  }

  .note-tabs {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--well);
    gap: 3px;
  }

  .note-tabs :global(.mode-tab) {
    display: inline-flex;
    align-items: center;
  }

  .add-view-menu {
    position: relative;
  }

  .add-view-trigger {
    min-height: auto;
    padding: 5px 10px;
    font-size: 13px;
  }

  :global(.add-view-menu > summary::after) {
    margin-left: 2px;
  }

  .add-view-menu-content {
    left: 0;
    right: auto;
    width: 170px;
    min-width: 170px;
  }

  .note-tabs-divider {
    width: 1px;
    height: 18px;
    align-self: center;
    margin: 0 2px;
    background: var(--border);
  }

  :global(.toolbar-text-btn) {
    min-height: 32px;
    padding: 4px 10px;
    font-size: 13px;
  }

  :global(.toolbar-compact-btn) {
    min-height: 32px;
    padding: 4px 12px;
    font-size: 13px;
  }

  :global(.toolbar-kebab-btn) {
    min-height: 32px;
    min-width: 32px;
    justify-content: center;
    padding: 4px 8px;
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 1px;
  }

  :global(.action-menu-kebab > summary::after) {
    display: none !important;
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

  .tab-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-left: 5px;
    border-radius: 50%;
    background: var(--accent);
    vertical-align: middle;
  }

  .tab-dot.is-generating {
    animation: tab-dot-pulse 1s ease-in-out infinite;
  }

  @keyframes tab-dot-pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }

  .tab-badge {
    margin-left: 5px;
    border-radius: 999px;
    padding: 0 6px;
    background: var(--active);
    color: var(--accent);
    font-size: 11px;
    font-weight: 600;
  }

  .assistant-toggle[aria-pressed='true'] {
    border-color: var(--accent);
    background: var(--active);
    color: var(--accent);
    font-weight: 600;
  }

  .result-section.has-assistant-sheet {
    padding-bottom: 340px;
  }

  .note-workspace-body {
    display: block;
    min-width: 0;
  }

  .note-main-pane {
    min-width: 0;
  }

  .video-heading-copy {
    min-width: 0;
    flex: 1 1 320px;
  }

  .video-heading-side {
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .video-heading-links {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    white-space: nowrap;
  }

  .video-link-sep {
    width: 1px;
    height: 12px;
    margin: 0 2px;
    background: var(--control);
  }

  .video-heading-links :global(.text-button) {
    min-height: 26px;
    padding: 2px 8px;
    font-size: 12px;
  }

  .part-stepper {
    display: inline-flex;
    flex: none;
    align-items: center;
    overflow: hidden;
    border: 1px solid var(--control);
    border-radius: 8px;
    background: var(--surface);
  }

  .part-stepper-nav,
  .part-stepper-current {
    height: 34px;
    border: 0;
    background: transparent;
    color: var(--ink);
    font-size: 13px;
    white-space: nowrap;
  }

  .part-stepper-nav {
    width: 30px;
    padding: 0;
    color: var(--muted);
    font-size: 16px;
    line-height: 1;
  }

  .part-stepper-current {
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
    padding: 0 12px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .part-stepper-nav:hover:not(:disabled),
  .part-stepper-current:hover {
    background: var(--active);
    color: var(--accent);
  }

  @media (max-width: 960px) {
    .create-recent-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (max-width: 700px) {
    .video-heading-side {
      width: 100%;
      flex-direction: row;
      justify-content: space-between;
    }
  }
</style>
