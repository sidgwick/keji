import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getNote, importNotes, listNotes, listRecoveryNotes, restoreRecoveryNote,
  reviseNoteView, saveNote, updateGenerationNote, updateNote,
  stripIntermediateFromNotes,
} from '../src/lib/background/notes-db.ts';

const storage = new Map<string, unknown>();
Object.defineProperty(globalThis, 'chrome', {
  value: { storage: { local: {
    async get(key: string) { return { [key]: storage.get(key) }; },
    async set(values: Record<string, unknown>) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
  } } },
});

test('revision, generation checkpoint, summary and recovery preserve the right fields', async () => {
  const initial = await saveNote({
    title: '课程', url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1', page: 1,
    template: 'study', markdown: '# 原文', views: { study: '# 原文' },
    conversation: [], personalNote: '原批注', complete: true,
  });
  assert.equal((await listNotes({ query: '原文' })).notes.length, 1);
  const message = { role: 'assistant', content: '修订说明' };
  await reviseNoteView({ id: initial.id, viewKey: 'study', expectedMarkdown: '# 原文',
    markdown: '# 修订', messages: [message], requestId: 'r1' });
  await assert.rejects(() => reviseNoteView({ id: initial.id, viewKey: 'study',
    expectedMarkdown: '# 原文', markdown: '# 过期' }), /正文已改变/);
  await reviseNoteView({ id: initial.id, viewKey: 'study', expectedMarkdown: '# 修订',
    markdown: '# 修订', messages: [message], requestId: 'r1' });
  assert.equal((await getNote(initial.id)).conversation?.length, 1);
  await updateNote({ id: initial.id, personalNote: '新的批注' });
  await updateGenerationNote({ id: initial.id, targetTemplate: 'study', expectedMarkdown: '# 修订',
    note: { views: { study: '# 生成' }, generationStatus: 'completed', complete: true } });
  assert.equal((await getNote(initial.id)).personalNote, '新的批注');
  assert.equal((await listNotes({ query: '生成' })).notes.length, 1);
  assert.equal((await listNotes({ query: '原文' })).notes.length, 0);

  await importNotes([{ ...await getNote(initial.id), markdown: '# 远端', views: { study: '# 远端' },
    updatedAt: '2099-01-01T00:00:00.000Z' }]);
  const snapshots = await listRecoveryNotes();
  assert.ok(snapshots.some((item) => item.reason === 'sync'));
  await restoreRecoveryNote(snapshots.find((item) => item.reason === 'sync')!.id);
  assert.equal((await getNote(initial.id)).views?.study, '# 生成');
  const incomplete = await updateNote({ id: initial.id, transcript: '人工整理', modelMarkdown: '部分生成',
    complete: false, generationStatus: 'failed', generationProgress: { completedChunks: 1, totalChunks: 4 } });
  await stripIntermediateFromNotes([incomplete]);
  const kept = await getNote(initial.id);
  assert.equal(kept.transcript, '人工整理');
  assert.equal(kept.complete, false);
  assert.equal(kept.generationProgress?.completedChunks, 1);
  assert.equal(kept.modelMarkdown, '部分生成');
});
