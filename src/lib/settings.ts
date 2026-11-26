import { Keji, type KejiSettings, type ModelCapability } from './keji.ts';
import { BILIBILI_CDN_ORIGINS } from './lesson-cache.ts';

export type SettingsFormState = {
  [K in keyof KejiSettings]: KejiSettings[K];
};

function parseHttpUrl(raw: unknown, invalidMsg: string, protocolMsg: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch {
    throw new Error(invalidMsg);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(protocolMsg);
  return parsed;
}

export async function readSettings(): Promise<SettingsFormState> {
  const result = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  const source: Partial<KejiSettings> & Record<string, unknown> = result?.settings || Keji.defaultSettings;
  const baseUrl = String(source.baseUrl || Keji.defaultSettings.baseUrl).trim();
  return {
    ...Keji.defaultSettings,
    ...source,
    modelCapability: Keji.normalizeCapability(source.modelCapability, source.videoInputMode),
    modelPresets: Array.isArray(source.modelPresets) ? source.modelPresets : [],
    activePresetId: String(source.activePresetId || ''),
    transcriptionEndpoint: String(source.transcriptionEndpoint || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean)[0] || Keji.defaultSettings.transcriptionEndpoint,
    transcriptionModel: String(source.transcriptionModel || '').trim() || Keji.defaultSettings.transcriptionModel,
    transcriptionPrompt: Keji.normalizeTranscriptionPrompt(source.transcriptionPrompt),
    generationConcurrency: String(source.generationConcurrency ?? 2),
    temperature: String(source.temperature ?? 0.3),
  };
}

export async function testModelConnection(settings: Partial<SettingsFormState>) {
  const baseUrl = String(settings.baseUrl || '').trim().replace(/\/+$/, '');
  const parsed = parseHttpUrl(baseUrl, '请填写有效的完整 API 地址。', 'API 地址必须使用 HTTP 或 HTTPS。');

  const granted = await chrome.permissions.request({ origins: [`${parsed.origin}/*`] });
  if (!granted) throw new Error('未获得 API 域名访问权限；再次点击并在浏览器弹窗中选择“允许”即可测试连接。');

  const result = await chrome.runtime.sendMessage({
    type: 'TEST_MODEL_CONNECTION',
    settings: {
      baseUrl,
      model: String(settings.model || '').trim(),
      apiKey: String(settings.apiKey || '').trim(),
    },
  });
  if (!result?.ok) throw new Error(result?.error || '连接测试失败。');
  return result.result;
}

export async function testTranscriptionConnection(settings: Partial<SettingsFormState>) {
  const transcriptionEndpoint = String(settings.transcriptionEndpoint || '').trim();
  if (/[\r\n]/.test(transcriptionEndpoint)) {
    throw new Error('转写服务地址仅允许填写 1 个完整 URL。');
  }
  const resolvedEndpoint = Keji.resolveAsrEndpoint(transcriptionEndpoint);
  const parsed = parseHttpUrl(
    resolvedEndpoint,
    `转写服务地址格式不正确：${resolvedEndpoint}`,
    '转写服务地址必须使用 HTTP 或 HTTPS。',
  );

  const granted = await chrome.permissions.request({ origins: [`${parsed.origin}/*`] });
  if (!granted) throw new Error('未获得转写服务域名访问权限；再次点击并在浏览器弹窗中选择“允许”即可测试连接。');

  const result = await chrome.runtime.sendMessage({
    type: 'TEST_TRANSCRIPTION_CONNECTION',
    settings: {
      transcriptionEndpoint,
      transcriptionModel: String(settings.transcriptionModel || '').trim() || Keji.defaultSettings.transcriptionModel,
      transcriptionApiKey: String(settings.transcriptionApiKey || '').trim(),
      transcriptionPrompt: Keji.normalizeTranscriptionPrompt(settings.transcriptionPrompt),
    },
  });
  if (!result?.ok) throw new Error(result?.error || '语音连接测试失败。');
  return result.result;
}

export async function persistSettings(input: Partial<SettingsFormState>): Promise<KejiSettings> {
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(input.model || '').trim();
  const modelCapability: ModelCapability = Keji.normalizeCapability(
    input.modelCapability,
    (input as Record<string, unknown>).videoInputMode,
  );
  const parsed = parseHttpUrl(baseUrl, '请填写有效的完整 API 地址。', 'API 地址必须使用 HTTP 或 HTTPS。');

  const origins = [`${parsed.origin}/*`, ...BILIBILI_CDN_ORIGINS];
  const modelPresets = Array.isArray(input.modelPresets)
    ? input.modelPresets
      .filter((preset) => preset && typeof preset.id === 'string' && String(preset.model || '').trim())
      .map((preset) => {
        const presetBase = String(preset.baseUrl || '').trim().replace(/\/+$/, '');
        if (presetBase) {
          const presetUrl = parseHttpUrl(presetBase, `预设「${preset.name}」的 API 地址格式不正确。`, '预设 API 地址必须使用 HTTP 或 HTTPS。');
          origins.push(`${presetUrl.origin}/*`);
        }
        return {
          id: String(preset.id),
          name: String(preset.name || preset.model || '预设').trim(),
          baseUrl: presetBase,
          model: String(preset.model || '').trim(),
          modelCapability: Keji.normalizeCapability(preset.modelCapability),
          apiKey: String(preset.apiKey || '').trim(),
        };
      })
    : [];
  const activePresetId = modelPresets.some((preset) => preset.id === input.activePresetId)
    ? String(input.activePresetId || '')
    : '';

  const transcriptionEndpoint = String(input.transcriptionEndpoint || '').trim();
  if (/[\r\n]/.test(transcriptionEndpoint)) {
    throw new Error('转写服务地址仅允许填写 1 个完整 URL。');
  }
  if (transcriptionEndpoint) {
    const url = parseHttpUrl(
      transcriptionEndpoint,
      `转写服务地址格式不正确：${transcriptionEndpoint}`,
      '转写服务地址必须使用 HTTP 或 HTTPS。',
    );
    origins.push(`${url.origin}/*`);
  } else {
    origins.push(`${new URL(Keji.resolveAsrEndpoint(transcriptionEndpoint)).origin}/*`);
  }

  const transcriptionPrompt = Keji.normalizeTranscriptionPrompt(input.transcriptionPrompt);

  const remoteBackupUrl = String(input.remoteBackupUrl || '').trim();
  const remoteBackupUsername = String(input.remoteBackupUsername || '').trim();
  const remoteBackupPassword = String(input.remoteBackupPassword || '');
  const remoteBackupAutoSync = Boolean(input.remoteBackupAutoSync);
  if (remoteBackupAutoSync && !remoteBackupUrl) throw new Error('启用自动同步前，请先填写 WebDAV 备份地址。');
  if ((remoteBackupUsername || remoteBackupPassword) && !remoteBackupUrl) {
    throw new Error('填写 WebDAV 用户名或密码时，也需要填写 WebDAV 备份地址。');
  }
  if (remoteBackupUrl) {
    const url = parseHttpUrl(remoteBackupUrl, 'WebDAV 备份地址格式不正确。', 'WebDAV 备份地址必须使用 HTTPS；仅本机地址（127.0.0.1 / localhost）可使用 HTTP。');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !loopback) {
      throw new Error('WebDAV 备份地址必须使用 HTTPS；仅本机地址（127.0.0.1 / localhost）可使用 HTTP。');
    }
    if (url.username || url.password) throw new Error('请将 WebDAV 用户名和密码分别填写，不要嵌入 URL。');
    origins.push(`${url.origin}/*`);
  }

  const permissionRequest: chrome.permissions.Permissions = { origins: [...new Set(origins)] };
  if (modelCapability === 'video_audio') permissionRequest.permissions = ['offscreen'];
  const allowed = await chrome.permissions.request(permissionRequest);
  if (!allowed) throw new Error('未获得服务域名或音频处理权限；再次保存并在浏览器弹窗中选择“允许”即可使用（本机服务请允许 127.0.0.1 / localhost）。');

  const settings: KejiSettings = {
    baseUrl,
    model,
    modelCapability,
    modelPresets,
    activePresetId,
    apiKey: String(input.apiKey || '').trim(),
    transcriptionEndpoint,
    transcriptionModel: String(input.transcriptionModel || '').trim() || Keji.defaultSettings.transcriptionModel,
    transcriptionPrompt,
    transcriptionApiKey: String(input.transcriptionApiKey || '').trim(),
    generationConcurrency: Math.max(1, Math.min(4, Number(input.generationConcurrency) || 2)),
    remoteBackupUrl,
    remoteBackupUsername,
    remoteBackupPassword,
    remoteBackupAutoSync,
    temperature: Number(input.temperature) || 0.3,
    customPrompt: String(input.customPrompt || '').trim(),
  };
  await chrome.storage.local.set({ settings });
  await chrome.runtime.sendMessage({
    type: remoteBackupAutoSync ? 'QUEUE_REMOTE_NOTES_SYNC' : 'DISABLE_REMOTE_NOTES_SYNC',
  });
  return settings;
}
