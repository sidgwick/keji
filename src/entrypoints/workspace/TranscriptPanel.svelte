<script lang="ts">
  import { tick } from 'svelte';
  import { Keji } from '../../lib/keji.ts';
  import { resolveSelectedTranscriptTimeRange } from '../../lib/subtitles.ts';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';
  import * as tx from '../../lib/workspace/transcription.svelte.ts';

  let transcriptElement = $state<HTMLTextAreaElement | undefined>();
  let expandButton = $state<HTMLButtonElement | undefined>();
  let transcriptFileInput: HTMLInputElement;

  let selectedRange = $state<{ start: number; end: number; label: string; tooLong: boolean } | null>(null);
  let selectionHint = $state('');
  let transcriptMoreOpen = $state(false);

  let hasTranscript = $derived(Boolean(workspace.transcript.trim()));
  let showEditor = $derived(hasTranscript || workspace.transcriptExpanded);
  let showEmptyState = $derived(!showEditor && !tx.transcriptionState.running);
  let cleanCaptionStatus = $derived(workspace.captionStatus.replace(/[。.]+$/u, '').trim());

  $effect(() => {
    workspace.currentVideo?.url;
    workspace.currentVideo?.page;
    workspace.transcriptExpanded;
    hasTranscript;
    transcriptMoreOpen = false;
  });

  $effect(() => {
    if (!workspace.transcript.trim()) {
      selectedRange = null;
      selectionHint = '';
    }
  });

  function syncSelection() {
    const textarea = transcriptElement;
    const transcript = workspace.transcript;
    if (!textarea || !transcript.trim()) {
      selectedRange = null;
      selectionHint = '';
      return;
    }
    const { selectionStart, selectionEnd } = textarea;
    if (selectionStart === selectionEnd) {
      selectedRange = null;
      selectionHint = '';
      return;
    }
    try {
      const range = resolveSelectedTranscriptTimeRange(
        transcript,
        selectionStart,
        selectionEnd,
        tx.getTranscriptionMetadata().segments,
      );
      selectedRange = {
        start: range.start,
        end: range.end,
        label: `${Keji.formatTime(range.start)}–${Keji.formatTime(range.end)}`,
        tooLong: range.end - range.start > 60,
      };
      selectionHint = '';
    } catch {
      selectedRange = null;
      selectionHint = '所选内容不含 [时间] 标记，请拖选带时间戳的行';
    }
  }

  async function handleRetranscribeSelection() {
    await tx.retranscribeSelectedTranscript(transcriptElement);
    await tick();
    syncSelection();
  }

  async function toggleEditorHeight() {
    workspace.transcriptExpanded = !workspace.transcriptExpanded;
    await tick();
    expandButton?.focus();
  }

  async function openManualEditor() {
    workspace.transcriptExpanded = true;
    await tick();
    transcriptElement?.focus();
  }
</script>

<section class="work-panel transcript-panel">
  <div class="transcript-card">
    <header class="tc-header">
      <div class="tc-title-group">
        <span
          class="status-indicator"
          class:is-ready={hasTranscript}
          class:is-running={tx.transcriptionState.running || tx.transcriptionState.starting}
          aria-hidden="true"
        ></span>
        <strong>字幕与文字稿</strong>
        <span class="tc-status" class:hidden={showEmptyState || !cleanCaptionStatus} id="caption-status" role="status">{cleanCaptionStatus}</span>
        <span class="character-count" class:hidden={!workspace.characterCount} id="character-count">· {workspace.characterCount.toLocaleString('zh-CN')} 字</span>
        <span class="caption-lang-pill" class:hidden={!workspace.captionLanguage} id="caption-language">{workspace.captionLanguage}</span>
      </div>

      <div class="tc-actions">
        <label id="caption-track-control" class="caption-track-control" class:hidden={workspace.captionTracks.length < 2}>
          <span class="sr-only">字幕语言</span>
          <select id="caption-track" aria-label="选择字幕语言" bind:value={workspace.selectedCaptionTrack} onchange={() => ctrl.changeCaptionTrack()}>
            {#each workspace.captionTracks as track (track.key)}
              <option value={track.key}>{track.label}{track.automatic ? ' · AI' : ''}</option>
            {/each}
          </select>
        </label>
        {#if showEmptyState}
          {#if workspace.currentVideo}
            <button
              class="tc-action-btn"
              id="reload-captions-empty"
              type="button"
              disabled={!workspace.canReloadCaptions}
              onclick={() => ctrl.loadCurrentVideo(null, true)}
            >重新检测字幕</button>
          {/if}
        {:else if !tx.transcriptionState.running}
          {#if hasTranscript}
            {#if workspace.currentVideo}
              <button
                class="tc-action-btn"
                id="transcribe-from-bar"
                type="button"
                title="使用语音转写重新识别课程音频"
                disabled={workspace.loadingVideo || tx.transcriptionState.starting}
                onclick={() => tx.startDirectTranscription()}
              >{tx.transcriptionState.starting ? '准备音轨…' : '重新转写'}</button>
            {/if}
            <details class="action-menu" bind:open={transcriptMoreOpen}>
              <summary>更多</summary>
              <div class="action-menu-content">
                <button
                  class="text-button"
                  id="reload-captions"
                  type="button"
                  disabled={!workspace.canReloadCaptions}
                  onclick={() => { transcriptMoreOpen = false; ctrl.loadCurrentVideo(null, true); }}
                >重新读取视频字幕</button>
                <button
                  class="text-button"
                  id="import-transcript"
                  type="button"
                  onclick={() => { transcriptMoreOpen = false; transcriptFileInput.click(); }}
                >导入替换 (.txt/.srt/.vtt)</button>
                <hr class="menu-divider">
                <button
                  class="text-button"
                  id="export-transcript"
                  type="button"
                  onclick={() => { transcriptMoreOpen = false; tx.exportTranscript(); }}
                >导出纯文本 (.txt)</button>
                <button
                  class="text-button"
                  id="export-srt"
                  type="button"
                  onclick={() => { transcriptMoreOpen = false; tx.exportTranscriptSrt(); }}
                >导出字幕 (.srt)</button>
              </div>
            </details>
          {:else}
            {#if workspace.currentVideo}
              <button
                class="tc-action-btn"
                id="reload-captions-manual"
                type="button"
                disabled={!workspace.canReloadCaptions}
                onclick={() => ctrl.loadCurrentVideo(null, true)}
              >重新检测字幕</button>
              <button
                class="tc-action-btn is-accent"
                id="transcribe-from-manual"
                type="button"
                title="使用语音转写识别课程音频"
                disabled={workspace.loadingVideo || tx.transcriptionState.starting}
                onclick={() => tx.startDirectTranscription()}
              >{tx.transcriptionState.starting ? '准备音轨…' : '语音转写'}</button>
            {/if}
            <button
              class="tc-action-btn"
              id="import-transcript-manual"
              type="button"
              onclick={() => transcriptFileInput.click()}
            >导入文件</button>
          {/if}
        {/if}
        <input bind:this={transcriptFileInput} class="hidden" id="transcript-file" type="file" accept=".txt,.srt,.vtt,text/plain,text/vtt,application/x-subrip" onchange={(event) => tx.importTranscriptFile(event.currentTarget.files?.[0], transcriptFileInput)}>
      </div>
    </header>

    {#if tx.transcriptionState.running}
      <div class="tc-live-bar">
        <div class="tc-live-top">
          <div class="tc-live-copy">
            <span class="tc-spinner" aria-hidden="true"></span>
            <strong>{tx.transcriptionState.phaseLabel || '正在转写音频'}</strong>
            <span class="tc-live-detail" id="transcription-progress" role="status">{tx.transcriptionState.progress}</span>
          </div>
          <div class="tc-live-actions">
            {#if tx.transcriptionState.progressPercent !== null}
              <span class="tc-live-pct">{tx.transcriptionState.progressPercent}%</span>
            {/if}
            <button
              class="tc-stop-btn"
              id="stop-transcription"
              type="button"
              disabled={tx.transcriptionState.stopping}
              onclick={() => tx.stopTranscription()}
            >{tx.transcriptionState.stopping ? '正在停止…' : '停止转写'}</button>
          </div>
        </div>
        <div class="tc-progress-track" aria-hidden="true">
          {#if tx.transcriptionState.progressPercent !== null}
            <span class="tc-progress-fill" style={`width: ${tx.transcriptionState.progressPercent}%`}></span>
          {:else}
            <span class="tc-progress-fill is-indeterminate"></span>
          {/if}
        </div>
      </div>
    {:else if tx.transcriptionState.progressVisible && tx.transcriptionState.progress && !tx.transcriptionState.conflict.visible}
      <div class="tc-outcome-bar" data-outcome={tx.transcriptionState.outcome}>
        <div class="tc-outcome-copy">
          {#if tx.transcriptionState.phaseLabel}
            <strong>{tx.transcriptionState.phaseLabel}</strong>
          {/if}
          <span id="transcription-outcome" role="status">{tx.transcriptionState.progress}</span>
        </div>
        <button
          class="tc-dismiss-btn"
          type="button"
          aria-label="关闭提示"
          title="关闭提示"
          onclick={() => tx.dismissTranscriptionProgress()}
        >×</button>
      </div>
    {/if}

    {#if tx.transcriptionState.conflict.visible}
      <div class="tc-conflict-bar" id="transcription-conflict" role="status" aria-live="polite">
        <div class="tc-conflict-copy">
          <strong>新识别稿已就绪</strong>
          <span id="transcription-conflict-copy">{tx.transcriptionState.conflict.copy}</span>
        </div>
        <div class="tc-conflict-actions">
          <button class="text-button" id="view-transcription-result" type="button" onclick={() => tx.viewTranscriptionResult()}>
            {tx.transcriptionState.previewOpen ? '收起识别稿' : '对比查看'}
          </button>
          <button class="tc-apply-btn" id="replace-with-transcription" type="button" onclick={() => tx.replaceTranscriptWithLatestResult()}>
            替换为识别稿
          </button>
          <button class="text-button" id="keep-current-transcript" type="button" onclick={() => tx.keepCurrentTranscript()}>
            保留当前稿
          </button>
        </div>
      </div>
      {#if tx.transcriptionState.previewOpen}
        <section class="tc-result-preview" id="transcription-result-preview" aria-label="本次语音识别结果">
          <header>
            <strong id="transcription-result-title">{tx.transcriptionState.conflict.title}</strong>
            <button class="text-button" id="close-transcription-result" type="button" onclick={() => (tx.transcriptionState.previewOpen = false)}>收起</button>
          </header>
          <textarea id="transcription-result-text" value={tx.transcriptionState.conflict.text} readonly spellcheck="false" aria-label="只读的本次识别稿"></textarea>
        </section>
      {/if}
    {/if}

    {#if showEmptyState}
      <div class="tc-empty" id="audio-fallback">
        {#if workspace.currentVideo}
          <div class="tc-empty-copy">
            <strong>{workspace.modelCapability === 'video_audio' ? '暂无字幕，可直接生成笔记' : '当前小节暂无字幕'}</strong>
            <span>
              {#if workspace.modelCapability === 'video_audio'}
                {workspace.currentLessonHasCachedAudio
                  ? '本机已缓存音轨，可直接生成笔记；如需文字稿，也可先语音转写。'
                  : '当前模型可直接看视频/听音频生成；如需文字稿，也可提取音轨并转写。'}
              {:else}
                {workspace.currentLessonHasCachedAudio
                  ? '本机已缓存音轨，可直接语音转写，也支持粘贴或导入文字稿。'
                  : '无需播放视频，可直接后台提取音轨并转写，或手动粘贴 / 导入文字稿。'}
              {/if}
            </span>
          </div>
          <div class="tc-empty-actions">
            <button
              class="tc-empty-primary"
              id="start-transcription"
              type="button"
              disabled={tx.transcriptionState.starting}
              onclick={() => tx.startDirectTranscription()}
            >{tx.transcriptionState.starting ? '准备音轨…' : workspace.currentLessonHasCachedAudio ? '语音转写' : '提取音轨并转写'}</button>
            <button class="text-button" type="button" onclick={openManualEditor}>手动粘贴</button>
            <button class="text-button" type="button" onclick={() => transcriptFileInput.click()}>导入文件</button>
          </div>
        {:else}
          <div class="tc-empty-copy">
            <strong>尚未载入视频</strong>
            <span>在 B 站视频页打开扩展后会自动提取字幕；也可以先手动粘贴或导入文字稿。</span>
          </div>
          <div class="tc-empty-actions">
            <button class="text-button" type="button" onclick={openManualEditor}>手动粘贴</button>
            <button class="text-button" type="button" onclick={() => transcriptFileInput.click()}>导入文件</button>
          </div>
        {/if}
      </div>
    {:else if !showEditor && tx.transcriptionState.running}
      <div class="tc-empty is-streaming">
        <div class="tc-empty-copy">
          <span>正在转写课程音轨，识别出的文字稿会按分段陆续显示在这里…</span>
        </div>
      </div>
    {:else}
      <textarea
        id="transcript"
        class="transcript-input tc-editor"
        class:is-expanded={workspace.transcriptExpanded}
        bind:this={transcriptElement}
        bind:value={workspace.transcript}
        oninput={() => { tx.onTranscriptInput(); syncSelection(); }}
        onblur={() => tx.onTranscriptBlur()}
        onselect={syncSelection}
        onmouseup={syncSelection}
        onkeyup={syncSelection}
        placeholder={'载入视频后，字幕会出现在这里。\n也可以直接粘贴或导入文字稿。'}
        spellcheck="false"
        aria-label="字幕或课程文字稿"
      ></textarea>

      <div class="tc-footer" class:is-selecting={Boolean(selectedRange) || tx.transcriptionState.retranscribingSelection}>
        <div class="tc-footer-info">
          {#if tx.transcriptionState.retranscribingSelection}
            <span class="tc-spinner is-sm" aria-hidden="true"></span>
            <span class="tc-selection-badge">正在重新识别 {selectedRange?.label ?? '选中片段'}…</span>
          {:else if selectedRange}
            <span class="tc-selection-badge">已选片段 {selectedRange.label}</span>
            {#if selectedRange.tooLong}
              <span class="tc-warning-badge">超过 60 秒上限</span>
            {/if}
          {:else if selectionHint}
            <span class="tc-hint-warn">{selectionHint}</span>
          {:else if hasTranscript}
            <span class="tc-hint">可直接编辑并自动保存 · 拖选带时间戳的文字可重新识别该片段</span>
          {:else}
            <span class="tc-hint">粘贴或输入课程文字稿，离开输入框后自动保存</span>
          {/if}
        </div>

        <div class="tc-footer-actions">
          {#if selectedRange || tx.transcriptionState.retranscribingSelection}
            <button
              class="tc-retranscribe-btn"
              id="retranscribe-selection"
              type="button"
              disabled={tx.transcriptionState.retranscribingSelection || Boolean(selectedRange?.tooLong)}
              onclick={handleRetranscribeSelection}
            >{tx.transcriptionState.retranscribingSelection ? '识别中…' : '重新识别片段'}</button>
          {/if}
          {#if hasTranscript}
            <button
              class="tc-height-btn"
              bind:this={expandButton}
              type="button"
              aria-controls="transcript"
              aria-expanded={workspace.transcriptExpanded}
              onclick={toggleEditorHeight}
            >{workspace.transcriptExpanded ? '收起高度 ⤡' : '展开编辑 ⤢'}</button>
          {:else if workspace.transcriptExpanded}
            <button
              class="tc-height-btn"
              bind:this={expandButton}
              type="button"
              onclick={() => (workspace.transcriptExpanded = false)}
            >返回</button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .transcript-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
  }

  .tc-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 14px;
    border-radius: 11px 11px 0 0;
    padding: 10px 14px;
    background: var(--well);
  }

  .tc-title-group {
    display: flex;
    min-width: 0;
    flex: 1 1 280px;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }

  .status-indicator {
    width: 8px;
    height: 8px;
    flex: none;
    border-radius: 50%;
    background: var(--control);
  }

  .status-indicator.is-ready {
    background: var(--success);
  }

  .status-indicator.is-running {
    background: var(--accent);
    animation: tc-pulse 1.5s ease-in-out infinite;
  }

  @keyframes tc-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .tc-title-group strong {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }

  .tc-status {
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .caption-lang-pill {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 8px;
    background: var(--surface);
    color: var(--muted);
    font-size: 11px;
    line-height: 1.5;
  }

  .tc-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
  }

  .caption-track-control {
    display: inline-flex;
    min-width: 0;
    align-items: center;
  }

  .caption-track-control select {
    min-width: 0;
    max-width: 170px;
    height: 28px;
    border: 1px solid var(--control);
    border-radius: 7px;
    padding: 0 8px;
    background: var(--surface);
    color: var(--ink);
    font-size: 12px;
  }

  .tc-action-btn {
    display: inline-flex;
    min-height: 28px;
    align-items: center;
    justify-content: center;
    border: 1px solid transparent;
    border-radius: 7px;
    padding: 2px 9px;
    background: transparent;
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }

  .tc-action-btn:hover:not(:disabled) {
    background: var(--surface);
    border-color: var(--border);
    color: var(--ink);
  }

  .tc-action-btn.is-accent {
    border-color: var(--control);
    background: var(--surface);
    color: var(--accent);
    font-weight: 600;
  }

  .tc-action-btn.is-accent:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--active);
  }

  .tc-actions :global(.action-menu > summary) {
    min-height: 28px;
    border-radius: 7px;
    padding: 2px 8px;
    font-size: 12px;
  }

  .tc-actions :global(.action-menu > summary:hover) {
    background: var(--surface);
  }

  /* Live transcription strip */
  .tc-live-bar {
    display: grid;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding: 10px 14px 11px;
    background: var(--active);
  }

  .tc-live-top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
  }

  .tc-live-copy {
    display: flex;
    min-width: 0;
    flex: 1 1 260px;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }

  .tc-live-copy strong {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--accent);
  }

  .tc-live-detail {
    color: var(--ink);
    font-size: 12.5px;
    overflow-wrap: anywhere;
  }

  .tc-live-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
  }

  .tc-live-pct {
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .tc-stop-btn {
    height: 28px;
    border: 1px solid var(--danger-border);
    border-radius: 7px;
    padding: 0 10px;
    background: var(--surface);
    color: var(--danger);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }

  .tc-stop-btn:hover:not(:disabled) {
    border-color: var(--danger);
    background: var(--danger-fill);
  }

  .tc-spinner {
    width: 14px;
    height: 14px;
    flex: none;
    border: 2px solid var(--accent);
    border-right-color: transparent;
    border-radius: 50%;
    animation: tc-spin 0.75s linear infinite;
  }

  .tc-spinner.is-sm {
    width: 12px;
    height: 12px;
  }

  @keyframes tc-spin {
    to { transform: rotate(360deg); }
  }

  .tc-progress-track {
    position: relative;
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--control);
  }

  .tc-progress-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 220ms ease;
  }

  .tc-progress-fill.is-indeterminate {
    width: 36%;
    animation: tc-indeterminate 1.4s ease-in-out infinite;
  }

  @keyframes tc-indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(300%); }
  }

  /* Outcome banner */
  .tc-outcome-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    border-top: 1px solid var(--border);
    padding: 7px 10px 7px 14px;
    background: var(--well);
    font-size: 12px;
  }

  .tc-outcome-bar[data-outcome='done'] {
    background: var(--success-fill);
    color: var(--success);
  }

  .tc-outcome-bar[data-outcome='error'] {
    background: var(--danger-fill);
    color: var(--danger);
  }

  .tc-outcome-copy {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
  }

  .tc-outcome-copy strong {
    font-weight: 600;
  }

  .tc-outcome-copy span {
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .tc-outcome-bar[data-outcome='done'] .tc-outcome-copy span {
    color: var(--success);
  }

  .tc-outcome-bar[data-outcome='error'] .tc-outcome-copy span {
    color: var(--danger);
  }

  .tc-dismiss-btn {
    display: inline-flex;
    width: 24px;
    height: 24px;
    flex: none;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font-size: 15px;
    line-height: 1;
    opacity: 0.72;
  }

  .tc-dismiss-btn:hover {
    background: #0000000d;
    opacity: 1;
  }

  /* Conflict banner + embedded comparison box */
  .tc-conflict-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    border-top: 1px solid var(--border);
    padding: 10px 14px;
    background: var(--active);
    font-size: 12.5px;
  }

  .tc-conflict-copy {
    display: flex;
    min-width: 0;
    flex: 1 1 240px;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
  }

  .tc-conflict-copy strong {
    color: var(--accent);
    font-weight: 600;
  }

  .tc-conflict-copy span {
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .tc-conflict-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .tc-conflict-actions :global(.text-button) {
    min-height: 28px;
    padding: 2px 8px;
    font-size: 12px;
  }

  .tc-apply-btn {
    height: 28px;
    border: 1px solid var(--accent);
    border-radius: 7px;
    padding: 0 11px;
    background: var(--accent);
    color: var(--surface);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  .tc-apply-btn:hover {
    border-color: var(--accent-hover);
    background: var(--accent-hover);
  }

  .tc-result-preview {
    border-top: 1px solid var(--border);
    padding: 10px 14px 12px;
    background: var(--well);
  }

  .tc-result-preview > header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }

  .tc-result-preview > header strong {
    min-width: 0;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .tc-result-preview textarea {
    display: block;
    width: 100%;
    height: 176px;
    min-height: 120px;
    resize: vertical;
    border: 1px solid var(--control);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--surface);
    color: var(--ink);
    font-size: 13px;
    line-height: 1.7;
    font-variant-numeric: tabular-nums;
  }

  /* Empty / missing-captions card body */
  .tc-empty {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px 16px;
    border-top: 1px solid var(--border);
    border-radius: 0 0 11px 11px;
    padding: 16px 16px;
    background: var(--surface);
  }

  .tc-empty.is-streaming {
    padding: 20px 16px;
  }

  .tc-empty-copy {
    display: grid;
    min-width: 0;
    flex: 1 1 320px;
    gap: 3px;
  }

  .tc-empty-copy strong {
    font-size: 14px;
    font-weight: 600;
    color: var(--ink);
  }

  .tc-empty-copy span {
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.55;
  }

  .tc-empty-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .tc-empty-primary {
    display: inline-flex;
    min-height: 36px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--accent);
    border-radius: 8px;
    padding: 0 14px;
    background: var(--accent);
    color: var(--surface);
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
  }

  .tc-empty-primary:hover:not(:disabled) {
    border-color: var(--accent-hover);
    background: var(--accent-hover);
  }

  .tc-empty-actions :global(.text-button) {
    min-height: 34px;
    padding: 4px 10px;
    font-size: 12.5px;
  }

  /* Unified editor body & contextual footer */
  .tc-editor {
    display: block;
    width: 100%;
    height: 216px;
    min-height: 150px;
    resize: vertical;
    border: 0;
    border-top: 1px solid var(--border);
    border-radius: 0;
    padding: 12px 16px;
    background: var(--surface);
    color: var(--ink);
    font-size: 13.5px;
    line-height: 1.75;
    font-variant-numeric: tabular-nums;
  }

  .tc-editor.is-expanded {
    height: 420px;
  }

  .tc-editor:focus {
    outline: none;
    box-shadow: inset 2px 0 0 var(--accent);
  }

  .tc-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    border-top: 1px solid var(--rule);
    border-radius: 0 0 11px 11px;
    padding: 7px 14px;
    background: var(--well);
    transition: background-color 150ms ease, border-color 150ms ease;
  }

  .tc-footer.is-selecting {
    border-top-color: var(--control);
    background: var(--active);
  }

  .tc-footer-info {
    display: flex;
    min-width: 0;
    flex: 1 1 240px;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
  }

  .tc-hint {
    color: var(--muted);
    font-size: 12px;
  }

  .tc-hint-warn {
    color: var(--danger);
    font-size: 12px;
  }

  .tc-selection-badge {
    border-radius: 6px;
    padding: 1px 8px;
    background: var(--surface);
    border: 1px solid var(--control);
    color: var(--accent);
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .tc-warning-badge {
    border-radius: 6px;
    padding: 1px 7px;
    background: var(--warning-fill);
    border: 1px solid var(--warning-border);
    color: #85600b;
    font-size: 11.5px;
    font-weight: 500;
  }

  .tc-footer-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .tc-retranscribe-btn {
    height: 28px;
    border: 1px solid var(--accent);
    border-radius: 7px;
    padding: 0 10px;
    background: var(--accent);
    color: var(--surface);
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }

  .tc-retranscribe-btn:hover:not(:disabled) {
    border-color: var(--accent-hover);
    background: var(--accent-hover);
  }

  .tc-height-btn {
    min-height: 28px;
    border: 0;
    border-radius: 7px;
    padding: 2px 8px;
    background: transparent;
    color: var(--accent);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }

  .tc-height-btn:hover {
    background: var(--surface);
  }

  @media (max-width: 700px) {
    .tc-editor {
      font-size: 16px;
    }
  }
</style>
