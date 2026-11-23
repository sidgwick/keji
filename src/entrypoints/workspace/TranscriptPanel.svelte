<script lang="ts">
  import { tick } from 'svelte';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';
  import * as tx from '../../lib/workspace/transcription.svelte.ts';

  let transcriptElement: HTMLTextAreaElement;
  let expandButton: HTMLButtonElement;
  let startTxButton: HTMLButtonElement;
  let stopTxButton: HTMLButtonElement;
  let retranscribeButton: HTMLButtonElement;
  let transcriptFileInput: HTMLInputElement;
  let showEditor = $derived(workspace.transcriptExpanded || !workspace.transcript.trim());

  async function expandTranscript() {
    workspace.transcriptExpanded = true;
    await tick();
    transcriptElement.focus();
  }

  async function collapseTranscript() {
    workspace.transcriptExpanded = false;
    await tick();
    expandButton.focus();
  }
</script>

<section class="work-panel transcript-panel">
  <header class="panel-heading">
    <div>
      <p class="section-label">02 / 内容</p>
      <h2>确认文字内容</h2>
    </div>
    <div class="panel-heading-meta">
      <span id="character-count" class="character-count">{workspace.characterCount.toLocaleString('zh-CN')} 字</span>
    </div>
  </header>

  <div class="caption-status" id="caption-status" role="status">{workspace.captionStatus}</div>
  <div class="audio-fallback" class:hidden={(!workspace.currentVideo || workspace.hasCaptions) && !tx.transcriptionState.running} id="audio-fallback">
    <div class="audio-copy">
      <strong>
        {#if tx.transcriptionState.running}
          正在转写音频
        {:else if workspace.modelCapability === 'video_audio'}
          没有字幕，也可以直接生成笔记
        {:else}
          这个视频还没有字幕
        {/if}
      </strong>
      <span>
        {#if workspace.modelCapability === 'video_audio'}
          {workspace.currentLessonHasCachedAudio
            ? '当前模型支持视频与音轨理解，本机也已缓存音轨；可直接点击下方生成笔记，或按需先转写文字稿。'
            : '当前模型支持视频与音轨理解，无需转写字幕即可在下方直接生成笔记；若需先核对或编辑讲稿，也可获取音轨转写。'}
        {:else}
          {workspace.currentLessonHasCachedAudio
            ? '本机已缓存当前分 P 音轨，可直接快速转写而无需重复下载；也可以导入或粘贴文字稿。'
            : '可获取音轨并发送到你配置的转写服务，无需播放视频；也可以导入或粘贴文字稿。'}
        {/if}
      </span>
    </div>
    <div class="audio-actions">
      <button bind:this={startTxButton} class="secondary-button" class:hidden={tx.transcriptionState.running} id="start-transcription" type="button" onclick={() => tx.startDirectTranscription(startTxButton)}>获取音轨并转写</button>
      <button bind:this={stopTxButton} class="text-button" class:hidden={!tx.transcriptionState.running} id="stop-transcription" type="button" onclick={() => tx.stopTranscription(stopTxButton)}>停止转写</button>
    </div>
  </div>
  <div class="transcription-progress" class:hidden={!tx.transcriptionState.progressVisible} id="transcription-progress" role="status">{tx.transcriptionState.progress}</div>

  <div class="transcription-conflict" id="transcription-conflict" class:hidden={!tx.transcriptionState.conflict.visible} role="status" aria-live="polite">
    <span id="transcription-conflict-copy">{tx.transcriptionState.conflict.copy}</span>
    <div>
      <button class="text-button" id="view-transcription-result" type="button" onclick={() => tx.viewTranscriptionResult()}>查看识别稿</button>
      <button class="text-button" id="replace-with-transcription" type="button" onclick={() => tx.replaceTranscriptWithLatestResult()}>替换为识别稿</button>
      <button class="text-button" id="keep-current-transcript" type="button" onclick={() => tx.keepCurrentTranscript()}>保留当前稿</button>
    </div>
  </div>
  <section class="transcription-result-preview" id="transcription-result-preview" class:hidden={!tx.transcriptionState.previewOpen} aria-label="本次语音识别结果">
    <header>
      <strong id="transcription-result-title">{tx.transcriptionState.conflict.title}</strong>
      <button class="text-button" id="close-transcription-result" type="button" onclick={() => (tx.transcriptionState.previewOpen = false)}>收起</button>
    </header>
    <textarea id="transcription-result-text" value={tx.transcriptionState.conflict.text} readonly spellcheck="false" aria-label="只读的本次识别稿"></textarea>
  </section>

  <div class="transcript-summary" class:hidden={showEditor}>
    <pre aria-label="文字稿预览">{workspace.transcript.slice(0, 700)}{workspace.transcript.length > 700 ? '\n…' : ''}</pre>
  </div>
  <textarea id="transcript" class="transcript-input" class:hidden={!showEditor} bind:this={transcriptElement} bind:value={workspace.transcript} oninput={() => { workspace.transcriptExpanded = true; tx.onTranscriptInput(); }} onblur={() => tx.onTranscriptBlur()} placeholder={'载入视频后，字幕会出现在这里。\n也可以直接粘贴或导入文字稿。'} spellcheck="false" aria-label="字幕或课程文字稿"></textarea>

  <div class="transcript-retry-row" class:hidden={!showEditor || !workspace.transcript.trim()}>
    <span>选中带时间戳的文字行，可重新识别该片段。</span>
    <div class="transcript-retry-action">
      <select class="retranscribe-lang-select" aria-label="重新识别语言" bind:value={tx.transcriptionState.retranscribeLanguage}>
        <option value="">自动检测语言</option>
        <option value="zh">中文 (zh)</option>
        <option value="en">英语 (en)</option>
        <option value="ja">日语 (ja)</option>
      </select>
      <button bind:this={retranscribeButton} class="text-button" id="retranscribe-selection" type="button" onclick={() => tx.retranscribeSelectedTranscript(transcriptElement, retranscribeButton)}>重新识别选中片段</button>
    </div>
  </div>
  <div class="transcript-footer">
    <button class="text-button transcript-expand" class:hidden={showEditor} bind:this={expandButton} type="button" aria-controls="transcript" aria-expanded="false" onclick={expandTranscript}>展开全文并编辑 <span aria-hidden="true">↗</span></button>
    <button class="text-button transcript-collapse" class:hidden={!workspace.transcriptExpanded || !workspace.transcript.trim()} type="button" aria-controls="transcript" aria-expanded="true" onclick={collapseTranscript}>收起编辑器</button>
    <span id="caption-language">{workspace.captionLanguage}</span>
    <label id="caption-track-control" class="caption-track-control" class:hidden={workspace.captionTracks.length < 2}>
      <span>字幕语言</span>
      <select id="caption-track" aria-label="选择字幕语言" bind:value={workspace.selectedCaptionTrack} onchange={() => ctrl.changeCaptionTrack()}>
        {#each workspace.captionTracks as track (track.key)}
          <option value={track.key}>{track.label}{track.automatic ? ' · AI' : ''}</option>
        {/each}
      </select>
    </label>
    <div class="transcript-actions">
      <button class="text-button" id="import-transcript" type="button" onclick={() => transcriptFileInput.click()}>导入文字稿</button>
      <input bind:this={transcriptFileInput} class="hidden" id="transcript-file" type="file" accept=".txt,.srt,.vtt,text/plain,text/vtt,application/x-subrip" onchange={(event) => tx.importTranscriptFile(event.currentTarget.files?.[0], transcriptFileInput)}>
      <details class="action-menu">
        <summary>导出文字稿</summary>
        <div class="action-menu-content">
          <button class="text-button" id="export-transcript" type="button" onclick={() => tx.exportTranscript()}>纯文本 .txt</button>
          <button class="text-button" id="export-srt" type="button" onclick={() => tx.exportTranscriptSrt()}>带时间戳字幕 .srt</button>
        </div>
      </details>
    </div>
  </div>
</section>
