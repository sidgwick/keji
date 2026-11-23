import { Keji, type ApiProtocol, type KejiSettings, type ModelCapability } from './keji.ts';
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
    apiProtocol: Keji.normalizeProtocol(source.apiProtocol, baseUrl),
    modelCapability: Keji.normalizeCapability(source.modelCapability, source.videoInputMode),
    transcriptionConcurrency: String(source.transcriptionConcurrency ?? 0),
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
      apiProtocol: Keji.normalizeProtocol(settings.apiProtocol, baseUrl),
      baseUrl,
      model: String(settings.model || '').trim(),
      apiKey: String(settings.apiKey || '').trim(),
    },
  });
  if (!result?.ok) throw new Error(result?.error || '连接测试失败。');
  return result.result;
}

export async function persistSettings(input: Partial<SettingsFormState>): Promise<KejiSettings> {
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(input.model || '').trim();
  const apiProtocol: ApiProtocol = Keji.normalizeProtocol(input.apiProtocol, baseUrl);
  const modelCapability: ModelCapability = Keji.normalizeCapability(
    input.modelCapability,
    (input as Record<string, unknown>).videoInputMode,
  );
  const parsed = parseHttpUrl(baseUrl, '请填写有效的完整 API 地址。', 'API 地址必须使用 HTTP 或 HTTPS。');

  const origins = [`${parsed.origin}/*`, ...BILIBILI_CDN_ORIGINS];

  const transcriptionEndpoint = String(input.transcriptionEndpoint || '').trim();
  const endpoints = transcriptionEndpoint.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (endpoints.length > 4) throw new Error('最多配置 4 个语音识别 API 地址。');
  for (const endpoint of endpoints) {
    const url = parseHttpUrl(
      endpoint,
      `语音识别 API 地址格式不正确：${endpoint}`,
      '语音识别 API 地址必须使用 HTTP 或 HTTPS。',
    );
    origins.push(`${url.origin}/*`);
  }

  const remoteBackupUrl = String(input.remoteBackupUrl || '').trim();
  const remoteBackupUsername = String(input.remoteBackupUsername || '').trim();
  const remoteBackupPassword = String(input.remoteBackupPassword || '');
  const remoteBackupAutoSync = Boolean(input.remoteBackupAutoSync);
  if (remoteBackupAutoSync && !remoteBackupUrl) throw new Error('启用自动同步前，请先填写远程备份端点 URL。');
  if ((remoteBackupUsername || remoteBackupPassword) && !remoteBackupUrl) {
    throw new Error('填写 WebDAV 用户名或密码时，也需要填写远程备份端点 URL。');
  }
  if (remoteBackupUrl) {
    const url = parseHttpUrl(remoteBackupUrl, '远程备份端点 URL 格式不正确。', '远程同步地址必须使用 HTTPS；仅本机回环地址可使用 HTTP。');
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !loopback) {
      throw new Error('远程同步地址必须使用 HTTPS；仅本机回环地址可使用 HTTP。');
    }
    if (url.username || url.password) throw new Error('请将 WebDAV 用户名和密码分别填写，不要嵌入 URL。');
    origins.push(`${url.origin}/*`);
  }

  const permissionRequest: chrome.permissions.Permissions = { origins: [...new Set(origins)] };
  if (modelCapability === 'video_audio') permissionRequest.permissions = ['offscreen'];
  const allowed = await chrome.permissions.request(permissionRequest);
  if (!allowed) throw new Error('未获得服务域名或音频处理权限；再次保存并在浏览器弹窗中选择“允许”即可使用（本机服务请允许 127.0.0.1 / localhost）。');

  const settings: KejiSettings = {
    apiProtocol,
    baseUrl,
    model,
    modelCapability,
    apiKey: String(input.apiKey || '').trim(),
    transcriptionEndpoint,
    transcriptionModel: String(input.transcriptionModel || '').trim() || 'whisper-1',
    transcriptionLanguage: String(input.transcriptionLanguage || '').trim().toLowerCase(),
    transcriptionPrompt: String(input.transcriptionPrompt || '').trim(),
    transcriptionApiKey: String(input.transcriptionApiKey || '').trim(),
    transcriptionConcurrency: Number(input.transcriptionConcurrency) || 0,
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
