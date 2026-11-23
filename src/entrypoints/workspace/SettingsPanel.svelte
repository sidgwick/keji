<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { formatBytes } from '../../lib/lesson-cache.ts';
  import { persistSettings, readSettings, testModelConnection, type SettingsFormState } from '../../lib/settings.ts';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  const groups = [
    { id: 'connection', label: '模型连接', number: '01' },
    { id: 'transcription', label: '语音转写', number: '02' },
    { id: 'generation', label: '生成偏好', number: '03' },
    { id: 'backup', label: '备份同步', number: '04' },
    { id: 'about', label: '其他信息', number: '05' },
  ];

  const capabilityHints: Record<string, string> = {
    text: '仅发送课程文字稿整理笔记与讨论；即使存在关键帧截图，也不会把图片发给模型，适合纯文本模型。',
    image: '需先获取文字稿；生成后会截取候选画面作为关键帧发给视觉模型筛选与校对，讨论也会附带关键帧图片。',
    video_silent: '需先获取文字稿；会优先压缩并发送当前分 P 视频画面给模型联合理解，若视频过大或接口不支持则自动回退到关键帧图片。',
    video_audio: '直接理解视频画面与讲师音轨，无字幕课程无需先转写即可点击生成笔记；若已有字幕则优先结合字幕文字校对画面。',
  };

  function onProtocolChange(event: Event) {
    const protocol = (event.currentTarget as HTMLSelectElement).value;
    const currentBase = String(settings.baseUrl || '').trim();
    if (!currentBase || currentBase === 'https://api.openai.com/v1' || currentBase === 'https://api.xiaomimimo.com/v1') {
      settings.baseUrl = protocol === 'mimo' ? 'https://api.xiaomimimo.com/v1' : 'https://api.openai.com/v1';
    }
    setDirty(true);
  }

  let formElement: HTMLFormElement;
  let settings = $state<Partial<SettingsFormState>>({});
  let grantedOrigins = $state<string[]>([]);
  let loading = $state(true);
  let loaded = $state(false);
  let dirty = $state(false);
  let busy = $state(false);
  let testing = $state(false);
  let invalidFieldId = $state('');
  let status = $state<{ message: string; kind: 'info' | 'success' | 'error' }>({ message: '正在读取本地设置…', kind: 'info' });
  const disabled = $derived(loading || !loaded || busy || testing);

  function setStatus(message: string, kind: 'info' | 'success' | 'error' = 'info') {
    status = { message, kind };
  }

  function setDirty(value: boolean) {
    dirty = Boolean(value);
  }

  async function refreshGrantedOrigins() {
    try {
      const result = await chrome.permissions?.getAll?.();
      grantedOrigins = [...new Set(result?.origins || [])].sort();
    } catch {
      grantedOrigins = [];
    }
  }

  async function loadSettings() {
    loading = true;
    loaded = false;
    setStatus('正在读取本地设置…');
    try {
      settings = await readSettings();
      ctrl.applyWorkspaceSettings(settings);
      loaded = true;
      setDirty(false);
      setStatus('');
      void refreshGrantedOrigins();
    } catch (error) {
      setStatus((error as Error).message || '读取设置失败，请重试。', 'error');
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadSettings();
  });

  $effect(() => {
    if (workspace.activeView === 'settings' && workspace.settingsGroup === 'about') {
      void ctrl.refreshCacheOverview();
    }
  });

  function markDirty(event: Event) {
    if (!loaded || disabled) return;
    setDirty(true);
    if ((event.target as HTMLElement | null)?.id === invalidFieldId) invalidFieldId = '';
    if (status.kind === 'success') setStatus('');
  }

  function protectUnsavedChanges(event: BeforeUnloadEvent) {
    if (!dirty && !busy) return;
    event.preventDefault();
    event.returnValue = '';
  }

  async function revealField(field: HTMLElement, report = false) {
    const group = field.closest<HTMLElement>('[data-settings-group]');
    if (group?.dataset.settingsGroup) workspace.settingsGroup = group.dataset.settingsGroup;
    for (let ancestor = field.parentElement; ancestor && ancestor !== formElement; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    }
    await tick();
    field.focus();
    if (report && 'reportValidity' in field) (field as HTMLInputElement).reportValidity();
  }

  // Only invalid paths wait for rendering; valid paths retain the permission API's user gesture.
  function validate() {
    invalidFieldId = '';
    const invalid = formElement.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:invalid, textarea:invalid, select:invalid');
    if (!invalid) return true;
    invalidFieldId = invalid.id;
    const label = invalid.labels?.[0]?.querySelector('span')?.textContent?.trim() || '此项设置';
    setStatus(`请检查「${label}」：${invalid.validationMessage}`, 'error');
    void revealField(invalid, true);
    return false;
  }

  function showError(error: unknown, fallback: string) {
    const message = (error as Error).message || fallback;
    setStatus(message, 'error');
    let id: string | undefined;
    if (/语音识别 API|最多配置 4 个/.test(message)) id = 'settings-transcription-endpoint';
    else if (/远程.*端点|同步地址|自动同步前|WebDAV 用户名|同步账户或密码|账户用户名和密码/.test(message)) id = 'settings-remote-backup-url';
    else if (/API 地址|请填写有效的完整 API 地址/.test(message)) id = 'settings-base-url';
    const field = id ? formElement.querySelector<HTMLElement>(`#${id}`) : null;
    if (field) {
      invalidFieldId = id!;
      void revealField(field);
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (disabled || !validate()) return;
    busy = true;
    setStatus('正在保存（如浏览器弹出域名连接询问，请点击“允许”）…');
    try {
      settings = await persistSettings(settings);
      ctrl.applyWorkspaceSettings(settings);
      setDirty(false);
      setStatus('设置已保存。', 'success');
      void refreshGrantedOrigins();
    } catch (error) {
      showError(error, '保存失败，请重试。');
    } finally {
      busy = false;
    }
  }

  async function testConnection() {
    if (disabled || !validate()) return;
    testing = true;
    setStatus('正在测试连接（如浏览器弹出域名询问，请点击“允许”）…');
    try {
      const result = await testModelConnection(settings);
      setStatus(`连接成功：${result.model} 返回“${result.response}”。测试不会保存设置。`, 'success');
      void refreshGrantedOrigins();
    } catch (error) {
      showError(error, '连接测试失败。');
    } finally {
      testing = false;
    }
  }
</script>

<svelte:window onbeforeunload={protectUnsavedChanges} />

<section class="settings-panel" class:hidden={workspace.activeView !== 'settings'} id="settings-panel" aria-label="课记设置">
  <form bind:this={formElement} class="settings-form" novalidate onsubmit={save} oninput={markDirty}>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分组">
        {#each groups as group (group.id)}
          <button
            type="button"
            class="settings-nav-item"
            aria-current={workspace.settingsGroup === group.id ? 'page' : undefined}
            aria-controls={`settings-${group.id}`}
            disabled={loading || !loaded}
            onclick={() => (workspace.settingsGroup = group.id)}
          >
            <span class="settings-nav-number" aria-hidden="true">{group.number}</span>
            <span>{group.label}</span>
          </button>
        {/each}
        <p class="settings-nav-note">设置保存在本地浏览器；切换左侧页面不会丢失未保存内容。</p>
      </nav>

      <div class="settings-content">
        <fieldset class="settings-panels" disabled={disabled} aria-busy={loading || busy || testing}>
          <legend class="sr-only">课记设置</legend>

          <section id="settings-connection" data-settings-group="connection" hidden={workspace.settingsGroup !== 'connection'} aria-labelledby="settings-connection-heading">
            <header class="settings-section-heading">
              <h2 id="settings-connection-heading">模型连接</h2>
              <p>选择接口协议、模型能力与连接参数，用于生成笔记、分析音视频与课后讨论。</p>
            </header>
            <label class="field">
              <span>接口协议 / 服务商类型</span>
              <select id="settings-api-protocol" bind:value={settings.apiProtocol} name="apiProtocol" onchange={onProtocolChange} aria-invalid={invalidFieldId === 'settings-api-protocol' || undefined} aria-describedby="settings-api-protocol-hint">
                <option value="openai">通用 OpenAI 兼容 / 中转站</option>
                <option value="mimo">小米 MiMo 开放平台</option>
              </select>
              <small id="settings-api-protocol-hint">{settings.apiProtocol === 'mimo' ? '按小米 MiMo 平台规范组织多模态字段（video_url 含 fps 与 media_resolution，input_audio 使用 data URI）。' : '按标准 OpenAI Chat Completions 及通用中转格式组织文本、图片、视频与音频请求。'}</small>
            </label>
            <label class="field">
              <span>API 地址</span>
              <input id="settings-base-url" bind:value={settings.baseUrl} name="baseUrl" type="url" placeholder={settings.apiProtocol === 'mimo' ? 'https://api.xiaomimimo.com/v1' : 'https://api.example.com/v1'} required aria-invalid={invalidFieldId === 'settings-base-url' || undefined} aria-describedby="settings-base-url-hint">
              <small id="settings-base-url-hint">填写服务商提供的 API 根地址；扩展会在末尾添加 <code>/chat/completions</code>。</small>
            </label>
            <label class="field">
              <span>模型名称</span>
              <input id="settings-model" bind:value={settings.model} name="model" type="text" placeholder={settings.apiProtocol === 'mimo' ? '例如 mimo-v2.6-pro、mimo-v2-omni' : '例如服务商文档中的模型 ID'} required aria-invalid={invalidFieldId === 'settings-model' || undefined} aria-describedby="settings-model-hint">
              <small id="settings-model-hint">实际发送给 API 的模型 ID。</small>
            </label>
            <label class="field">
              <span>模型能力</span>
              <select id="settings-model-capability" bind:value={settings.modelCapability} name="modelCapability" aria-invalid={invalidFieldId === 'settings-model-capability' || undefined} aria-describedby="settings-model-capability-hint">
                <option value="text">支持文本（仅文字稿整理）</option>
                <option value="image">支持图片（文字稿 + 关键帧画面校对）</option>
                <option value="video_silent">支持视频但不理解音轨（文字稿 + 整段视频画面）</option>
                <option value="video_audio">支持视频且理解音轨（可免转写直接理解音视频）</option>
              </select>
              <small id="settings-model-capability-hint">{capabilityHints[settings.modelCapability || 'text']}</small>
            </label>
            <label class="field">
              <span>API Key <em>可选，本地保存</em></span>
              <input id="settings-api-key" bind:value={settings.apiKey} name="apiKey" type="password" autocomplete="off" placeholder="sk-…" aria-invalid={invalidFieldId === 'settings-api-key' || undefined} aria-describedby="settings-api-key-hint">
              <small id="settings-api-key-hint">仅保存在当前浏览器扩展的本地存储中，并在请求时发送给你配置的 API。</small>
            </label>
          </section>

          <section id="settings-transcription" data-settings-group="transcription" hidden={workspace.settingsGroup !== 'transcription'} aria-labelledby="settings-transcription-heading">
            <header class="settings-section-heading">
              <h2 id="settings-transcription-heading">语音转写</h2>
              <p>{settings.modelCapability === 'video_audio' ? '当前模型已设为「支持视频且理解音轨」，无字幕视频可直接生成笔记；如需先获得可编辑文字稿，也可在此配置转写服务。' : '没有字幕时，直接下载当前分 P 的音轨，无需播放视频。本机解码后，可分段并行调用兼容 OpenAI 转写接口的云端 API 或本机 Whisper 服务。'}</p>
            </header>
            <label class="field">
              <span>语音识别 API 地址 <em>可选</em></span>
              <textarea id="settings-transcription-endpoint" bind:value={settings.transcriptionEndpoint} name="transcriptionEndpoint" rows="3" placeholder="默认使用笔记 API 地址 + /audio/transcriptions" aria-invalid={invalidFieldId === 'settings-transcription-endpoint' || undefined} aria-describedby="settings-transcription-endpoint-hint"></textarea>
              <small id="settings-transcription-endpoint-hint">每行一个兼容 OpenAI 的转写接口，最多 4 个。多个地址共用下方的模型名称和 API Key；留空时使用笔记 API 地址。</small>
            </label>
            <label class="field">
              <span>语音识别模型</span>
              <input id="settings-transcription-model" bind:value={settings.transcriptionModel} name="transcriptionModel" type="text" placeholder="云端例如 whisper-1；本机例如 Systran/faster-whisper-small" aria-invalid={invalidFieldId === 'settings-transcription-model' || undefined}>
            </label>
            <label class="field">
              <span>语音识别 API Key <em>可选</em></span>
              <input id="settings-transcription-api-key" bind:value={settings.transcriptionApiKey} name="transcriptionApiKey" type="password" autocomplete="off" placeholder="云端填写服务商 Key；本机无鉴权时留空" aria-invalid={invalidFieldId === 'settings-transcription-api-key' || undefined} aria-describedby="settings-transcription-api-key-hint">
              <small id="settings-transcription-api-key-hint">转写服务专用 Key，仅保存在本地，并发送给配置的转写服务；不会自动使用笔记 API Key。本机服务通常无需填写。</small>
            </label>
            <details class="advanced-settings">
              <summary>高级设置 <span>语言、术语与并行识别</span></summary>
              <div class="advanced-fields">
                <label class="field">
                  <span>转写语言 <em>可选，留空自动检测</em></span>
                  <input id="settings-transcription-language" bind:value={settings.transcriptionLanguage} name="transcriptionLanguage" type="text" inputmode="latin" maxlength="2" pattern={'[A-Za-z]{2}'} placeholder="zh、en、ja" aria-invalid={invalidFieldId === 'settings-transcription-language' || undefined} aria-describedby="settings-transcription-language-hint">
                  <small id="settings-transcription-language-hint">填写 ISO 639-1 两字母代码指定音轨语言，如中文 <code>zh</code>、英语 <code>en</code>、日语 <code>ja</code>。留空由转写模型检测。</small>
                </label>
                <label class="field">
                  <span>专业词汇提示 <em>可选</em></span>
                  <textarea id="settings-transcription-prompt" bind:value={settings.transcriptionPrompt} name="transcriptionPrompt" rows="2" maxlength="200" placeholder="例如：ARM、Bootloader、U-Boot、S3C2440" aria-invalid={invalidFieldId === 'settings-transcription-prompt' || undefined} aria-describedby="settings-transcription-prompt-hint"></textarea>
                  <small id="settings-transcription-prompt-hint">按音轨使用的语言填写课程术语或专有名词，帮助 Whisper 类模型识别。最多 200 字符。</small>
                </label>
                <label class="field">
                  <span>并行识别分段</span>
                  <select id="settings-transcription-concurrency" bind:value={settings.transcriptionConcurrency} name="transcriptionConcurrency" aria-invalid={invalidFieldId === 'settings-transcription-concurrency' || undefined} aria-describedby="settings-transcription-concurrency-hint">
                    <option value="0">自动</option>
                    <option value="1">1 段</option>
                    <option value="2">2 段</option>
                    <option value="4">4 段</option>
                  </select>
                  <small id="settings-transcription-concurrency-hint">每段约 3 分钟。自动模式下，单地址按顺序处理；多个地址按地址数并行，最多 4 段。</small>
                </label>
              </div>
            </details>
          </section>

          <section id="settings-generation" data-settings-group="generation" hidden={workspace.settingsGroup !== 'generation'} aria-labelledby="settings-generation-heading">
            <header class="settings-section-heading">
              <h2 id="settings-generation-heading">生成偏好</h2>
              <p>设置默认整理要求、长内容分段并发数与生成温度；多模态能力请在「01 模型连接」中设置。</p>
            </header>
            <label class="field">
              <span>默认自定义模板 Prompt <em>可选</em></span>
              <textarea id="settings-custom-prompt" bind:value={settings.customPrompt} name="customPrompt" rows="4" placeholder="留空时可在每次生成笔记时填写" aria-invalid={invalidFieldId === 'settings-custom-prompt' || undefined}></textarea>
            </label>
            <label class="field">
              <span>笔记分段并行数</span>
              <select id="settings-generation-concurrency" bind:value={settings.generationConcurrency} name="generationConcurrency" aria-invalid={invalidFieldId === 'settings-generation-concurrency' || undefined} aria-describedby="settings-generation-concurrency-hint">
                <option value="1">1 段（顺序处理）</option>
                <option value="2">2 段（推荐）</option>
                <option value="3">3 段</option>
                <option value="4">4 段</option>
              </select>
              <small id="settings-generation-concurrency-hint">长文字稿按约 12,000 字符分段；首段先建立章节，后续分段最多并行 4 段。并行请求可能触发服务商速率限制，可调低并行数。</small>
            </label>
            <details class="advanced-settings">
              <summary>高级设置 <span>生成温度</span></summary>
              <div class="advanced-fields">
                <label class="field">
                  <span>Temperature</span>
                  <input id="settings-temperature" bind:value={settings.temperature} name="temperature" type="number" min="0" max="2" step="0.1" aria-invalid={invalidFieldId === 'settings-temperature' || undefined}>
                </label>
              </div>
            </details>
          </section>

          <section id="settings-backup" data-settings-group="backup" hidden={workspace.settingsGroup !== 'backup'} aria-labelledby="settings-backup-heading">
            <header class="settings-section-heading">
              <h2 id="settings-backup-heading">远程同步</h2>
              <p>使用 WebDAV 服务在设备间备份并合并笔记。支持在笔记库手动上传/合并，也可按需开启自动同步。</p>
            </header>
            <label class="field">
              <span>远程备份端点 URL <em>可选</em></span>
              <input id="settings-remote-backup-url" bind:value={settings.remoteBackupUrl} name="remoteBackupUrl" type="url" placeholder="https://dav.example.com/keji/notes.json" aria-invalid={invalidFieldId === 'settings-remote-backup-url' || undefined} aria-describedby="settings-remote-backup-url-hint">
              <small id="settings-remote-backup-url-hint">填写 WebDAV 目标文件 URL。建议使用 HTTPS；本机回环地址可用 HTTP。</small>
            </label>
            <label class="field">
              <span>WebDAV 用户名 <em>可选</em></span>
              <input id="settings-remote-backup-username" bind:value={settings.remoteBackupUsername} name="remoteBackupUsername" type="text" autocomplete="username" aria-invalid={invalidFieldId === 'settings-remote-backup-username' || undefined}>
            </label>
            <label class="field">
              <span>WebDAV 密码或应用专用密码 <em>可选</em></span>
              <input id="settings-remote-backup-password" bind:value={settings.remoteBackupPassword} name="remoteBackupPassword" type="password" autocomplete="new-password" aria-invalid={invalidFieldId === 'settings-remote-backup-password' || undefined} aria-describedby="settings-remote-backup-password-hint">
              <small id="settings-remote-backup-password-hint">凭据仅保存在当前浏览器本机，用于连接你配置的 WebDAV 服务。</small>
            </label>
            <label class="checkbox-field">
              <input id="settings-remote-backup-auto-sync" name="remoteBackupAutoSync" type="checkbox" bind:checked={settings.remoteBackupAutoSync} aria-invalid={invalidFieldId === 'settings-remote-backup-auto-sync' || undefined}>
              <span><strong>保存笔记后自动同步</strong><small>新增、修改、删除笔记或更新闪卡复习进度会排队同步。每次先合并远程版本，再安全上传；可随时关闭。</small></span>
            </label>
            <p class="settings-data-note">启用后，完整笔记库（含文字稿、讨论和截图）会在变更后空闲约两分钟时传到该地址，不会发送到模型 API。</p>
          </section>

          <section id="settings-about" data-settings-group="about" hidden={workspace.settingsGroup !== 'about'} aria-labelledby="settings-about-heading">
            <header class="settings-section-heading">
              <h2 id="settings-about-heading">其他信息</h2>
              <p>过程文件缓存、连接权限、本机存储机制与常用快捷键说明。</p>
            </header>
            <div class="settings-info-cards">
              <article class="settings-info-card">
                <h3>过程文件缓存</h3>
                <p>每节课生成过程中获取的音轨、音轨转文本结果与原视频流会缓存在当前浏览器的 Origin Private File System 中，方便后续重新生成、补充画面分析、片段重识别或与大模型深入讨论。清理过程缓存会释放这些临时媒体与转写过程数据，<strong>已生成的笔记正文、内嵌截图与讨论记录会完整保留</strong>。</p>
                <div class="cache-breakdown">
                  <span class="cache-stat-pill">总计 <strong>{workspace.totalCacheLabel || '0 B'}</strong></span>
                  <span class="cache-stat-pill">原视频 {formatBytes(workspace.cacheOverview.videoBytes)}</span>
                  <span class="cache-stat-pill">音轨 {formatBytes(workspace.cacheOverview.audioBytes)}</span>
                  <span class="cache-stat-pill">转写缓存 {formatBytes(workspace.cacheOverview.transcriptBytes)}</span>
                  <span class="cache-stat-pill">涉及 {workspace.cacheOverview.lessonCount || 0} 节</span>
                </div>
                <div class="cache-card-actions">
                  <button class="text-button" type="button" disabled={workspace.clearingCache} onclick={() => ctrl.refreshCacheOverview()}>刷新统计</button>
                  <button
                    class="secondary-button danger-button"
                    id="clear-all-process-cache"
                    type="button"
                    disabled={!workspace.totalCacheBytes || workspace.clearingCache || workspace.generating}
                    onclick={() => ctrl.clearAllProcessCache()}
                  >{workspace.clearingCache ? '正在清理…' : '清理全部过程缓存（仅保留笔记）'}</button>
                </div>
              </article>
              <article class="settings-info-card">
                <h3>连接与域名权限</h3>
                <p>保存设置、测试连接或获取无字幕音轨与视频画面时，浏览器会按需询问是否允许扩展连接你填写的笔记 API、语音转写服务、远程同步地址及 B 站音视频 CDN。使用本机服务（如 Whisper）时，允许连接 <code>127.0.0.1</code> 或 <code>localhost</code> 即可。</p>
                {#if grantedOrigins.length}
                  <div class="granted-origins">
                    <span>当前已授权的服务域名：</span>
                    <div class="origin-tags">
                      {#each grantedOrigins as origin (origin)}
                        <code>{origin}</code>
                      {/each}
                    </div>
                  </div>
                {/if}
              </article>
              <article class="settings-info-card">
                <h3>本机数据与隐私</h3>
                <p>API Key、课程笔记与关键帧截图均保存在当前浏览器的本地存储与 IndexedDB 数据库中。课程内容仅在生成或转写时发送给你自己配置的接口；远程同步默认关闭，开启后仅传往你指定的 WebDAV 地址。</p>
              </article>
              <article class="settings-info-card">
                <h3>快捷键一览</h3>
                <ul class="shortcut-list">
                  <li><span>打开课记工作区</span><code>Ctrl + Shift + Y</code></li>
                  <li><span>保存笔记修改</span><code>Ctrl / Cmd + S</code></li>
                  <li><span>发送讨论修订</span><code>Ctrl / Cmd + Enter</code></li>
                  <li><span>闪卡复习操作</span><code>Space 翻面 · 1 / 2 / 3 评分 · Esc 结束</code></li>
                </ul>
              </article>
            </div>
          </section>
        </fieldset>
      </div>
    </div>

    <footer class="settings-footer" class:hidden={workspace.settingsGroup === 'about' && !dirty}>
      <div class="settings-save-feedback">
        <p class="settings-save-status" id="settings-save-status" data-kind={status.kind} role="status" aria-live="polite" aria-atomic="true">{status.message || (dirty ? '有未保存的修改' : '')}</p>
        {#if !loading && !loaded}
          <button class="secondary-button" type="button" onclick={loadSettings}>重新读取设置</button>
        {/if}
      </div>
      <div class="settings-actions">
        <button
          class="secondary-button"
          class:hidden={workspace.settingsGroup !== 'connection'}
          id="settings-test-model"
          type="button"
          disabled={disabled}
          title="仅发送一条简短文本验证连接，不发送音视频，也不自动保存设置"
          onclick={testConnection}
        >{testing ? '正在测试…' : '测试模型连接'}</button>
        <button class="primary-button settings-save-button" type="submit" disabled={disabled}>{busy ? '正在保存…' : '保存全部设置'}</button>
      </div>
    </footer>
  </form>
</section>
