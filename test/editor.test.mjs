import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, tui, agent } from './host.mjs';
const { DocumentBuffer, graphemes } = await load('buffer');
const { DocumentSession, ConflictError } = await load('document');
const { DocumentPane } = await load('pane');
const queue = agent.withFileMutationQueue;
const theme = { fg: (_color, text) => text, bg: (_color, text) => `\x1b[7m${text}\x1b[27m` };
const plain = s => tui.stripTerminalSequences(s);
async function fixture(fn, text = '# Plan\n一段文字\n') {
  const dir = await mkdtemp(join(tmpdir(), 'pi-artifact-'));
  const path = join(dir, 'plan.md');
  await writeFile(path, text, { mode: 0o600 });
  try { await fn({ dir, path, document: await DocumentSession.open(path) }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('grapheme cursor does not split CJK, emoji, combining marks', () => {
  const b = new DocumentBuffer('中👨‍👩‍👧‍👦é');
  assert.equal(graphemes(b.text).length, 3);
  b.move(0, 2); b.backspace(); assert.equal(b.text, '中é'); assert.equal(b.col, 1);
  b.deleteChar(); assert.equal(b.text, '中'); b.undo(); assert.equal(b.text, '中é');
  b.redo(); assert.equal(b.text, '中');
});
test('multiline insertion, line joining, undo and redo', () => {
  const b = new DocumentBuffer('abc\ndef'); b.move(0, 1); b.insert('中\r\n文');
  assert.equal(b.text, 'a中\n文bc\ndef'); assert.deepEqual([b.row, b.col], [1, 1]);
  b.home(); b.backspace(); assert.equal(b.text, 'a中文bc\ndef');
  b.undo(); assert.equal(b.text, 'a中\n文bc\ndef'); b.undo(); assert.equal(b.text, 'abc\ndef');
  b.redo(); assert.equal(b.text, 'a中\n文bc\ndef');
});
test('linewise yank, delete and paste preserve empty documents', () => {
  const b = new DocumentBuffer('one\ntwo'); b.yank(); b.move(1, 0); b.paste();
  assert.equal(b.text, 'one\ntwo\none'); b.yank(true); assert.equal(b.text, 'one\ntwo');
  b.yank(true); b.yank(true); assert.equal(b.text, ''); assert.equal(b.row, 0);
});
test('visual selection is inclusive and can yank or delete across lines', () => {
  const b = new DocumentBuffer('abc\n中文'); b.move(0, 1); b.toggleVisual(); b.move(1, 0);
  assert.equal(b.text.slice(...b.selection()), 'bc\n中文');
  b.yank(true); assert.equal(b.text, 'a'); b.paste(); assert.equal(b.text, 'abc\n中文');
});
test('open lines and replacement clamp cursor and reset history', () => {
  const b = new DocumentBuffer('a'); b.openLine(); assert.equal(b.mode, 'insert'); b.insert('b');
  b.openLine(true); b.insert('c'); assert.equal(b.text, 'a\nc\nb');
  b.replace('x'); b.undo(); assert.equal(b.text, 'x'); assert.deepEqual([b.row, b.col], [0, 1]);
});
test('save is mode-preserving and keeps CRLF without gratuitous edits', async () => fixture(async ({ path, document }) => {
  assert.equal(document.dirty, false); document.buffer.end(); document.buffer.insert('!');
  await document.save(queue); assert.equal(await readFile(path, 'utf8'), 'one!\r\ntwo\r\n');
  assert.equal(document.dirty, false); assert.equal((await stat(path)).mode & 0o777, 0o600);
}, 'one\r\ntwo\r\n'));
test('clean document refresh follows disk, dirty draft never overwritten', async () => fixture(async ({ path, document }) => {
  await writeFile(path, 'remote'); await document.refresh(); assert.equal(document.buffer.text, 'remote');
  document.buffer.insert('local'); await writeFile(path, 'new remote'); await document.refresh();
  assert.equal(document.conflict, true); assert.equal(document.buffer.text, 'localremote');
  await assert.rejects(document.save(queue), ConflictError); assert.equal(await readFile(path, 'utf8'), 'new remote');
}));
test('deleted file cannot be silently recreated and conflict copy is exclusive', async () => fixture(async ({ path, dir, document }) => {
  document.buffer.insert('draft'); await rm(path);
  await assert.rejects(document.save(queue), ConflictError);
  const copy = join(dir, 'copy.md'); await document.saveCopy(copy);
  assert.equal(await readFile(copy, 'utf8'), document.buffer.text);
  await assert.rejects(document.saveCopy(copy), /EEXIST/);
}));
test('simultaneous saves serialize their whole read/modify/write operation', async () => fixture(async ({ path, dir, document }) => {
  const other = await DocumentSession.open(path); document.buffer.insert('first'); other.buffer.insert('second');
  const results = await Promise.allSettled([document.save(queue), other.save(queue)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.deepEqual(await readdir(dir), ['plan.md']);
}));
test('symlink open uses its canonical file and preserves the link', async () => fixture(async ({ path, dir }) => {
  const link = join(dir, 'link.md'); await symlink(path, link);
  const doc = await DocumentSession.open(link); doc.buffer.insert('safe'); await doc.save(queue);
  assert.equal(await readFile(link, 'utf8'), await readFile(path, 'utf8'));
}));
test('rejects unsupported, binary and oversized documents', async () => fixture(async ({ dir }) => {
  const path = join(dir, 'bad.md'); await writeFile(path, 'a\0b'); await assert.rejects(DocumentSession.open(path));
  await writeFile(path, 'a'.repeat(1024 * 1024 + 1)); await assert.rejects(DocumentSession.open(path));
  await assert.rejects(DocumentSession.open(dir));
}));
test('pane implements normal/insert, dd/yy/p, visual yank, undo/redo, and save', async () => fixture(async ({ document }) => {
  let saved = 0;
  const pane = new DocumentPane(document, () => theme, () => 24, () => {}, () => saved++, () => {});
  pane.handleInput('i'); pane.handleInput('中文👩‍💻'); pane.handleInput('\x1b');
  assert.equal(document.buffer.mode, 'normal'); assert.ok(document.buffer.text.startsWith('中文👩‍💻'));
  pane.handleInput('u'); pane.handleInput('\x12'); assert.ok(document.buffer.text.startsWith('中文👩‍💻'));
  pane.handleInput('y'); pane.handleInput('y'); pane.handleInput('p'); assert.equal(document.buffer.row, 1);
  pane.handleInput('d'); pane.handleInput('d'); assert.equal(document.buffer.row, 1);
  pane.handleInput('\x13'); assert.equal(saved, 1);
}));
test('bracketed paste is literal even in normal mode and can span input chunks', async () => fixture(async ({ document }) => {
  const pane = new DocumentPane(document, () => theme, () => 24, () => {}, () => {}, () => {});
  pane.handleInput('\x1b[200~'); pane.handleInput('dd\n中文'); pane.handleInput('\x1b[201~');
  assert.ok(document.buffer.text.startsWith('dd\n中文# Plan'));
  pane.handleInput('i'); pane.handleInput('\x1b[97u'); assert.ok(document.buffer.text.includes('中文a# Plan'));
}));
test('pane renders full height, bounded columns and exactly one IME cursor', async () => fixture(async ({ document }) => {
  document.buffer.replace('中'.repeat(40) + '\n👩‍💻é\ttext\n' + Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n'));
  let height = 24;
  const pane = new DocumentPane(document, () => theme, () => height, () => {}, () => {}, () => {});
  pane.focused = true;
  for (const width of [8, 20, 40, 80, 100]) {
    const lines = pane.render(width); assert.equal(lines.length, height);
    assert.ok(lines.every(line => tui.visibleWidth(line) <= width), `overflow width=${width}`);
    assert.equal(lines.join('').split(tui.CURSOR_MARKER).length - 1, 1);
  }
  pane.handleInput('G'); height = 12;
  const lines = pane.render(35); assert.equal(lines.length, 12); assert.ok(lines.some(line => plain(line).includes('line 119')));
  pane.focused = false; assert.ok(!pane.render(35).join('').includes(tui.CURSOR_MARKER));
}));
test('mouse wheel scrolls plan without moving document cursor; click focuses and positions', async () => fixture(async ({ document }) => {
  document.buffer.replace(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));
  let focused = 0;
  const pane = new DocumentPane(document, () => theme, () => 15, () => {}, () => {}, () => focused++);
  pane.render(60); pane.handleMouse({ type: 'wheel', wheelDelta: 10 });
  assert.equal(document.buffer.row, 0); assert.ok(pane.render(60).some(line => plain(line).includes('line 10')));
  pane.handleMouse({ type: 'press', button: 'left', x: 5, y: 2 }); assert.equal(focused, 1); assert.equal(document.buffer.row, 11);
}));
