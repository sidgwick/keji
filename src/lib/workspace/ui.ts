import { workspace } from './state.svelte.ts';

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let noticeActionCallback: (() => void) | null = null;

export function callBackground(type: string, payload: Record<string, unknown> = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

export function dismissNotice(): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  noticeActionCallback = null;
  workspace.notice = { message: '', kind: 'info', actionLabel: '' };
}

export function triggerNoticeAction(): void {
  const fn = noticeActionCallback;
  dismissNotice();
  fn?.();
}

export function showNotice(
  message: string,
  kind: 'info' | 'success' | 'error' = 'info',
  options: { actionLabel?: string; onAction?: () => void; durationMs?: number } = {},
): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = null;
  noticeActionCallback = options.onAction || null;
  const text = String(message || '');
  workspace.notice = { message: text, kind, actionLabel: options.actionLabel || '' };
  const durationMs = options.durationMs ?? (kind !== 'error' ? 3600 : 0);
  if (text && durationMs > 0) {
    noticeTimer = setTimeout(() => {
      workspace.notice = { message: '', kind: 'info', actionLabel: '' };
      noticeTimer = null;
      noticeActionCallback = null;
    }, durationMs);
  }
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
