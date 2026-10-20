import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './host.mjs';
const { ArtifactStore, exactEdits, revisionOf } = await load('store');
async function fixture(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-artifact-store-'));
  try { await fn(new ArtifactStore(cwd), cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}
test('create has stable identity and immutable content-addressed revisions', () => fixture(async (store) => {
  const a = await store.create('# First', 'plan\nno injected frontmatter');
  assert.match(a.record.id, /^art_/); assert.match(a.content, /title: plan no injected frontmatter/);
  const b = await store.update(a.record.id, text => text.replace('# First', '# Second'), a.revision);
  assert.equal(b.record.id, a.record.id); assert.notEqual(b.revision, a.revision);
  assert.equal(await store.revision(a.record.id, a.revision), a.content);
  assert.equal(await store.revision(a.record.id, b.revision), b.content);
  await assert.rejects(store.update(a.record.id, x => x, a.revision), /Stale/);
}));
test('exact edits use original text, reject empty, overlapping, ambiguous and missing edits', () => {
  assert.equal(exactEdits('abc def', [{ oldText: 'abc', newText: 'def' }, { oldText: 'def', newText: 'done' }]), 'def done');
  for (const [text, edits] of [['aaa', [{ oldText: 'aa', newText: '' }]], ['abc', [{ oldText: '', newText: '' }]], ['abc', [{ oldText: 'ab', newText: '' }, { oldText: 'bc', newText: '' }]], ['abc', [{ oldText: 'z', newText: '' }]], ['abc', []]]) assert.throws(() => exactEdits(text, edits));
});
test('legacy content layouts load without deleting files or trusting old approval', () => fixture(async (store, cwd) => {
  await mkdir(join(store.root, 'content/plan'), { recursive: true });
  const path = '.pi/artifacts/content/plan/old.md';
  await writeFile(join(cwd, path), '# legacy');
  await writeFile(store.indexPath, JSON.stringify({ artifacts: [{ id: 'art_123', path, createdAt: 'old', status: 'approved', type: 'plan' }] }));
  const artifact = await store.read('art_123');
  assert.equal(artifact.content, '# legacy'); assert.equal(artifact.record.status, 'draft');
  assert.equal((await store.resolve(path)).record.id, 'art_123');
  assert.equal(await readFile(join(cwd, path), 'utf8'), '# legacy');
}));
test('external changes revoke approval even with same byte length or mtime', () => fixture(async (store, cwd) => {
  const a = await store.create('first');
  await store.review(a.record.id, a.revision, 'approved', 'fine', [{ line: 6, comment: 'yes' }]);
  assert.equal((await store.read(a.record.id)).record.status, 'approved');
  await writeFile(join(cwd, a.record.path), a.content.replace('first', 'other'));
  const changed = await store.read(a.record.id); assert.equal(changed.record.status, 'draft');
  await assert.rejects(store.review(a.record.id, a.revision, 'approved'), /changed during review/);
  const review = JSON.parse(await readFile(join(store.root, 'reviews', `${a.record.id}.review.json`), 'utf8'));
  assert.equal(review.revision, a.revision); assert.equal(review.lineComments[0].line, 6);
}));
test('concurrent index updates are serialized and failed edits do not corrupt index', () => fixture(async store => {
  const values = await Promise.all(Array.from({ length: 12 }, (_, i) => store.create(`item ${i}`)));
  assert.equal((await store.list()).length, 12);
  await assert.rejects(store.update(values[0].record.id, () => { throw Error('bad'); }), /bad/);
  assert.equal((await store.read(values[0].record.id)).content, values[0].content);
  await store.abandon(values[0].record.id);
  await assert.rejects(store.update(values[0].record.id, x => x), /abandoned/);
}));
test('invalid index, traversal, binary and revision corruption fail closed', () => fixture(async (store, cwd) => {
  const a = await store.create('safe');
  await assert.rejects(store.create('\0'), /text/);
  await assert.rejects(store.revision('../bad', a.revision), /Invalid/);
  await writeFile(join(store.root, 'revisions', a.record.id, `${a.revision}.md`), 'corrupt');
  await assert.rejects(store.revision(a.record.id, a.revision), /Corrupt/);
  await writeFile(store.indexPath, '{bad');
  await assert.rejects(store.list()); assert.equal(await readFile(store.indexPath, 'utf8'), '{bad');
  await writeFile(store.indexPath, JSON.stringify({ artifacts: [{ ...a.record, path: '../outside.md' }] }));
  await assert.rejects(store.read(a.record.id), /escapes/);
  const outside = join(cwd, 'outside.md'); await writeFile(outside, 'outside');
  const linked = join(store.root, 'link.md'); await symlink(outside, linked);
  await writeFile(store.indexPath, JSON.stringify({ artifacts: [{ ...a.record, path: '.pi/artifacts/link.md' }] }));
  await assert.rejects(store.read(a.record.id), /symlink escapes/);
}));
