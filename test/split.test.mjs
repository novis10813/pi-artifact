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
test('command integration protects dirty drafts and saves/copies explicitly', async () => fixture(async f => {
  const commands = new Map(), events = new Map();
  extension({ registerCommand: (name, spec) => commands.set(name, spec), on: (name, handler) => events.set(name, handler) });
  const command = args => commands.get('plan-pane').handler(args, f.ctx);
  await command(`open ${f.path}`);
  assert.ok(f.statuses.has('plan-pane'));
  f.editor().handleInput('\x1b[17~'); f.editor().handleInput('i'); f.editor().handleInput('draft');
  await command('close'); assert.match(f.notices.at(-1).text, /Unsaved draft/);
  assert.deepEqual(events.get('session_before_switch')({}, f.ctx), { cancel: true });
  const copy = join(f.dir, 'draft copy.md'); await command(`copy ${copy}`); assert.ok((await readFile(copy, 'utf8')).startsWith('draft'));
  await command('save'); assert.ok((await readFile(f.path, 'utf8')).startsWith('draft'));
  assert.equal(f.statuses.get('plan-pane'), 'plan');
  await command('close'); assert.equal(f.active().layoutRoot, f.original); assert.equal(f.statuses.size, 0);
  await events.get('session_shutdown')({}, f.ctx);
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
  const events = new Map(); let command;
  extension({ registerCommand: (_name, spec) => { command = spec; }, on: (name, handler) => events.set(name, handler) });
  await command.handler(`open ${f.path}`, f.ctx);
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
test('non-TUI mode refuses commands without claiming the editor', async () => fixture(async f => {
  let command;
  extension({ registerCommand: (_name, spec) => { command = spec; }, on() {} });
  await command.handler(`open ${f.path}`, { ...f.ctx, mode: 'print' });
  assert.match(f.notices.at(-1).text, /interactive fullscreen/); assert.equal(f.ctx.ui.getEditorComponent(), undefined);
}));
