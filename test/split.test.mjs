import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, tui, agent, host, tuiPath } from './host.mjs';
const { SplitView } = await load('split');
const { DocumentSession } = await load('document');
const extension = (await load('pane-controller')).default;
const { renderLayoutFrame } = await import(new URL('./layout.js', pathToFileURL(tuiPath)));
const { createInteractiveTuiReference } = await import(pathToFileURL(join(host, 'dist/modes/interactive/tui-renderer.js')).href);
const { getEditorTheme, theme } = await import(pathToFileURL(join(host, 'dist/modes/interactive/theme/theme.js')).href);
const { KeybindingsManager } = await import(pathToFileURL(join(host, 'dist/core/keybindings.js')).href);
agent.initTheme('dark', false);
const keys = KeybindingsManager.create();
class Terminal {
  columns = 160; rows = 30; kittyProtocolActive = false; output = '';
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {} write(s) { this.output += s; } drainInput() { return Promise.resolve(); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {} setProgramStatus() {}
}
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-split-')); const path = join(dir, 'plan.md');
  await writeFile(path, '# Plan\n第一段計畫\n');
  const terminal = new Terminal(); let active = new tui.TuiAltScreen(terminal, true);
  const surface = createInteractiveTuiReference(() => active);
  let editor = new agent.CustomEditor(surface, getEditorTheme(), keys);
  const editorContainer = new tui.Container(); editorContainer.addChild(editor);
  const transcript = new tui.ScrollView(new tui.Text('LEFT TRANSCRIPT\n' + 'streaming line\n'.repeat(100), 0, 0), { primary: true, follow: 'end' });
  const original = new tui.VStack([{ component: transcript, basis: 0, grow: 1 }, { component: editorContainer, basis: 'auto' }]);
  active.setLayoutRoot(original); active.setFocus(editor);
  let factory; const notices = [], statuses = new Map();
  const ctx = { cwd: dir, mode: 'tui', hasUI: true, ui: {
    theme,
    getEditorComponent: () => factory,
    setEditorComponent: next => {
      const text = editor.getText(); factory = next;
      editor = next ? next(surface, getEditorTheme(), keys) : new agent.CustomEditor(surface, getEditorTheme(), keys);
      editor.setText(text); editorContainer.clear(); editorContainer.addChild(editor); active.setFocus(editor);
    },
    setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
    notify: (text, type) => notices.push({ text, type }),
  } };
  try { await fn({ dir, path, document: await DocumentSession.open(path), ctx, surface, terminal, original,
    active: () => active, editor: () => editor, notices, statuses,
    setActive: next => { active = next; if (tui.isViewportTUI(active)) active.setLayoutRoot(original); active.setFocus(editor); },
  }); }
  finally { active.stop(); await rm(dir, { recursive: true, force: true }); }
}
const walk = (box, predicate) => predicate(box) ? box : box.children.map(child => walk(child, predicate)).find(Boolean);
async function withExtension(f, fn) {
  const commands = new Map(), events = new Map(), entries = [], tools = new Map();
  let active = ['read', 'bash', 'write'], confirmation = true;
  const selections = [], choices = [], confirms = [];
  f.ctx.isIdle = () => true; f.ctx.sessionManager = { getBranch: () => entries };
  f.ctx.ui.confirm = async (...args) => { confirms.push(args); return confirmation; };
  f.ctx.ui.select = async (title, options) => {
    selections.push({ title, options }); const choice = choices.shift();
    return typeof choice === 'function' ? choice(options) : choice;
  };
  (await load('extension')).default({
    registerTool: t => tools.set(t.name, t), registerCommand: (n, spec) => commands.set(n, spec), registerShortcut() {},
    on: (n, h) => { const handlers = events.get(n) ?? []; handlers.push(h); events.set(n, handlers); },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    getActiveTools: () => active, setActiveTools: t => { active = t; }, sendUserMessage() {},
  });
  const { ArtifactStore } = await load('store'); const store = new ArtifactStore(f.dir);
  try { await fn({ store, choices, selections, confirms, tools, active: () => active,
    command: args => commands.get('plan').handler(args, f.ctx), setConfirm: value => { confirmation = value; } }); }
  finally { for (const handler of events.get('session_shutdown') ?? []) await handler({}, f.ctx); }
}

test('actual fullscreen layout allocates half width and retains original chat root', async () => fixture(async f => {
  f.editor().setText('chat draft');
  const view = new SplitView(f.ctx, f.document, () => {}); view.mount();
  assert.equal(view.attached, true); assert.equal(f.editor().getText(), 'chat draft');
  const root = f.active().layoutRoot;
  for (const [width, height] of [[160, 30], [180, 48], [80, 24], [50, 16]]) {
    f.terminal.columns = width; f.terminal.rows = height;
    const frame = renderLayoutFrame(root, width, height, () => {});
    const chat = walk(frame.root, box => box.component === f.original);
    assert.equal(chat.rect.width, Math.ceil(width / 2)); assert.equal(chat.rect.x, 0);
    assert.equal(frame.root.children[1].rect.x, Math.ceil(width / 2));
    assert.equal(frame.root.children[1].rect.width, Math.floor(width / 2));
    assert.equal(frame.lines.length, height); assert.ok(frame.lines.every(line => tui.visibleWidth(line) <= width));
    assert.ok(frame.lines.some(line => tui.stripTerminalSequences(line).includes('plan.md')));
  }
  view.unmount(); assert.equal(f.active().layoutRoot, f.original); assert.equal(f.ctx.ui.getEditorComponent(), undefined);
  assert.equal(f.editor().getText(), 'chat draft');
}));
test('bridge keeps chat and document text separate, routes F6 and emits one cursor', async () => fixture(async f => {
  const view = new SplitView(f.ctx, f.document, () => {}); view.mount();
  f.editor().handleInput('chat'); f.editor().handleInput('\x1b[17~'); // F6
  f.editor().handleInput('i'); f.editor().handleInput('中文');
  assert.equal(f.editor().getText(), 'chat'); assert.ok(f.document.buffer.text.startsWith('中文'));
  // Streaming and host editor focus restoration must not change pane routing.
  f.active().setFocus(f.editor());
  let frame = renderLayoutFrame(f.active().layoutRoot, 160, 30, () => {});
  assert.equal(frame.lines.join('').split(tui.CURSOR_MARKER).length - 1, 1);
  assert.ok(frame.lines.some(line => line.includes(tui.CURSOR_MARKER) && tui.visibleWidth(line.split(tui.CURSOR_MARKER)[0]) >= 80));
  f.editor().handleInput('\x1b'); assert.equal(f.document.buffer.mode, 'normal');
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput(' again');
  assert.equal(f.editor().getText(), 'chat again');
  frame = renderLayoutFrame(f.active().layoutRoot, 160, 30, () => {});
  assert.equal(frame.lines.join('').split(tui.CURSOR_MARKER).length - 1, 1); view.unmount();
}));
test('Ctrl+C leaves document Insert Mode without reaching pi; other modes keep app.clear', async () => fixture(async f => {
  const view = new SplitView(f.ctx, f.document, async () => true); view.mount();
  let cleared = 0; f.editor().onAction('app.clear', () => cleared++);
  f.editor().handleInput('chat'); f.editor().handleInput('\x03'); assert.equal(cleared, 1, 'left chat Ctrl+C unchanged');
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('x');
  f.editor().handleInput('\x03');
  assert.equal(cleared, 1); assert.equal(f.document.buffer.mode, 'normal');
  assert.ok(f.document.buffer.text.startsWith('x# Plan')); assert.equal(f.editor().getText(), 'chat');
  f.editor().handleInput(':'); f.editor().handleInput('\x03'); assert.equal(cleared, 1, 'command line cancel stays in pane');
  f.editor().handleInput('\x03'); assert.equal(cleared, 2, 'normal-mode Ctrl+C reaches pi');
  f.editor().handleInput('v'); f.editor().handleInput('\x03'); assert.equal(cleared, 3, 'visual-mode Ctrl+C reaches pi');
  view.unmount();
}));
test('refuses competing editor and never clobbers another layout or factory on teardown', async () => fixture(async f => {
  const competitor = () => new agent.CustomEditor(f.surface, getEditorTheme(), keys);
  f.ctx.ui.setEditorComponent(competitor);
  const blocked = new SplitView(f.ctx, f.document, () => {}); assert.throws(() => blocked.mount(), /Another extension/);
  assert.equal(f.ctx.ui.getEditorComponent(), competitor);
  f.ctx.ui.setEditorComponent(undefined);
  const view = new SplitView(f.ctx, f.document, () => {}); view.mount();
  const otherRoot = new tui.Text('other layout', 0, 0); f.active().setLayoutRoot(otherRoot);
  f.ctx.ui.setEditorComponent(competitor); view.unmount();
  assert.equal(f.active().layoutRoot, otherRoot); assert.equal(f.ctx.ui.getEditorComponent(), competitor);
}));
test('regular mode and missing private layout root fail safely', async () => fixture(async f => {
  f.setActive(new tui.TuiMainScreen(f.terminal, true));
  const view = new SplitView(f.ctx, f.document, () => {}); assert.throws(() => view.mount(), /fullscreen/);
  assert.equal(f.ctx.ui.getEditorComponent(), undefined);
  f.setActive(new tui.TuiAltScreen(f.terminal, true)); f.active().setLayoutRoot(undefined);
  assert.throws(() => new SplitView(f.ctx, f.document, () => {}).mount(), /compatible fullscreen root/);
}));
test('renderer swap is detected through pi stable proxy without using stale renderer', async () => fixture(async f => {
  const view = new SplitView(f.ctx, f.document, () => {}); view.mount();
  f.setActive(new tui.TuiAltScreen(f.terminal, true)); assert.equal(view.attached, false);
  view.unmount(); assert.equal(f.active().layoutRoot, f.original);
}));
test('pane API protects dirty drafts and saves/copies explicitly without registering commands', async () => fixture(async f => {
  const commands = new Map(), events = new Map();
  const pane = extension({ registerCommand: (name, spec) => commands.set(name, spec), on: (name, handler) => events.set(name, handler) });
  assert.equal(commands.size, 0);
  await pane.open(f.path, f.ctx);
  assert.ok(f.statuses.has('plan-pane'));
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('draft');
  assert.throws(() => pane.close(), /Unsaved draft/);
  assert.deepEqual(events.get('session_before_switch')({}, f.ctx), { cancel: true });
  const copy = join(f.dir, 'draft copy.md'); await pane.document.saveCopy(copy); assert.ok((await readFile(copy, 'utf8')).startsWith('draft'));
  await pane.save(); assert.ok((await readFile(f.path, 'utf8')).startsWith('draft'));
  assert.equal(f.statuses.get('plan-pane'), 'plan');
  pane.close(); assert.equal(f.active().layoutRoot, f.original); assert.equal(f.statuses.size, 0);
  await events.get('session_shutdown')({}, f.ctx);
}));
test('save reports concurrent saves and keeps a written file successful when plan sync fails', async () => fixture(async f => {
  let release; const gate = new Promise(r => release = r);
  const pane = extension({ registerCommand() {}, on() {} }, async () => { await gate; throw new Error('plan sync failed'); });
  await pane.open(f.path, f.ctx);
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('draft');
  const first = pane.save(); await new Promise(r => setTimeout(r, 50));
  assert.equal(await pane.save(), false);
  assert.ok(tui.stripTerminalSequences(renderLayoutFrame(f.active().layoutRoot, 160, 30, () => {}).lines.join('\n')).includes('Save already in progress'));
  release(); assert.equal(await first, true);
  assert.ok((await readFile(f.path, 'utf8')).startsWith('draft'));
  assert.ok(f.notices.some(n => n.type === 'error' && n.text === 'plan sync failed'));
  assert.equal(await pane.save(), true, 'saving flag is reset');
  await rm(f.path); await import('node:fs/promises').then(fs => fs.mkdir(f.path));
  // A directory in place of the file makes the pre-write disk check fail.
  f.editor().handleInput('x'); assert.equal(await pane.save(), false, 'a failed save returns false');
  assert.ok(f.notices.at(-1).type === 'error'); assert.equal(pane.dirty, true, 'failed write keeps the draft');
  await rm(f.path, { recursive: true });
}));
test('F7 and pane toggle hide and reshow the pane without saving, discarding or moving the cursor', async () => fixture(async f => {
  const commands = new Map(), shortcuts = new Map(), events = new Map();
  const pane = extension({ registerCommand: (n, spec) => commands.set(n, spec), registerShortcut: (k, spec) => shortcuts.set(k, spec), on: (n, h) => events.set(n, h) });
  assert.deepEqual([...shortcuts.keys()], ['f7']);
  shortcuts.get('f7').handler(f.ctx); assert.match(f.notices.at(-1).text, /No plan pane open\. Start with \/plan or/);
  // pi forwards extension shortcuts to custom editors through onExtensionShortcut.
  const bind = () => { f.editor().onExtensionShortcut = data => data === '\x1b[18~' ? (shortcuts.get('f7').handler(f.ctx), true) : false; };
  await pane.open(f.path, f.ctx); bind();
  f.editor().handleInput('chat');
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('j'); f.editor().handleInput('i'); f.editor().handleInput('X');
  const text = pane.document.buffer.text, cursor = [pane.document.buffer.row, pane.document.buffer.col];
  f.editor().handleInput('\x1b[18~');
  assert.equal(pane.hidden, true); assert.equal(f.active().layoutRoot, f.original, 'full-width chat');
  assert.equal(f.ctx.ui.getEditorComponent(), undefined); assert.equal(f.editor().getText(), 'chat');
  assert.equal(f.statuses.get('plan-pane'), 'plan hidden*'); assert.match(f.notices.at(-1).text, /hidden · unsaved draft kept · F7/);
  assert.equal(pane.dirty, true); assert.notEqual(await readFile(f.path, 'utf8'), text, 'hiding never saves');
  await pane.open(f.path, f.ctx); assert.equal(pane.hidden, true, 'model updates do not re-open a hidden pane');
  shortcuts.get('f7').handler(f.ctx);
  assert.equal(pane.hidden, false); assert.notEqual(f.active().layoutRoot, f.original);
  f.terminal.columns = 160; f.terminal.rows = 30;
  const rect = renderLayoutFrame(f.active().layoutRoot, 160, 30, () => {}).root.children[1].rect;
  assert.deepEqual([rect.x, rect.width], [80, 80], 'reshown 50/50');
  assert.equal(pane.document.buffer.text, text); assert.deepEqual([pane.document.buffer.row, pane.document.buffer.col], cursor);
  assert.equal(pane.document.buffer.mode, 'insert'); assert.equal(f.editor().getText(), 'chat');
  pane.toggle(f.ctx); assert.equal(pane.hidden, true);
  pane.toggle(f.ctx); assert.equal(pane.hidden, false);
  pane.toggle(f.ctx); pane.discardDraft();
  assert.equal(pane.hidden, false); assert.equal(pane.document, undefined);
  await pane.open(f.path, f.ctx); pane.hide(f.ctx); pane.close(); assert.equal(pane.hidden, false, 'close() resets hidden');
  await pane.open(f.path, f.ctx); pane.hide(f.ctx); assert.equal(events.get('session_before_switch')({}, f.ctx), undefined);
  assert.equal(pane.hidden, false, 'navigation resets hidden');
  await pane.open(f.path, f.ctx); pane.hide(f.ctx); await events.get('session_shutdown')({ reason: 'quit' }, f.ctx);
  assert.equal(pane.hidden, false, 'shutdown resets hidden');
  await events.get('session_shutdown')({ reason: 'quit' }, f.ctx);
}));
test('/plan open reveals hidden artifacts and keeps mounted-pane commands in chat', async () => fixture(async f => {
  const commands = new Map(), events = new Map(), shortcuts = new Map(), entries = [];
  let active = ['read', 'bash'];
  const fullExtension = (await load('extension')).default;
  f.ctx.isIdle = () => true; f.ctx.sessionManager = { getBranch: () => entries };
  fullExtension({
    registerTool() {}, registerCommand: (n, spec) => commands.set(n, spec),
    registerShortcut: (key, spec) => shortcuts.set(key, spec),
    on: (name, handler) => { const handlers = events.get(name) ?? []; handlers.push(handler); events.set(name, handlers); },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    getActiveTools: () => active, setActiveTools: tools => { active = tools; }, sendUserMessage() {},
  });
  const plan = args => commands.get('plan').handler(args, f.ctx);
  try {
    await plan('');
    const { ArtifactStore } = await load('store');
    const [record] = await new ArtifactStore(f.dir).list();
    for (const state of ['hidden', 'mounted']) {
      if (state === 'hidden') shortcuts.get('f7').handler(f.ctx);
      await plan(`open ${record.path}`);
      assert.notEqual(f.active().layoutRoot, f.original, state + ' is visible');
      f.editor().handleInput('[200~chat-only[201~');
      assert.equal(f.editor().getText(), 'chat-only', state + ' retains chat focus');
      f.editor().setText('');
      assert.equal(f.statuses.get('plan-pane'), 'plan');
    }
  } finally { for (const handler of events.get('session_shutdown') ?? []) await handler({}, f.ctx); }
}));
test('/plan discard only removes the visible artifact and confirms dirty draft loss plus Plan Mode exit', () => fixture(f => withExtension(f, async x => {
  const a = await x.store.create('# A'), b = await x.store.create('# B');
  await x.command('discard'); assert.equal(x.confirms.length, 0);
  await x.command(`open ${a.record.path}`);
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('UNSAVED');
  await x.command('toggle'); await x.command('discard');
  assert.match(f.notices.at(-1).text, /不會刪除/); assert.equal(x.confirms.length, 0);
  assert.equal((await x.store.read(a.record.id)).record.status, 'draft');
  await x.command('toggle'); x.setConfirm(false); await x.command('discard');
  assert.equal((await x.store.read(a.record.id)).record.status, 'draft');
  assert.ok(f.ctx.ui.getEditorComponent());
  x.setConfirm(true); await x.command('discard');
  assert.equal((await x.store.read(a.record.id)).record.status, 'abandoned');
  assert.equal(await readFile(join(f.dir, a.record.path), 'utf8'), '# A');
  assert.equal(await x.store.revision(a.record.id, a.revision), '# A');
  assert.ok(x.confirms.at(-1)[1].includes('未儲存的修改會被放棄'));
  assert.equal(f.ctx.ui.getEditorComponent(), undefined);
  assert.equal((await x.store.read(b.record.id)).record.status, 'draft');
  await x.command(''); const current = (await x.store.list()).at(-1);
  assert.ok(!x.active().includes('write'));
  await x.command('discard');
  assert.ok(x.confirms.at(-1)[1].includes('退出 Plan Mode'));
  assert.equal((await x.store.read(current.id)).record.status, 'abandoned');
  assert.ok(x.active().includes('write')); await x.command('status');
  assert.match(f.notices.at(-1).text, /未在 Plan Mode/);
})));
test('/plan open resolves dirty switching with save, cancel and explicit draft loss; discussions can finish outside Plan Mode', () => fixture(f => withExtension(f, async x => {
  const a = await x.store.create('# A'), b = await x.store.create('# B');
  await x.command(`open ${a.record.path}`);
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('SAVED');
  x.choices.push('取消'); await x.command(`open ${b.record.path}`);
  assert.ok(f.ctx.ui.getEditorComponent()); assert.equal(await readFile(join(f.dir, a.record.path), 'utf8'), '# A');
  x.choices.push('儲存'); await x.command(`open ${b.record.path}`);
  assert.equal(await readFile(join(f.dir, a.record.path), 'utf8'), 'SAVED# A');
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('LOST');
  x.choices.push('放棄修改'); await x.command(`open ${a.record.path}`);
  assert.equal(await readFile(join(f.dir, b.record.path), 'utf8'), '# B');
  assert.deepEqual(x.active(), ['read', 'bash', 'write'], 'opening never enables planning');
  await x.command('done'); assert.equal((await x.store.read(a.record.id)).record.progress, 'done');
  await x.command('status'); assert.match(f.notices.at(-1).text, /已完成/);
  assert.ok(x.active().includes('write'), 'finishing a discussion never activates restrictions');
  await x.command(`copy ${join(f.dir, 'outside copy.md')}`);
  await x.command('open outside copy.md'); assert.match(f.notices.at(-1).text, /No artifact found/);
})));
test(':wq hides the pane only after a successful save', async () => fixture(async f => {
  const pane = extension({ registerCommand() {}, on() {} });
  await pane.open(f.path, f.ctx);
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('Y'); f.editor().handleInput('\x1b');
  for (const key of ':wq\r') f.editor().handleInput(key);
  await new Promise(r => setTimeout(r, 50));
  assert.ok((await readFile(f.path, 'utf8')).startsWith('Y# Plan')); assert.equal(pane.hidden, true);
  assert.equal(f.active().layoutRoot, f.original);
  pane.show(f.ctx, false); await rm(f.path); await import('node:fs/promises').then(fs => fs.mkdir(f.path));
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('Z'); f.editor().handleInput('\x1b');
  for (const key of ':wq\r') f.editor().handleInput(key);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(pane.hidden, false, 'failed save keeps the pane open'); assert.equal(pane.dirty, true);
  await rm(f.path, { recursive: true });
}));
test(':wq hide is a no-op when its document was closed during plan sync', async () => fixture(async f => {
  let release; const gate = new Promise(r => release = r);
  const pane = extension({ registerCommand() {}, on() {} }, async () => { await gate; });
  await pane.open(f.path, f.ctx);
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('Q'); f.editor().handleInput('\x1b');
  for (const key of ':wq\r') f.editor().handleInput(key);
  await new Promise(r => setTimeout(r, 50));
  pane.close(); release(); await new Promise(r => setTimeout(r, 20));
  assert.equal(pane.hidden, false); assert.equal(pane.document, undefined);
  assert.ok(!f.notices.some(n => n.text === 'No document open.'));
}));
test('pane shows the plan phase bottom-right and keeps phase and dirty marker when narrow', async () => fixture(async f => {
  let phase = 'PLAN planning';
  const pane = extension({ registerCommand() {}, on() {} }, undefined, () => phase);
  await pane.open(f.path, f.ctx);
  const bottom = width => { f.terminal.columns = width * 2; f.terminal.rows = 20; return tui.stripTerminalSequences(renderLayoutFrame(f.active().layoutRoot, width * 2, 20, () => {}).lines.at(-1)); };
  assert.match(bottom(60), /F6 focus · F7 hide ─+ PLAN planning ┘$/);
  phase = 'PLAN review'; pane.repaint(); assert.match(bottom(60), / PLAN review ┘$/);
  const narrow = bottom(24); assert.match(narrow, / PLAN review ┘$/); assert.ok(!narrow.includes('F6'));
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('x');
  f.terminal.columns = 30; const top = tui.stripTerminalSequences(renderLayoutFrame(f.active().layoutRoot, 30, 20, () => {}).lines[0]);
  assert.ok(top.includes('[+]'), top);
  for (const width of [3, 4, 5, 6, 7, 8]) {
    f.terminal.columns = width * 2;
    const line = tui.stripTerminalSequences(renderLayoutFrame(f.active().layoutRoot, width * 2, 20, () => {}).lines[0]);
    assert.ok(line.includes(width < 5 ? '+' : '[+]'), `dirty marker at pane width ${width}: ${line}`);
  }
  assert.ok(!f.statuses.has('plan-mode'));
}));
test('programmatic reopen of the same artifact preserves chat input focus', async () => fixture(async f => {
  const events = new Map();
  const pane = extension({ registerCommand() {}, on: (name, handler) => events.set(name, handler) });
  await pane.open(f.path, f.ctx);
  f.editor().handleInput('chat');
  const original = pane.document.buffer.text;
  await pane.open(f.path, f.ctx); // /plan approve opens the same document
  f.editor().handleInput('/plan execute');
  assert.equal(f.editor().getText(), 'chat/plan execute');
  assert.equal(pane.document.buffer.text, original);
  await events.get('session_shutdown')({ reason: 'quit' }, f.ctx);
}));
test('right-pane click never steals keyboard focus from inline host selectors', async () => fixture(async f => {
  const view = new SplitView(f.ctx, f.document, () => {}); view.mount();
  const selector = { focused: false, render: () => ['HOST SELECTOR'], invalidate() {}, handleInput() {} };
  f.active().setFocus(selector);
  const frame = renderLayoutFrame(f.active().layoutRoot, 160, 30, () => {});
  frame.root.children[1].component.handleMouse({ type: 'press', button: 'left', x: 5, y: 2 });
  assert.equal(f.active().getFocusedComponent(), selector);
  view.focusPlan(); assert.equal(f.active().getFocusedComponent(), selector);
  f.active().setFocus(f.editor()); view.focusPlan();
  assert.equal(f.active().getFocusedComponent(), f.editor());
  let renders = 0; const request = f.surface.requestRender;
  f.active().requestRender = () => { renders++; };
  f.editor().handleMouse({ type: 'press', button: 'left', x: 5, y: 0 });
  assert.ok(renders > 0);
  f.active().requestRender = request; view.unmount();
}));
test('graceful reload recovers a dirty draft privately after host resets the editor', async () => fixture(async f => {
  const events = new Map();
  const pane = extension({ on: (name, handler) => events.set(name, handler) });
  await pane.open(f.path, f.ctx);
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('unsaved中文');
  f.ctx.ui.setEditorComponent(undefined); // actual /reload sequence
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(f.dir, 'agent');
  try {
    await events.get('session_shutdown')({ reason: 'reload' }, f.ctx);
    const directory = join(f.dir, 'agent/drafts/pi-artifact');
    const files = await readdir(directory); assert.equal(files.length, 1);
    assert.ok((await readFile(join(directory, files[0]), 'utf8')).startsWith('unsaved中文'));
    assert.equal((await stat(join(directory, files[0]))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal(f.active().layoutRoot, f.original); assert.equal(f.statuses.size, 0);
    assert.ok(!(await readFile(f.path, 'utf8')).startsWith('unsaved中文'));
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
  }
}));
test('non-TUI mode refuses opening without claiming the editor', async () => fixture(async f => {
  const pane = extension({ on() {} });
  await assert.rejects(pane.open(f.path, { ...f.ctx, mode: 'print' }), /interactive fullscreen/); assert.equal(f.ctx.ui.getEditorComponent(), undefined);
}));
