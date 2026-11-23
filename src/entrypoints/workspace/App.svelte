<script lang="ts">
  import { onMount } from 'svelte';
  import { NOTE_STRUCTURES } from '../../lib/note-structures.ts';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import * as fc from '../../lib/workspace/flashcards.svelte.ts';
  import * as qz from '../../lib/workspace/quiz.svelte.ts';
  import { workspace, type WorkspaceView } from '../../lib/workspace/state.svelte.ts';
  import { dismissNotice } from '../../lib/workspace/ui.ts';
  import DashboardPanel from './DashboardPanel.svelte';
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
    home: '学习概览',
    create: '新建笔记',
    library: '笔记库',
    note: '笔记详情',
    settings: '设置',
  };

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
    }
    fc.handleFlashcardKeydown(event);
  }

  function closeMenus(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    for (const menu of document.querySelectorAll<HTMLDetailsElement>('details.action-menu[open], details.library-tools[open]')) {
      if (!target || !menu.contains(target) || target.closest('button')) {
        menu.open = false;
        const summary = menu.querySelector<HTMLElement>('summary');
        if (menu.contains(document.activeElement) && summary?.offsetParent !== null) summary.focus();
      }
    }
  }

  function handleTitleKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
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
  });
</script>

<svelte:window
  onkeydown={handleKeydown}
  onclick={closeMenus}
  onpopstate={ctrl.handleWorkspacePopState}
/>

<div class="app-frame" class:note-view={workspace.activeView === 'note'}>
  <aside class="app-sidebar" aria-label="工作空间导航">
    <div class="brand-lockup">
      <img class="brand-mark" src="/icons/keji.svg" alt="" width="36" height="36">
      <div><strong>课记</strong><small>让知识留下来</small></div>
    </div>
    <nav class="primary-nav" aria-label="主导航">
      <button class="primary-nav-item" id="open-dashboard" type="button" data-view="home" aria-current={workspace.activeView === 'home' ? 'page' : undefined} onclick={() => ctrl.showDashboard()}>概览</button>
      <button class="primary-nav-item" id="open-create" type="button" data-view="create" aria-current={workspace.activeView === 'create' ? 'page' : undefined} onclick={() => ctrl.openCreateView()}>新建笔记</button>
      <button class="primary-nav-item" id="open-notes" type="button" data-view="library" aria-current={workspace.activeView === 'library' || workspace.activeView === 'note' ? 'page' : undefined} onclick={() => ctrl.showNoteLibrary()}>笔记库</button>
    </nav>
    <footer class="sidebar-footer">
      <button class="rail-link" id="open-settings" type="button" aria-current={workspace.activeView === 'settings' ? 'page' : undefined} onclick={() => ctrl.openSettingsView()}>设置</button>
      <p>笔记在本机保存<br>备份与同步由你选择</p>
    </footer>
  </aside>

  <main class="work-sheet">
    <header class="topbar">
      <div class="topbar-title">
        <h1 id="workspace-heading">{viewHeadings[workspace.activeView] || '学习概览'}</h1>
      </div>
      <div class="topbar-actions">
        {#if workspace.activeView === 'note'}
          <button class="secondary-button" type="button" onclick={() => ctrl.goBackFromNote()}>
            ← 返回{workspace.noteReturnView === 'home' ? '概览' : workspace.noteReturnView === 'create' ? '新建' : '笔记库'}
          </button>
          {#if workspace.sameCourseLoaded && workspace.parts.length > 1}
            <button class="secondary-button" type="button" onclick={() => ctrl.openCourseDrawer()}>课程选集 · {workspace.parts.length} 节</button>
          {/if}
          {#if workspace.noteVideoUrl}
            <button class="secondary-button" type="button" onclick={() => ctrl.openNoteSourceVideo()}>原视频 ↗</button>
          {/if}
        {/if}
        <button class="secondary-button" class:hidden={workspace.activeView !== 'create' || !workspace.currentVideo} id="open-video" type="button" onclick={() => ctrl.returnToVideo()} disabled={!workspace.currentVideo}>返回视频页</button>
      </div>
    </header>

    <div class="toast-notice" id="notice" class:hidden={!workspace.notice.message} data-kind={workspace.notice.kind} role="status" aria-live="polite">
      <span>{workspace.notice.message}</span>
      <button class="toast-close" type="button" aria-label="关闭提示" onclick={() => dismissNotice()}>×</button>
    </div>

    <DashboardPanel />

    <div class="work-content" class:hidden={workspace.activeView === 'home' || workspace.activeView === 'settings'} id="work-content" data-view={workspace.activeView}>
      {#if workspace.activeView === 'create' && !workspace.modelConfigured}
        <aside class="onboarding-banner" role="note">
          <div class="onboarding-copy">
            <strong>尚未配置笔记模型连接</strong>
            <span>先填写模型 API 地址和模型名称，再开始整理笔记。</span>
          </div>
          <button class="secondary-button" type="button" onclick={() => ctrl.openSettingsView('connection')}>去配置模型 →</button>
        </aside>
      {/if}

      <header class="create-intro" class:hidden={workspace.activeView !== 'create' || Boolean(workspace.currentVideo)}>
        <h2>从一段视频开始</h2>
        <p>留下重点、理清脉络，把看过的内容变成自己的笔记。</p>
        <ol class="creation-steps" aria-label="生成笔记的步骤">
          <li data-complete={Boolean(workspace.currentVideo)}><span class="step-number">01</span>载入视频</li>
          <li data-complete={Boolean(workspace.transcript.trim()) || workspace.modelCapability === 'video_audio'}><span class="step-number">02</span>{workspace.modelCapability === 'video_audio' ? '准备内容' : '确认内容'}</li>
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
            <p class="source-hint">也可以在 B 站视频页点击课记图标，自动带入当前视频。</p>
          </section>

          <section class="video-heading" class:hidden={!workspace.currentVideo && !workspace.loadingVideo} aria-live="polite">
            <div>
              <div class="video-kicker">当前视频</div>
              <h2 id="video-title">{workspace.videoTitle}</h2>
              <div class="video-meta" id="video-meta">{workspace.videoMeta}</div>
            </div>
            <div class="video-heading-actions">
              {#if workspace.parts.length > 1}
                <button class="secondary-button" type="button" onclick={() => ctrl.openCourseDrawer()}>课程选集 · 第 {workspace.currentPage}/{workspace.parts.length} 节</button>
              {/if}
              <button class="text-button" type="button" onclick={() => ctrl.toggleEditVideoUrl()}>{workspace.editingVideoUrl ? '收起链接' : '更换视频'}</button>
              <button class="text-button" id="reload-captions" type="button" disabled={!workspace.canReloadCaptions} onclick={() => ctrl.loadCurrentVideo()}>重新读取字幕</button>
            </div>
          </section>
        </div>

        {#if workspace.currentVideo && workspace.currentPartNote}
          <aside class="existing-note-banner" role="status">
            <div class="existing-note-copy">
              <strong>本节已生成过笔记</strong>
              <span>{workspace.currentPartNoteMeta} · 再次生成将覆盖本节现有笔记</span>
            </div>
            <button class="secondary-button" type="button" onclick={() => ctrl.openSavedNote(workspace.currentPartNote!, { returnView: 'create' })}>打开已有笔记 →</button>
          </aside>
        {/if}

        <div class="create-primary-column" class:hidden={!workspace.currentVideo}>
          <TranscriptPanel />

          <section class="work-panel note-panel">
            <header class="panel-heading">
              <div>
                <p class="section-label">03 / 整理</p>
                <h2>选择笔记结构</h2>
              </div>
            </header>
            <TemplatePicker />
            <textarea id="custom-prompt" class="custom-prompt" class:hidden={workspace.selectedTemplate !== 'custom'} bind:value={workspace.customPrompt} placeholder="描述你希望模型如何整理这份课程内容…" aria-label="自定义笔记要求"></textarea>
            <div class="generation-actions">
              <button class="primary-button" id="generate" type="button" disabled={!workspace.canGenerate || workspace.generating} onclick={() => ctrl.generate(false)}>
                <span>{workspace.generateLabel}</span>{#if workspace.generating}<span class="button-spinner" aria-label="正在生成"></span>{:else}<span aria-hidden="true">→</span>{/if}
              </button>
              <p class="generate-hint">
                {#if !workspace.modelConfigured}
                  尚未配置模型，请先在设置中填写 API 地址和模型名称。
                {:else if !workspace.canGenerate}
                  {workspace.modelCapability === 'video_audio' ? '请先确认转写结果，或清除冲突后再生成笔记。' : '先准备字幕或文字稿，即可开始生成笔记。'}
                {:else if workspace.modelCapability === 'video_audio' && !workspace.transcript.trim()}
                  当前模型支持视频与音轨理解，将直接提取音频与画面生成笔记{workspace.currentModelLabel ? `（${workspace.currentModelLabel}）` : ''}。
                {:else if workspace.modelCapability === 'text'}
                  当前模型为纯文本模式，仅发送文字稿内容{workspace.currentModelLabel ? `（${workspace.currentModelLabel}）` : ''}。
                {:else}
                  文字稿和必要画面会发送到你配置的模型{workspace.currentModelLabel ? `（${workspace.currentModelLabel}）` : ''}。
                {/if}
              </p>
              <button class="text-button completed-notes-link" type="button" onclick={() => ctrl.showCompletedNotes()}>查看已完成笔记 →</button>
            </div>
          </section>
        </div>
      </div>

      <section class="result-section" class:hidden={!workspace.resultVisible} id="result-section">
        <header class="result-heading">
          <div>
            <p class="section-label">整理结果</p>
            <label class="sr-only" for="note-title-input">笔记标题</label>
            <input
              id="note-title-input"
              class="note-title-input"
              type="text"
              aria-label="笔记标题"
              placeholder="笔记标题"
              title="点击可直接修改标题，失焦或按回车自动保存"
              bind:value={workspace.noteTitle}
              onblur={() => ctrl.saveNoteTitleInline()}
              onkeydown={handleTitleKeydown}
              disabled={!workspace.canEditTitle || workspace.titleSaving}
            >
          </div>
          <div class="result-actions" id="result-actions" class:hidden={!workspace.showResultActions}>
            <button class="text-button" class:hidden={!workspace.showRetryVisualAnalysis || workspace.generating} id="retry-visual-analysis" type="button" onclick={() => ctrl.retryVisualAnalysis()}>补充画面分析</button>
            <details class="action-menu" class:hidden={!workspace.canRegenerateNote || workspace.generating}>
              <summary class="text-button">重新生成</summary>
              <div class="action-menu-content">
                {#each NOTE_STRUCTURES as template (template.id)}
                  <button class="text-button" type="button" onclick={() => ctrl.regenerateOpenedNote(template.id)}>
                    <span>{template.label}</span>
                    {#if template.id === workspace.selectedTemplate}<small class="menu-badge">当前</small>{/if}
                  </button>
                {/each}
              </div>
            </details>
            <button class="text-button" id="open-quiz-panel" type="button" disabled={qz.quizState.generating} onclick={() => qz.toggleOrOpenQuiz()} class:hidden={!qz.quizState.showButton}>{qz.quizState.generating ? '正在出题…' : qz.quizState.buttonLabel}</button>
            <button class="text-button" id="open-flashcard-review" type="button" onclick={() => fc.startFlashcardReview()} class:hidden={!fc.flashcardState.showReviewButton}>{fc.flashcardState.reviewLabel}</button>
            <button class="text-button" id="export-anki" type="button" onclick={() => fc.exportAnkiTsv()} class:hidden={!fc.flashcardState.showAnkiExport}>导出 Anki</button>
            <button class="text-button" class:hidden={!workspace.currentLessonCacheBytes || workspace.generating} id="clear-lesson-cache" type="button" disabled={workspace.clearingCache} title="删除本节课缓存的音轨、原视频与转写过程数据，仅保留当前笔记结果" onclick={() => ctrl.clearCurrentLessonCache()}>清理缓存 · {workspace.currentLessonCacheLabel}</button>
            <button class="text-button" id="copy-note" type="button" onclick={() => ctrl.copyMarkdown()}>复制笔记</button>
            <button class="secondary-button" id="export-note-bundle" type="button" onclick={() => ctrl.exportCurrentNoteBundle()}>导出资源包</button>
          </div>
        </header>

        <aside class="note-generation-status" class:hidden={!workspace.generating && !workspace.canResumeGeneration && !workspace.generationError} data-kind={workspace.generationError ? 'error' : workspace.generating ? 'info' : 'warning'} aria-live="polite" aria-atomic="true">
          <div class="note-generation-status-copy">
            <strong>{workspace.generating ? '正在生成课程笔记' : workspace.generationError ? '生成未完成' : '生成可继续'}</strong>
            <p>{workspace.generationError || workspace.generationStageText || '正在准备生成任务…'}</p>
            <div class="note-generation-status-actions">
              <button class="secondary-button" class:hidden={!workspace.generating} id="cancel-generation" type="button" onclick={() => ctrl.cancelGeneration()}>停止生成</button>
              <button class="secondary-button" class:hidden={workspace.generating || !workspace.canResumeGeneration} id="resume-generation" type="button" onclick={() => ctrl.generate(true)}>继续生成剩余分段</button>
            </div>
          </div>
          {#if workspace.generationProgress.totalChunks > 1 || workspace.generating}
            <div class="note-generation-progress">
              <progress max={Math.max(1, workspace.generationProgress.totalChunks)} value={workspace.generationProgress.completedChunks} aria-label="文字稿整理进度"></progress>
              <span>文字稿 {workspace.generationProgress.completedChunks}/{Math.max(1, workspace.generationProgress.totalChunks)} 段</span>
            </div>
          {/if}
        </aside>

        <details class="frame-disclosure" class:hidden={!workspace.frames.length}>
          <summary>查看关键画面 <span>{workspace.frames.length} 张</span></summary>
          <div class="frame-gallery" id="frame-gallery">
            {#each workspace.frames as frame, index (index)}
              <figure class="frame-card">
                <img src={frame.dataUrl} alt={`${frame.timestamp} ${frame.caption}`} loading="lazy">
                <figcaption class="frame-caption">{frame.timestamp} · {frame.caption}</figcaption>
              </figure>
            {/each}
          </div>
        </details>

        <MarkdownEditor />

        <QuizPanel />

        <FlashcardPanel />

        <DiscussionPanel />
      </section>

      <NoteLibrary />
    </div>

    <SettingsPanel />
  </main>

  <WorkspaceRail />
</div>
