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
  pane.handleInput('\x13'); assert.equal(saved, 0, 'Ctrl+S is no longer bound');
  for (const key of ':w\r') pane.handleInput(key); assert.equal(saved, 1);
}));
const at = b => [b.row, b.col];
test('w/e/b split keyword, punctuation, CJK and emoji runs across lines', () => {
  const b = new DocumentBuffer('foo.bar  中文abc 👩‍💻👩‍💻\n\n  baz');
  const w = () => { b.word('w'); return at(b); };
  assert.deepEqual([w(), w(), w(), w(), w(), w(), w()], [[0, 3], [0, 4], [0, 9], [0, 11], [0, 15], [1, 0], [2, 2]]);
  assert.deepEqual(w(), [2, 4], 'w on the last word stops on its last character');
  const back = []; for (let i = 0; i < 7; i++) { b.word('b'); back.push(at(b)); }
  assert.deepEqual(back, [[2, 2], [1, 0], [0, 15], [0, 11], [0, 9], [0, 4], [0, 3]]);
  b.row = 0; b.col = 0; const ends = []; for (let i = 0; i < 6; i++) { b.word('e'); ends.push(at(b)); }
  assert.deepEqual(ends, [[0, 2], [0, 3], [0, 6], [0, 10], [0, 13], [0, 16]]);
  b.word('e'); assert.deepEqual(at(b), [2, 4], 'e skips blank and empty lines');
  b.word('b'); b.word('b'); assert.deepEqual(at(b), [1, 0]);
  b.row = 0; b.col = 0; b.word('b'); assert.deepEqual(at(b), [0, 0]);
  assert.equal(b.text, 'foo.bar  中文abc 👩‍💻👩‍💻\n\n  baz');
});
test('W/E/B only split on whitespace', () => {
  const b = new DocumentBuffer('a.b,c 中文!x\n  y');
  b.word('w', true); assert.deepEqual(at(b), [0, 6]); b.word('w', true); assert.deepEqual(at(b), [1, 2]);
  b.word('b', true); assert.deepEqual(at(b), [0, 6]); b.word('e', true); assert.deepEqual(at(b), [0, 9]);
  b.row = 0; b.col = 0; b.word('e', true); assert.deepEqual(at(b), [0, 4]);
});
test('literal search is case-sensitive, CJK aware, wraps, and respects graphemes', () => {
  const b = new DocumentBuffer('Plan plan\n計畫計畫\nplan');
  assert.deepEqual(b.search('plan'), { found: true, wrapped: false }); assert.deepEqual(at(b), [0, 5]);
  b.search('plan'); assert.deepEqual(at(b), [2, 0]);
  assert.deepEqual(b.search('plan'), { found: true, wrapped: true }); assert.deepEqual(at(b), [0, 5]);
  assert.deepEqual(b.search('plan', false), { found: true, wrapped: true }); assert.deepEqual(at(b), [2, 0]);
  b.search('計畫', false); assert.deepEqual(at(b), [1, 2]);
  assert.deepEqual(b.search('plan\n計畫'), { found: false, wrapped: false });
  assert.deepEqual(b.search('Missing'), { found: false, wrapped: false }); assert.deepEqual(at(b), [1, 2]);
  const d = new DocumentBuffer('cafe\u0301 e'); d.col = 0;
  d.search('e'); assert.deepEqual(at(d), [0, 5], 'never stops inside a combining sequence');
});
test('pane :w/:wq save and hide only after success; unknown commands are harmless', async () => fixture(async ({ document }) => {
  let ok = false, saved = 0, hidden = 0;
  const pane = new DocumentPane(document, () => theme, () => 24, () => {}, async () => { saved++; return ok; }, () => {}, () => hidden++);
  const type = text => { for (const key of text) pane.handleInput(key); };
  const before = document.buffer.text;
  type(':wq\r'); await new Promise(r => setImmediate(r)); assert.deepEqual([saved, hidden], [1, 0], 'failed save keeps pane');
  ok = true; type(':wq\r'); await new Promise(r => setImmediate(r)); assert.deepEqual([saved, hidden], [2, 1]);
  type(':q!\r'); assert.equal(saved, 2); assert.ok(plain(pane.render(60).join('\n')).includes('Not an editor command: q!'));
  type(':wx'); pane.handleInput('\x7f'); pane.handleInput('\x7f'); pane.handleInput('\x7f'); pane.handleInput('\x7f');
  type(':w'); pane.handleInput('\x1b'); type(':w'); assert.equal(pane.interrupt(), true); pane.handleInput('\r');
  assert.equal(saved, 2); assert.equal(document.buffer.text, before); assert.equal(document.dirty, false);
  assert.equal(document.buffer.mode, 'normal');
}));
test('pane / search, n/N, cancel, and command line owns the IME cursor', async () => fixture(async ({ document }) => {
  document.buffer.replace('一段文字\n第二段文字\nend'); const dirty = document.dirty;
  const pane = new DocumentPane(document, () => theme, () => 24, () => {}, () => true, () => {});
  pane.focused = true;
  pane.handleInput('/'); pane.handleInput('\x1b[200~文字\x1b[201~');
  const lines = pane.render(60); assert.equal(lines.join('').split(tui.CURSOR_MARKER).length - 1, 1);
  assert.ok(lines.find(line => line.includes(tui.CURSOR_MARKER)).includes('/文字'));
  pane.handleInput('\r'); assert.deepEqual(at(document.buffer), [0, 2]);
  pane.handleInput('n'); assert.deepEqual(at(document.buffer), [1, 3]);
  pane.handleInput('n'); assert.deepEqual(at(document.buffer), [0, 2]); assert.ok(pane.message.includes('wrapped'));
  pane.handleInput('N'); assert.deepEqual(at(document.buffer), [1, 3]);
  for (const key of '/none') pane.handleInput(key); pane.handleInput('\x1b'); assert.deepEqual(at(document.buffer), [1, 3]);
  assert.ok(!plain(pane.render(60).join('\n')).includes('/none'), 'Esc closes the search prompt');
  for (const key of '/none') pane.handleInput(key); pane.handleInput('\x03'); assert.deepEqual(at(document.buffer), [1, 3]);
  for (const key of '/none\r') pane.handleInput(key); assert.deepEqual(at(document.buffer), [1, 3]);
  assert.equal(pane.message, 'Pattern not found: none');
  assert.equal(document.buffer.text, '一段文字\n第二段文字\nend'); assert.equal(document.dirty, dirty);
}));
test('long lines stay fast for word motions and search', () => {
  const long = 'x'.repeat(20000) + ' y', b = new DocumentBuffer(long + '\n' + long);
  const timed = fn => { const start = performance.now(); fn(); return performance.now() - start; };
  for (const motion of ['w', 'e', 'b']) assert.ok(timed(() => b.word(motion)) < 300, `${motion} is linear`);
  assert.deepEqual(at(b), [1, 0]);
  assert.ok(timed(() => b.search('y')) < 300, 'search is linear');
  const many = new DocumentBuffer('x'.repeat(40000));
  assert.ok(timed(() => many.search('x')) < 300, 'many matches on one long line stay linear');
});
test('narrow command line keeps the typed tail visible', async () => fixture(async ({ document }) => {
  const pane = new DocumentPane(document, () => theme, () => 24, () => {}, () => true, () => {});
  pane.focused = true;
  for (const key of '/' + 'a'.repeat(40) + 'TAIL') pane.handleInput(key);
  const line = pane.render(30).find(line => line.includes(tui.CURSOR_MARKER));
  const visible = plain(line); assert.ok(visible.includes('/…') && visible.includes('TAIL'), visible);
  assert.ok(pane.render(30).every(line => tui.visibleWidth(line) <= 30));
  pane.handleInput('\x1b[200~' + '中'.repeat(16000) + '尾\x1b[201~');
  const start = performance.now(); const wide = pane.render(30);
  assert.ok(performance.now() - start < 300, 'long prompt renders in linear time');
  assert.ok(plain(wide.find(line => line.includes(tui.CURSOR_MARKER))).includes('尾'));
  assert.ok(wide.every(line => tui.visibleWidth(line) <= 30));
  for (const width of [4, 5, 6, 7]) {
    const lines = pane.render(width); assert.ok(lines.every(line => tui.visibleWidth(line) <= width));
    if (width > 4) assert.ok(plain(lines.find(line => line.includes(tui.CURSOR_MARKER))).includes('尾'), `tail visible at width ${width}`);
  }
}));
test('unsupported operator sequences are cancelled instead of running the motion', async () => fixture(async ({ document }) => {
  document.buffer.replace('alpha beta'); document.buffer.col = 0;
  const pane = new DocumentPane(document, () => theme, () => 24, () => {}, () => true, () => {});
  for (const key of 'dw') pane.handleInput(key); assert.deepEqual(at(document.buffer), [0, 0]);
  for (const key of 'y:') pane.handleInput(key); pane.handleInput('w'); assert.deepEqual(at(document.buffer), [0, 6]);
  assert.equal(document.buffer.text, 'alpha beta');
}));
test('Ctrl+C in Normal Mode cancels a pending operator before pi sees it', async () => fixture(async ({ document }) => {
  const pane = new DocumentPane(document, () => theme, () => 24, () => {}, () => true, () => {});
  const before = document.buffer.text;
  pane.handleInput('d'); assert.equal(pane.interrupt(), true, 'only the operator is cancelled'); pane.handleInput('d');
  assert.equal(document.buffer.text, before);
  assert.equal(pane.interrupt(), true, 'the second d is pending again');
  assert.equal(pane.interrupt(), false, 'the next Ctrl+C reaches pi'); assert.equal(document.buffer.text, before);
}));
test('Ctrl+C leaves Insert Mode without touching text; w/e/b move visual selection', async () => fixture(async ({ document }) => {
  const pane = new DocumentPane(document, () => theme, () => 24, () => {}, () => true, () => {});
  pane.handleInput('i'); pane.handleInput('x'); pane.handleInput('\x03');
  assert.equal(document.buffer.mode, 'normal'); assert.ok(document.buffer.text.startsWith('x# Plan'));
  assert.equal(pane.interrupt(), false, 'normal-mode Ctrl+C is left to pi');
  document.buffer.replace('alpha beta gamma'); document.buffer.col = 0;
  pane.handleInput('v'); pane.handleInput('w'); pane.handleInput('e');
  assert.equal(document.buffer.text.slice(...document.buffer.selection()), 'alpha beta');
  pane.handleInput('b'); assert.equal(document.buffer.text.slice(...document.buffer.selection()), 'alpha b');
  pane.handleInput('i'); pane.handleInput('w'); assert.equal(document.buffer.text, 'alpha wbeta gamma');
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
