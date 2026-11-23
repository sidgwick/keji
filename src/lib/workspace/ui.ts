import { workspace } from './state.svelte.ts';

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export function callBackground(type: string, payload: Record<string, unknown> = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

export function dismissNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  workspace.notice = { message: '', kind: 'info' };
}

export function showNotice(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  const text = String(message || '');
  workspace.notice = { message: text, kind };
  if (text && kind !== 'error') {
    noticeTimer = setTimeout(() => {
      workspace.notice = { message: '', kind: 'info' };
      noticeTimer = null;
    }, 3000);
  }
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename: string, text: string, type: string): void {
  downloadBlob(filename, new Blob([text], { type }));
}

export async function withButtonBusy(
  button: HTMLButtonElement | null | undefined,
  busyLabel: string | null,
  run: () => Promise<void>,
  fallbackError = '操作失败。'
): Promise<void> {
  const previousLabel = button?.textContent ?? null;
  if (button) {
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
  }
  try {
    await run();
  } catch (error) {
    showNotice((error as Error).message || fallbackError, 'error');
  } finally {
    if (button) {
      button.disabled = false;
      if (busyLabel && previousLabel !== null) button.textContent = previousLabel;
    }
  }
}
