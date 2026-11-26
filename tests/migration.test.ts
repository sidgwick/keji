import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const storage = new Map<string, unknown>();
Object.defineProperty(globalThis, 'chrome', {
  value: { storage: { local: {
    async get(key: string) { return { [key]: storage.get(key) }; },
    async set(values: Record<string, unknown>) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
  } } },
});

test('version 3 notes gain searchable summaries and lesson index', async () => {
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('keji-notes', 3);
    request.onupgradeneeded = () => {
      const notes = request.result.createObjectStore('notes', { keyPath: 'id' });
      notes.createIndex('createdAt', 'createdAt');
      notes.createIndex('url', 'url');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction('notes', 'readwrite');
    tx.objectStore('notes').put({ id: 'legacy', title: '旧课节',
      url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1', page: 1,
      markdown: '# 迁移正文\n![图](data:image/png;base64,AAAA)', createdAt: '2025-01-01T00:00:00Z' });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  legacy.close();
  const { listNotes, saveNote } = await import('../src/lib/background/notes-db.ts');
  assert.equal((await listNotes({ query: '迁移正文' })).notes[0]?.id, 'legacy');
  const saved = await saveNote({ title: '新版', url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1', page: 1, markdown: '更新' });
  assert.equal(saved.id, 'legacy');
  assert.equal((await listNotes()).notes.length, 1);
});
