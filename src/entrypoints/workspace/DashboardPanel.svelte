<script lang="ts">
  import * as ctrl from '../../lib/workspace/controller.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';
</script>

<section class="dashboard-panel" class:hidden={workspace.activeView !== 'home'} id="dashboard-panel" aria-label="课程控制台">
  <header class="dashboard-welcome">
    <div>
      <p class="section-label">课程控制台</p>
      <h2>让学过的内容随时可查</h2>
      <p>从 B 站课程生成带时间戳与关键帧画面的结构化笔记，并用闪卡、自测与费曼复述巩固理解。</p>
    </div>
    <button class="primary-button dashboard-start-button" id="dashboard-start-video" type="button" onclick={() => ctrl.openCreateView()}>
      <span>分析一个 B 站视频</span><span aria-hidden="true">→</span>
    </button>
  </header>

  {#if !workspace.modelConfigured}
    <aside class="onboarding-banner" role="note">
      <div class="onboarding-copy">
        <strong>尚未配置笔记模型连接</strong>
        <span>先填写兼容 OpenAI 或小米 MiMo 的服务地址与模型名称，即可开始整理课程笔记。</span>
      </div>
      <button class="secondary-button" type="button" onclick={() => ctrl.openSettingsView('connection')}>去配置模型 →</button>
    </aside>
  {/if}

  <div class="dashboard-stats" id="dashboard-stats" aria-label="学习资料统计">
    {#each workspace.dashboardStats as stat (`${stat.label}:${stat.value}`)}
      <div class="notes-library-stat"><strong>{stat.value}</strong><span>{stat.label}</span></div>
    {/each}
  </div>

  <section class="dashboard-recent" aria-labelledby="dashboard-recent-title">
    <header>
      <div>
        <p class="section-label">继续学习</p>
        <h3 id="dashboard-recent-title">最近笔记</h3>
      </div>
      <button class="text-button" id="dashboard-open-library" type="button" onclick={() => ctrl.showNoteLibrary()}>查看全部笔记 →</button>
    </header>
    <div class="dashboard-recent-list" id="dashboard-recent-list" aria-live="polite">
      {#if workspace.dashboardError}
        <p class="dashboard-empty">{workspace.dashboardError}</p>
      {:else if !workspace.dashboardRows.length}
        <p class="dashboard-empty">还没有笔记。载入一条 B 站课程，生成后就会出现在这里。</p>
      {:else}
        {#each workspace.dashboardRows as row (row.note.id)}
          <article class="dashboard-note">
            <button class="dashboard-note-open" type="button" onclick={() => ctrl.openSavedNote(row.note, { returnView: 'home' })}>
              {#if row.coverUrl}<img class="dashboard-note-cover" src={row.coverUrl} alt="" loading="lazy" referrerpolicy="no-referrer" onerror={(event) => event.currentTarget.remove()}>{/if}
              <span class="dashboard-note-copy"><strong>{row.title}</strong><span title={row.error}>{row.meta}</span>{#if row.excerpt}<span class="dashboard-note-excerpt">{row.excerpt}</span>{/if}</span>
            </button>
          </article>
        {/each}
      {/if}
    </div>
  </section>
</section>

<style>
  .dashboard-panel {
    max-width: 1180px;
    margin: 0 auto;
    padding: 32px 40px 64px;
  }

  .dashboard-welcome {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 24px;
    padding-bottom: 24px;
  }

  .dashboard-welcome > div {
    min-width: 0;
    flex: 1;
  }

  .dashboard-welcome h2 {
    margin: 4px 0 8px;
    font-size: 28px;
    font-weight: 600;
    line-height: 1.4;
  }

  .dashboard-welcome > div > p:last-child {
    max-width: 560px;
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }

  .dashboard-start-button {
    width: auto;
    min-width: 184px;
    flex: none;
    margin: 0;
  }

  .dashboard-stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  .notes-library-stat {
    display: grid;
    min-width: 0;
    min-height: 88px;
    align-content: center;
    gap: 6px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    background: var(--surface);
  }

  .notes-library-stat strong {
    font-size: 22px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .notes-library-stat span {
    color: var(--muted);
    font-size: 12px;
  }

  .dashboard-recent {
    margin-top: 28px;
  }

  .dashboard-recent > header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 12px;
  }

  .dashboard-recent h3 {
    margin: 4px 0 0;
    font-size: 18px;
    font-weight: 600;
  }

  .dashboard-recent-list {
    min-width: 0;
  }

  .dashboard-note {
    border-bottom: 1px solid var(--rule);
  }

  .dashboard-note-open {
    display: flex;
    width: 100%;
    min-width: 0;
    min-height: 72px;
    align-items: center;
    gap: 12px;
    border: 0;
    border-radius: 8px;
    padding: 12px 4px;
    background: transparent;
    color: var(--ink);
    text-align: left;
  }

  .dashboard-note-open:hover {
    background: var(--well);
  }

  .dashboard-note-open:hover strong {
    color: var(--accent);
  }

  .dashboard-note-cover {
    width: 88px;
    height: 52px;
    flex: none;
    border-radius: 4px;
    object-fit: cover;
    background: var(--well);
  }

  .dashboard-note-copy {
    display: grid;
    min-width: 0;
    gap: 4px;
  }

  .dashboard-note-copy strong {
    overflow: hidden;
    font-size: 15px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dashboard-note-copy > span {
    color: var(--muted);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .dashboard-note-copy .dashboard-note-excerpt {
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    color: var(--muted);
    font-size: 13px;
  }

  .dashboard-empty {
    margin: 0;
    padding: 20px 4px;
    color: var(--muted);
    font-size: 13px;
  }

  @media (max-width: 1100px) {
    .dashboard-panel {
      padding-right: 24px;
      padding-left: 24px;
    }
  }

  @media (max-width: 960px) {
    .dashboard-welcome {
      align-items: flex-start;
      flex-wrap: wrap;
    }
  }

  @media (max-width: 700px) {
    .dashboard-panel {
      padding: 16px 16px 32px;
    }

    .dashboard-welcome {
      flex-direction: column;
      gap: 16px;
    }

    .dashboard-start-button {
      width: 100%;
    }

    .dashboard-stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
  }
</style>
