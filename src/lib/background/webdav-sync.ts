import { Keji, type KejiSettings } from "../keji.ts";
import { deletedNoteTombstones, getAllNotes, importNotes } from "./notes-db.ts";
import { getStored } from "../storage.ts";
import { getCachedTranscription, listManualTranscriptions, putCachedTranscription } from "../lesson-cache.ts";

export const REMOTE_NOTES_SYNC_ALARM = "keji-remote-notes-auto-sync";
const MAX_BACKUP_BYTES = 200 * 1024 * 1024;
const utf8Encoder = new TextEncoder();

function createSerialQueue() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  };
}

const queueRemoteBackup = createSerialQueue();
const queueRemoteSyncSchedule = createSerialQueue();

async function syncStorage() {
  const values = await chrome.storage.local.get(["settings", "remoteBackupMutationVersion", "remoteBackupSyncState"]);
  return {
    settings: (values.settings || {}) as Partial<KejiSettings>,
    remoteBackupMutationVersion: Number(values.remoteBackupMutationVersion) || 0,
    remoteBackupSyncState: (values.remoteBackupSyncState || { status: "idle" }) as { status: string; lastSyncedAt?: number; noteCount?: number }
  };
}

async function sha256Hex(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const contentLength = Number(response.headers.get("content-length")) || 0;
  if (contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error("远程笔记备份超过 200 MiB，已停止下载。");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("浏览器无法读取远程笔记备份响应。");
  const chunks: BlobPart[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("远程笔记备份超过 200 MiB，已停止下载且未导入数据。");
    }
    chunks.push(value.slice());
  }
  return new Blob(chunks, { type: "application/json" }).arrayBuffer();
}

function parseBackupBytes(bytes: ArrayBuffer, invalidJsonMsg: string, invalidFormatMsg: string) {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(invalidJsonMsg); }
  let backup: { format?: unknown; notes?: unknown; deletedNotes?: unknown; manualTranscripts?: unknown };
  try { backup = JSON.parse(text); } catch { throw new Error(invalidJsonMsg); }
  if (backup?.format !== "keji-notes-backup-v1" || !Array.isArray(backup.notes)) {
    throw new Error(invalidFormatMsg);
  }
  return backup as { format: string; notes: any[]; deletedNotes?: any[]; manualTranscripts?: any[] };
}

export async function createLocalNotesBackup(): Promise<string> {
  const notes = await getAllNotes();
  const body = JSON.stringify({
    format: "keji-notes-backup-v1", exportedAt: new Date().toISOString(),
    noteCount: notes.length, deletedNotes: await deletedNoteTombstones(),
    manualTranscripts: await listManualTranscriptions(), notes
  });
  if (utf8Encoder.encode(body).byteLength > MAX_BACKUP_BYTES) throw new Error("笔记备份超过 200 MiB，无法导出。");
  return body;
}

export async function importLocalNotesBackup(bytes: ArrayBuffer) {
  if (bytes.byteLength > MAX_BACKUP_BYTES) throw new Error("笔记备份超过 200 MiB，无法导入。");
  const backup = parseBackupBytes(bytes, "备份不是有效的 UTF-8 JSON 文件。", "文件不是课记笔记库备份。");
  return importBackup(backup);
}

async function importBackup(backup: { notes: any[]; deletedNotes?: any[]; manualTranscripts?: any[] }) {
  const result = await importNotes(backup.notes, backup.deletedNotes);
  for (const record of Array.isArray(backup.manualTranscripts) ? backup.manualTranscripts : []) {
    if (typeof record.lessonKey !== 'string' || typeof record.text !== 'string') continue;
    const local = await getCachedTranscription(record.lessonKey);
    if (local && Number(local.updatedAt) >= Number(record.updatedAt)) continue;
    await putCachedTranscription(record.lessonKey, { ...record, manual: true });
  }
  return result;
}

function remoteNotesBackup(action: "upload" | "download" | "sync"): Promise<any> {
  return queueRemoteBackup(() => action === "sync" ? syncRemoteNotesBackup() : remoteNotesBackupTask(action));
}

async function syncRemoteNotesBackup() {
  let merged = { added: 0, updated: 0, removed: 0, retained: 0 };
  try {
    merged = await remoteNotesBackupTask("download");
  } catch (error) {
    if (!/HTTP 404\b/.test((error as Error)?.message || "")) throw error;
  }
  const uploaded = await remoteNotesBackupTask("upload");
  return { ...uploaded, action: "sync", merged };
}

async function remoteNotesBackupTask(action: "upload" | "download"): Promise<any> {
  if (action !== "upload" && action !== "download") throw new Error("远程备份操作无效。");
  const stored = await getStored<Partial<KejiSettings>>("settings", {});
  const settings: KejiSettings = { ...Keji.defaultSettings, ...stored };
  let url: URL;
  try { url = new URL(String(settings.remoteBackupUrl || "").trim()); } catch { throw new Error("请先在设置中填写远程备份文件 URL。"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!/^https?:$/.test(url.protocol) || (url.protocol !== "https:" && !loopback) || url.username || url.password) {
    throw new Error("远程备份地址必须是 HTTPS URL（本机回环地址可用 HTTP），并将凭据填在单独字段中。");
  }
  if (!await chrome.permissions.contains({ origins: [`${url.origin}/*`] })) {
    throw new Error("课记还没有远程备份地址的访问权限；请在设置中保存地址并允许连接。");
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (settings.remoteBackupUsername || settings.remoteBackupPassword) {
    const credentials = utf8Encoder.encode(`${settings.remoteBackupUsername || ""}:${settings.remoteBackupPassword || ""}`);
    let binary = "";
    for (let offset = 0; offset < credentials.length; offset += 0x8000) {
      binary += String.fromCharCode(...credentials.subarray(offset, offset + 0x8000));
    }
    headers.Authorization = `Basic ${btoa(binary)}`;
  }

  const revisionKey = `remoteBackupRevision_${await sha256Hex(utf8Encoder.encode(url.href))}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    if (action === "upload") {
      const body = await createLocalNotesBackup();
      const noteCount = JSON.parse(body).noteCount as number;
      const bodyBytes = utf8Encoder.encode(body);
      if (bodyBytes.byteLength > MAX_BACKUP_BYTES) {
        throw new Error("远程笔记备份超过 200 MiB，未上传。请先移除较大的截图或拆分备份。");
      }
      const knownRevision = await getStored<{ digest?: string } | null>(revisionKey, null);
      const current = await fetch(url, { headers, signal: controller.signal });
      let remoteExists = false;
      let writeCondition: Record<string, string> = {};
      if (current.status === 404) {
        if (knownRevision?.digest) {
          throw new Error("远程备份文件已被删除；为避免覆盖其他设备的更改，请先确认远程文件状态。");
        }
      } else if (!current.ok) {
        const detail = (await current.text().catch(() => "")).slice(0, 300);
        throw new Error(`检查远程笔记备份版本失败：HTTP ${current.status}${detail ? ` · ${detail}` : ""}`);
      } else {
        remoteExists = true;
        const currentBytes = await readBoundedResponseBytes(current, MAX_BACKUP_BYTES);
        const currentDigest = await sha256Hex(currentBytes);
        parseBackupBytes(
          currentBytes,
          "远程文件不是有效的 UTF-8 JSON 笔记备份；为避免覆盖，已停止上传。",
          "远程文件不是课记笔记库备份；为避免覆盖，已停止上传。"
        );
        if (!knownRevision?.digest) {
          throw new Error("远程备份已存在，但本机尚未下载过它。请先下载合并，再上传，以免覆盖远程笔记。");
        }
        if (knownRevision.digest !== currentDigest) {
          throw new Error("远程备份已被其他设备修改。请先下载合并远程内容，再上传。");
        }
        const currentEtag = current.headers.get("etag") || "";
        const currentLastModified = current.headers.get("last-modified") || "";
        if (!currentEtag && !currentLastModified) {
          throw new Error("远程服务器未提供 ETag 或 Last-Modified，无法安全检查并发修改；已停止覆盖。");
        }
        writeCondition = currentEtag ? { "If-Match": currentEtag } : { "If-Unmodified-Since": currentLastModified };
      }
      const response = await fetch(url, {
        method: "PUT",
        headers: {
          ...headers,
          ...(remoteExists ? writeCondition : { "If-None-Match": "*" }),
          "Content-Type": "application/json;charset=utf-8"
        },
        body,
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        if (response.status === 412) throw new Error("上传期间远程备份又发生变化；请先下载合并后重试。");
        throw new Error(`上传远程笔记备份失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
      }
      await chrome.storage.local.set({
        [revisionKey]: { digest: await sha256Hex(bodyBytes), etag: response.headers.get("etag") || "", updatedAt: Date.now() }
      });
      return { action, noteCount };
    }

    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`下载远程笔记备份失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
    }
    const bytes = await readBoundedResponseBytes(response, MAX_BACKUP_BYTES);
    const backup = parseBackupBytes(bytes, "远程笔记备份不是有效的 UTF-8 JSON 文件。", "远程文件不是课记笔记库备份。");
    const imported = await importBackup(backup);
    await chrome.storage.local.set({
      [revisionKey]: {
        digest: await sha256Hex(bytes),
        etag: response.headers.get("etag") || "",
        lastModified: response.headers.get("last-modified") || "",
        updatedAt: Date.now()
      }
    });
    return { action, ...imported };
  } catch (error) {
    if ((error as Error)?.name === "AbortError") throw new Error("远程备份请求超时（60 秒）。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function queueRemoteNotesAutoSync() {
  return queueRemoteSyncSchedule(async () => {
    try {
      const { settings, remoteBackupMutationVersion } = await syncStorage();
      if (!settings.remoteBackupAutoSync || !String(settings.remoteBackupUrl || "").trim()) return;
      const version = Math.max(Number(remoteBackupMutationVersion) || 0, Date.now()) + 1;
      await chrome.storage.local.set({
        remoteBackupMutationVersion: version,
        remoteBackupSyncState: { status: "pending", updatedAt: Date.now() }
      });
      await chrome.alarms.create(REMOTE_NOTES_SYNC_ALARM, { delayInMinutes: 2 });
    } catch (error) {
      await chrome.storage.local.set({
        remoteBackupSyncState: { status: "error", updatedAt: Date.now(), error: (error as Error).message || "无法安排自动同步。" }
      }).catch(() => {});
    }
  });
}

export async function disableRemoteNotesAutoSync(): Promise<void> {
  await Promise.resolve(chrome.alarms.clear(REMOTE_NOTES_SYNC_ALARM)).catch(() => {});
  await chrome.storage.local.set({ remoteBackupSyncState: { status: "disabled", updatedAt: Date.now() } });
}

export async function restoreAutoRemoteNotesSync(): Promise<void> {
  const { settings, remoteBackupSyncState } = await syncStorage();
  if (!settings.remoteBackupAutoSync || !String(settings.remoteBackupUrl || "").trim()) return;
  if (["pending", "syncing"].includes(remoteBackupSyncState.status)) {
    await chrome.alarms.create(REMOTE_NOTES_SYNC_ALARM, { delayInMinutes: 1 });
  }
}

export async function runAutoRemoteNotesSync(): Promise<void> {
  const { settings, remoteBackupMutationVersion } = await syncStorage();
  if (!settings.remoteBackupAutoSync || !String(settings.remoteBackupUrl || "").trim()) return;
  const startingVersion = Number(remoteBackupMutationVersion) || 0;
  await chrome.storage.local.set({ remoteBackupSyncState: { status: "syncing", startedAt: Date.now() } });
  try {
    const result = await remoteNotesBackup("sync");
    const latest = await syncStorage();
    if (!latest.settings?.remoteBackupAutoSync) {
      await chrome.storage.local.set({ remoteBackupSyncState: { status: "disabled", updatedAt: Date.now() } });
      return;
    }
    if ((Number(latest.remoteBackupMutationVersion) || 0) !== startingVersion) {
      await chrome.storage.local.set({ remoteBackupSyncState: { status: "pending", updatedAt: Date.now() } });
      await chrome.alarms.create(REMOTE_NOTES_SYNC_ALARM, { delayInMinutes: 2 });
      return;
    }
    await chrome.storage.local.set({
      remoteBackupSyncState: { status: "synced", lastSyncedAt: Date.now(), noteCount: result.noteCount || 0 }
    });
  } catch (error) {
    const latest = await syncStorage();
    await chrome.storage.local.set({
      remoteBackupSyncState: !latest.settings?.remoteBackupAutoSync
        ? { status: "disabled", updatedAt: Date.now() }
        : { status: "error", updatedAt: Date.now(), error: (error as Error).message || "自动同步失败。" }
    });
  }
}

export async function runRemoteNotesBackupWithSyncState(action: "upload" | "download" | "sync") {
  const { remoteBackupMutationVersion: before } = await syncStorage();
  const result = await remoteNotesBackup(action);
  if (action === "sync") {
    const latest = await syncStorage();
    if (latest.settings?.remoteBackupAutoSync) {
      if ((Number(latest.remoteBackupMutationVersion) || 0) === (Number(before) || 0)) {
        await chrome.storage.local.set({
          remoteBackupSyncState: { status: "synced", lastSyncedAt: Date.now(), noteCount: result.noteCount || 0 }
        });
      } else {
        await chrome.storage.local.set({ remoteBackupSyncState: { status: "pending", updatedAt: Date.now() } });
        await chrome.alarms.create(REMOTE_NOTES_SYNC_ALARM, { delayInMinutes: 2 });
      }
    }
  }
  return result;
}

export async function getRemoteNotesSyncState() {
  const { settings, remoteBackupSyncState } = await syncStorage();
  return { enabled: Boolean(settings.remoteBackupAutoSync), state: remoteBackupSyncState };
}
