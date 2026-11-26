<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { formatBytes } from '../../lib/lesson-cache.ts';
  import { persistSettings, readSettings, testModelConnection, testTranscriptionConnection, type SettingsFormState } from '../../lib/settings.ts';
  import * as ctrl from '../../lib/workspace/controller.ts';
  import { workspace } from '../../lib/workspace/state.svelte.ts';

  const groups = [
    { id: 'connection', label: '模型与生成', number: '01' },
    { id: 'transcription', label: '语音转写', number: '02' },
    { id: 'backup', label: '同步与存储', number: '03' },
  ];

  const capabilityHints: Record<string, string> = {
    text: '仅发送课程文字稿整理笔记与答疑，不发送图片或视频，适合纯文本模型。',
    image: '需先获取文字稿；生成笔记后自动截取候选画面，由视觉模型筛选并校对，助教答疑也会附带截图。',
    video_silent: '需先获取文字稿；优先将本节视频画面发给模型联合理解，若视频过大或接口不支持，自动回退到关键帧截图。',
    video_audio: '可直接理解课程画面与讲师语音，无字幕也能直接生成笔记；若已有字幕，会优先结合字幕校对画面。',
  };

  let presetNameDraft = $state('');

  function applySelectedPreset(event: Event) {
    const presetId = (event.currentTarget as HTMLSelectElement).value;
    settings.activePresetId = presetId;
    const preset = (settings.modelPresets || []).find((item) => item.id === presetId);
    if (!preset) return;
    settings.baseUrl = preset.baseUrl;
    settings.model = preset.model;
    settings.modelCapability = preset.modelCapability;
    settings.apiKey = preset.apiKey;
    presetNameDraft = preset.name;
    setDirty(true);
  }

  function saveCurrentAsPreset() {
    const model = String(settings.model || '').trim();
    const baseUrl = String(settings.baseUrl || '').trim().replace(/\/+$/, '');
    if (!model || !baseUrl) {
      setStatus('请先填写有效的 API 地址与模型名称，再保存为预设。', 'error');
      return;
    }
    const name = presetNameDraft.trim() || model;
    const list = [...(settings.modelPresets || [])];
    const existingIndex = list.findIndex((item) => item.id === settings.activePresetId || item.name === name);
    const id = existingIndex >= 0 ? list[existingIndex]!.id : crypto.randomUUID();
    const nextPreset = {
      id,
      name,
      baseUrl,
      model,
      modelCapability: settings.modelCapability || 'text',
      apiKey: String(settings.apiKey || '').trim(),
    } as const;
    if (existingIndex >= 0) list[existingIndex] = nextPreset;
    else list.push(nextPreset);
    settings.modelPresets = list;
    settings.activePresetId = id;
    presetNameDraft = name;
    setDirty(true);
    setStatus(`预设「${name}」已加入列表，请点击下方「保存全部设置」使其生效。`, 'info');
  }

  function deleteSelectedPreset() {
    const id = String(settings.activePresetId || '');
    if (!id) return;
    settings.modelPresets = (settings.modelPresets || []).filter((item) => item.id !== id);
    settings.activePresetId = '';
    presetNameDraft = '';
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
  let status = $state<{ message: string; kind: 'info' | 'success' | 'error' }>({ message: '正在读取本机设置…', kind: 'info' });
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
    setStatus('正在读取本机设置…');
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
    if (workspace.activeView === 'settings' && workspace.settingsGroup === 'backup') {
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
  function validate(sectionId?: string) {
    invalidFieldId = '';
    const scope = sectionId ? formElement.querySelector<HTMLElement>(`#${sectionId}`) || formElement : formElement;
    const invalid = scope.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:invalid, textarea:invalid, select:invalid');
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
    if (/语音识别 API|转写服务/.test(message)) id = 'settings-transcription-endpoint';
    else if (/WebDAV 备份地址|远程.*端点|同步地址|自动同步前|WebDAV 用户名|同步账户或密码|账户用户名和密码/.test(message)) id = 'settings-remote-backup-url';
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
    setStatus('正在保存（如浏览器弹出权限提示，请点击“允许”）…');
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
    if (disabled || !validate('settings-connection')) return;
    testing = true;
    setStatus('正在测试模型连接（如浏览器弹出权限提示，请点击“允许”）…');
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

  async function testTranscription() {
    if (disabled || !validate('settings-transcription')) return;
    testing = true;
    setStatus('正在测试语音连接（首次加载本机模型可能需要数秒；如弹出权限提示，请点击“允许”）…');
    try {
      const result = await testTranscriptionConnection(settings);
      const detail = result.response ? `，返回“${result.response}”` : '，静音样本正常响应';
      setStatus(`连接成功：${result.model}（${result.protocol}，耗时 ${result.elapsedMs} ms${detail}）。测试不会保存设置。`, 'success');
      void refreshGrantedOrigins();
    } catch (error) {
      showError(error, '语音连接测试失败。');
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
        <p class="settings-nav-note">设置保存在当前浏览器本机；切换左侧分组不会丢失未保存的修改。</p>
      </nav>

      <div class="settings-content">
        <fieldset class="settings-panels" disabled={disabled} aria-busy={loading || busy || testing}>
          <legend class="sr-only">课记设置</legend>

          <section id="settings-connection" data-settings-group="connection" hidden={workspace.settingsGroup !== 'connection'} aria-labelledby="settings-connection-heading">
            <header class="settings-section-heading">
              <h2 id="settings-connection-heading">模型与生成</h2>
              <p>配置 OpenAI 兼容模型接口、模型能力、常用预设切换与分段生成参数。</p>
            </header>
            <div class="preset-card">
              <div class="preset-card-row">
                <label class="sr-only" for="settings-preset-select">模型配置预设</label>
                <select id="settings-preset-select" value={settings.activePresetId || ''} onchange={applySelectedPreset}>
                  <option value="">常用模型预设（可选）</option>
                  {#each settings.modelPresets || [] as preset (preset.id)}
                    <option value={preset.id}>{preset.name} · {preset.model}</option>
                  {/each}
                </select>
                <input type="text" class="preset-name-input" bind:value={presetNameDraft} placeholder="预设备注名，例如 GPT-4o / 本地模型">
                <button type="button" class="secondary-button" onclick={saveCurrentAsPreset}>存为预设</button>
                {#if settings.activePresetId}
                  <button type="button" class="text-button danger-button" onclick={deleteSelectedPreset}>删除</button>
                {/if}
              </div>
              <small>保存预设后，可在「当前课程」生成页直接下拉一键切换模型，无需再进设置页修改。</small>
            </div>
            <label class="field">
              <span>API 地址</span>
              <input id="settings-base-url" bind:value={settings.baseUrl} name="baseUrl" type="url" placeholder="https://api.example.com/v1" required aria-invalid={invalidFieldId === 'settings-base-url' || undefined} aria-describedby="settings-base-url-hint">
              <small id="settings-base-url-hint">填写服务商提供的 OpenAI 兼容地址（未含 <code>/chat/completions</code> 时自动补全）。</small>
            </label>
            <label class="field">
              <span>模型名称</span>
              <input id="settings-model" bind:value={settings.model} name="model" type="text" placeholder="例如服务商文档中的模型 ID" required aria-invalid={invalidFieldId === 'settings-model' || undefined} aria-describedby="settings-model-hint">
              <small id="settings-model-hint">实际发送给 API 的模型 ID。</small>
            </label>
            <label class="field">
              <span>模型能力</span>
              <select id="settings-model-capability" bind:value={settings.modelCapability} name="modelCapability" aria-invalid={invalidFieldId === 'settings-model-capability' || undefined} aria-describedby="settings-model-capability-hint">
                <option value="text">仅文本（只读文字稿）</option>
                <option value="image">图文多模态（文字稿 + 关键帧截图）</option>
                <option value="video_silent">视频画面（文字稿 + 视频画面，不含音轨）</option>
                <option value="video_audio">音视频全模态（免字幕直接理解画面与声音）</option>
              </select>
              <small id="settings-model-capability-hint">{capabilityHints[settings.modelCapability || 'text']}</small>
            </label>
            <label class="field">
              <span>API Key <em>可选，本机保存</em></span>
              <input id="settings-api-key" bind:value={settings.apiKey} name="apiKey" type="password" autocomplete="off" placeholder="sk-…" aria-invalid={invalidFieldId === 'settings-api-key' || undefined} aria-describedby="settings-api-key-hint">
              <small id="settings-api-key-hint">仅保存在本机浏览器中，只在请求时发送给你配置的 API 服务。</small>
            </label>
            <label class="field">
              <span>笔记分段并行数</span>
              <select id="settings-generation-concurrency" bind:value={settings.generationConcurrency} name="generationConcurrency" aria-invalid={invalidFieldId === 'settings-generation-concurrency' || undefined} aria-describedby="settings-generation-concurrency-hint">
                <option value="1">1 段（顺序处理）</option>
                <option value="2">2 段（推荐）</option>
                <option value="3">3 段</option>
                <option value="4">4 段</option>
              </select>
              <small id="settings-generation-concurrency-hint">长文字稿按约 12,000 字符分段；首段先建立章节，后续分段最多并行 4 段。</small>
            </label>
            <details class="advanced-settings">
              <summary>高级生成偏好 <span>默认自定义要求与生成随机度</span></summary>
              <div class="advanced-fields">
                <label class="field">
                  <span>默认自定义笔记要求 <em>可选</em></span>
                  <textarea id="settings-custom-prompt" bind:value={settings.customPrompt} name="customPrompt" rows="3" placeholder="留空时可在每次生成笔记时填写" aria-invalid={invalidFieldId === 'settings-custom-prompt' || undefined}></textarea>
                </label>
                <label class="field">
                  <span>生成随机度（Temperature）</span>
                  <input id="settings-temperature" bind:value={settings.temperature} name="temperature" type="number" min="0" max="2" step="0.1" aria-invalid={invalidFieldId === 'settings-temperature' || undefined} aria-describedby="settings-temperature-hint">
                  <small id="settings-temperature-hint">控制输出的发散程度（0–2）。数值越低越严谨稳定，推荐 0.2–0.4。</small>
                </label>
              </div>
            </details>
          </section>

          <section id="settings-transcription" data-settings-group="transcription" hidden={workspace.settingsGroup !== 'transcription'} aria-labelledby="settings-transcription-heading">
            <header class="settings-section-heading">
              <h2 id="settings-transcription-heading">语音转写</h2>
              <p>{settings.modelCapability === 'video_audio' ? '当前模型支持直接理解音视频，无字幕课程可直接生成笔记；如需先获得可编辑文字稿，也可通过本机 Ollama（Qwen3-ASR 1.7B）或 OpenAI 兼容语音接口转写。' : '没有字幕时可直接提取本节音轨并转写，无需播放视频；支持本机 Ollama（Qwen3-ASR 1.7B）及兼容 OpenAI 音频输入的开放平台。'}</p>
            </header>
            <label class="field">
              <span>转写服务地址</span>
              <input id="settings-transcription-endpoint" bind:value={settings.transcriptionEndpoint} name="transcriptionEndpoint" type="url" placeholder="http://127.0.0.1:11434/api/chat" aria-invalid={invalidFieldId === 'settings-transcription-endpoint' || undefined} aria-describedby="settings-transcription-endpoint-hint">
              <small id="settings-transcription-endpoint-hint">默认连接本机 Ollama（<code>/api/chat</code>）；若使用开放平台（如阿里云百炼）或兼容接口，填 <code>.../v1</code> 即可（会自动补全路径）。本机 Ollama 若报 403，请配置环境变量 <code>OLLAMA_ORIGINS=*</code> 后重启。</small>
            </label>
            <label class="field">
              <span>识别模型</span>
              <input id="settings-transcription-model" bind:value={settings.transcriptionModel} name="transcriptionModel" type="text" placeholder="例如 frozenlab/qwen3-asr:1.7b 或 qwen3-asr-flash" aria-invalid={invalidFieldId === 'settings-transcription-model' || undefined} aria-describedby="settings-transcription-model-hint">
              <small id="settings-transcription-model-hint">本机 Ollama 推荐 <code>frozenlab/qwen3-asr:1.7b</code>（高准确）或 <code>0.6b</code>（速度更快）；建议转写时运行 <code>ollama ps</code> 确认已使用 GPU。</small>
            </label>
            <label class="field">
              <span>专业词汇提示 <em>可选，用英文逗号分隔</em></span>
              <textarea id="settings-transcription-prompt" bind:value={settings.transcriptionPrompt} name="transcriptionPrompt" rows="2" maxlength="200" placeholder="例如：ARM, Bootloader, U-Boot, S3C2440" aria-invalid={invalidFieldId === 'settings-transcription-prompt' || undefined} aria-describedby="settings-transcription-prompt-hint"></textarea>
              <small id="settings-transcription-prompt-hint">填课程中的专有名词或英文缩写，用英文逗号 <code>,</code> 分隔（自动去空格），帮助语音模型更准确识别，最多 200 字。</small>
            </label>
            <label class="field">
              <span>API Key <em>可选</em></span>
              <input id="settings-transcription-api-key" bind:value={settings.transcriptionApiKey} name="transcriptionApiKey" type="password" autocomplete="off" placeholder="本机 Ollama 留空；接入开放平台时填写" aria-invalid={invalidFieldId === 'settings-transcription-api-key' || undefined} aria-describedby="settings-transcription-api-key-hint">
              <small id="settings-transcription-api-key-hint">仅保存在本机并发送给你配置的转写服务；使用本机 Ollama 时无需填写。</small>
            </label>
          </section>

          <section id="settings-backup" data-settings-group="backup" hidden={workspace.settingsGroup !== 'backup'} aria-labelledby="settings-backup-heading">
            <header class="settings-section-heading">
              <h2 id="settings-backup-heading">同步与存储</h2>
              <p>配置 WebDAV 跨设备备份、媒体缓存清理与常用快捷键。</p>
            </header>
            <label class="field">
              <span>WebDAV 备份地址 <em>可选</em></span>
              <input id="settings-remote-backup-url" bind:value={settings.remoteBackupUrl} name="remoteBackupUrl" type="url" placeholder="https://dav.example.com/keji/notes.json" aria-invalid={invalidFieldId === 'settings-remote-backup-url' || undefined} aria-describedby="settings-remote-backup-url-hint">
              <small id="settings-remote-backup-url-hint">填写 WebDAV 备份文件的完整 URL。建议使用 HTTPS；本机地址（127.0.0.1 / localhost）可用 HTTP。</small>
            </label>
            <label class="field">
              <span>WebDAV 用户名 <em>可选</em></span>
              <input id="settings-remote-backup-username" bind:value={settings.remoteBackupUsername} name="remoteBackupUsername" type="text" autocomplete="username" aria-invalid={invalidFieldId === 'settings-remote-backup-username' || undefined}>
            </label>
            <label class="field">
              <span>WebDAV 密码或应用专用密码 <em>可选</em></span>
              <input id="settings-remote-backup-password" bind:value={settings.remoteBackupPassword} name="remoteBackupPassword" type="password" autocomplete="new-password" aria-invalid={invalidFieldId === 'settings-remote-backup-password' || undefined} aria-describedby="settings-remote-backup-password-hint">
              <small id="settings-remote-backup-password-hint">凭据仅保存在本机浏览器中，用于连接你配置的 WebDAV 服务。</small>
            </label>
            <label class="checkbox-field">
              <input id="settings-remote-backup-auto-sync" name="remoteBackupAutoSync" type="checkbox" bind:checked={settings.remoteBackupAutoSync} aria-invalid={invalidFieldId === 'settings-remote-backup-auto-sync' || undefined}>
              <span><strong>保存笔记后自动同步</strong><small>新增、修改、删除笔记或更新闪卡/自测进度会排队同步。每次先合并远程版本，再安全上传；可随时关闭。</small></span>
            </label>
            <p class="settings-data-note">启用后，笔记变更约 2 分钟后会自动同步到该 WebDAV 地址，不会发送给模型 API。</p>

            <div class="settings-info-cards storage-cards">
              <article class="settings-info-card">
                <h3>媒体与转写缓存</h3>
                <p>每节课提取的音轨、原视频流和转写缓存保存在浏览器本机缓存空间中。清理媒体缓存可释放磁盘空间，<strong>已生成的笔记、截图、闪卡与自测记录都会完整保留</strong>。</p>
                <div class="cache-breakdown">
                  <span class="cache-stat-pill">总计 <strong>{workspace.totalCacheLabel || '0 B'}</strong></span>
                  <span class="cache-stat-pill">原视频 {formatBytes(workspace.cacheOverview.videoBytes)}</span>
                  <span class="cache-stat-pill">音画合成 {formatBytes(workspace.cacheOverview.muxedVideoBytes)}</span>
                  <span class="cache-stat-pill">音轨 {formatBytes(workspace.cacheOverview.audioBytes)}</span>
                  <span class="cache-stat-pill">转写缓存 {formatBytes(workspace.cacheOverview.transcriptBytes)}</span>
                  <span class="cache-stat-pill">已缓存 {workspace.cacheOverview.lessonCount || 0} 节</span>
                </div>
                <div class="cache-card-actions">
                  <button class="text-button" type="button" disabled={workspace.clearingCache} onclick={() => ctrl.refreshCacheOverview()}>刷新统计</button>
                  <button
                    class="secondary-button danger-button"
                    id="clear-all-process-cache"
                    type="button"
                    disabled={!workspace.totalCacheBytes || workspace.clearingCache || workspace.generating}
                    onclick={() => ctrl.clearAllProcessCache()}
                  >{workspace.clearingCache ? '正在清理…' : '清理全部媒体缓存（不影响笔记）'}</button>
                </div>
              </article>

              <details class="advanced-settings">
                <summary>已授权域名、隐私说明与快捷键 <span>{grantedOrigins.length} 个已授权域名</span></summary>
                <div class="advanced-fields storage-details">
                  <p class="settings-data-note">API Key 与课程笔记均保存在本机浏览器中，仅在发起请求时发送给你配置的模型、转写或 WebDAV 服务。</p>
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
                  <ul class="shortcut-list">
                    <li><span>打开课记工作区</span><code>Ctrl + Shift + Y</code></li>
                    <li><span>保存笔记修改</span><code>Ctrl / Cmd + S</code></li>
                    <li><span>发送 AI 助教消息</span><code>Ctrl / Cmd + Enter</code></li>
                    <li><span>闪卡复习操作</span><code>空格 翻面 · 1 重来 · 2 有点难 · 3 记住了</code></li>
                  </ul>
                </div>
              </details>
            </div>
          </section>
        </fieldset>
      </div>
    </div>

    <footer class="settings-footer">
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
        <button
          class="secondary-button"
          class:hidden={workspace.settingsGroup !== 'transcription'}
          id="settings-test-transcription"
          type="button"
          disabled={disabled}
          title="发送一段 0.5 秒静音样本检测语音服务是否连通，不会保存设置"
          onclick={testTranscription}
        >{testing ? '正在测试…' : '测试语音连接'}</button>
        <button class="primary-button settings-save-button" type="submit" disabled={disabled}>{busy ? '正在保存…' : '保存全部设置'}</button>
      </div>
    </footer>
  </form>
</section>

<style>
  .preset-card {
    margin-bottom: 18px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
    background: var(--well);
  }

  .preset-card-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .preset-card-row select,
  .preset-name-input {
    height: 36px;
    border: 1px solid var(--control);
    border-radius: 8px;
    padding: 0 10px;
    background: var(--surface);
    color: var(--ink);
    font-size: 13px;
  }

  .preset-card-row select {
    flex: 1 1 200px;
  }

  .preset-name-input {
    flex: 1 1 160px;
  }

  .preset-card small {
    display: block;
    margin-top: 8px;
    color: var(--muted);
    font-size: 12px;
  }

  .storage-cards {
    margin-top: 18px;
  }

  .storage-details {
    display: grid;
    gap: 12px;
    padding-bottom: 10px;
  }
</style>
