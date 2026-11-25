<script lang="ts">
  import * as ctrl from '../../lib/workspace/controller.ts';
  import { formatBytes } from '../../lib/lesson-cache.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  const files = [
    { kind: 'audio', label: '纯音轨', description: 'M4A · 只有声音' },
    { kind: 'video', label: '纯画面', description: 'MP4 · 不含声音' },
    { kind: 'audiovisual', label: '音轨 + 画面', description: 'MP4 · 带声音的视频' }
  ] as const;

  function available(kind: 'audio' | 'video' | 'audiovisual'): boolean {
    return kind === 'audio' ? workspace.currentLessonHasCachedAudio
      : kind === 'video' ? workspace.currentLessonHasCachedVideo
      : workspace.currentLessonHasCachedMuxedVideo;
  }
</script>

<section class="work-panel media-files-panel" aria-label="本节媒体文件">
  <header class="panel-heading media-files-heading">
    <div><h2>本节媒体文件</h2></div>
    <button class="secondary-button" type="button" disabled={workspace.currentLessonMediaBusy || workspace.generating} onclick={() => ctrl.prepareCurrentLessonMedia()}>
      {#if workspace.currentLessonMediaBusy}<span class="button-spinner" aria-hidden="true"></span>正在准备{:else if workspace.currentLessonHasCachedAudio && workspace.currentLessonHasCachedVideo && workspace.currentLessonHasCachedMuxedVideo}检查并补齐{:else}准备三种文件{/if}
    </button>
  </header>
  <p class="media-files-intro">按当前分 P 保存到浏览器本地，可随时分别下载。</p>
  <div class="media-files-list">
    {#each files as file}
      <div class="media-file-row">
        <div class="media-file-copy"><strong>{file.label}</strong><span>{file.description}</span></div>
        <span class="media-file-size">{available(file.kind) ? formatBytes(workspace.currentLessonMediaSizes[file.kind]) : '未缓存'}</span>
        <button class="text-button" type="button" disabled={!available(file.kind) || workspace.currentLessonMediaBusy} onclick={() => ctrl.downloadCurrentLessonMedia(file.kind)}>下载</button>
      </div>
    {/each}
  </div>
  {#if workspace.currentLessonMediaStatus}<p class="media-files-status" role="status">{workspace.currentLessonMediaStatus}</p>{/if}
</section>
