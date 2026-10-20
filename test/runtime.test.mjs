import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './host.mjs';
const theme = { fg: (_token, value) => value };
const extension = (await load('extension')).default;
const { ArtifactStore } = await load('store');
async function fixture(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-plan-runtime-'));
  const tools = new Map(), commands = new Map(), events = new Map(), entries = [], notices = [], messages = [], statuses = new Map();
  const reviewScripts = [], reviewFrames = [];
  let active = ['read', 'bash', 'write', 'codemode', 'subagent'], idle = true, confirmation = true;
  const pi = {
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, spec) => commands.set(name, spec),
    on: (name, handler) => { const values = events.get(name) ?? []; values.push(handler); events.set(name, values); },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) }),
    getActiveTools: () => active.slice(), setActiveTools: next => { active = next; },
    sendUserMessage: content => messages.push(content),
  };
  const ctx = { cwd, mode: 'print', hasUI: true, isIdle: () => idle,
    sessionManager: { getBranch: () => entries.slice() },
    ui: { notify: (text, type) => notices.push({ text, type }), setStatus: (k, v) => v === undefined ? statuses.delete(k) : statuses.set(k, v),
      getEditorComponent: () => undefined, setEditorComponent: () => { throw Error('no viewport'); },
      confirm: async () => confirmation, select: async () => undefined,
      custom: async factory => {
        let result;
        const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, value => { result = value; });
        reviewFrames.push(component.render(90).join('\n'));
        for (const key of reviewScripts.shift() ?? ['a', 'y']) component.handleInput(key);
        return result;
      },
    },
  };
  const emit = async (name, event = {}) => {
    let result;
    for (const handler of events.get(name) ?? []) { const value = await handler(event, ctx); if (value !== undefined) result = value; }
    return result;
  };
  extension(pi);
  const command = async args => { await commands.get('plan').handler(args, ctx); };
  const tool = async (name, input = {}) => {
    const blocked = await emit('tool_call', { toolName: name, input });
    if (blocked?.block) return blocked;
    return tools.get(name)?.execute('call', input, new AbortController().signal, undefined, ctx);
  };
  try { await emit('session_start'); await fn({ cwd, ctx, tools, commands, emit, entries, messages, notices, statuses, command, tool,
    reviewScripts, reviewFrames, store: new ArtifactStore(cwd), active: () => active, setIdle: value => { idle = value; }, setConfirm: value => { confirmation = value; } }); }
  finally { await emit('session_shutdown', { reason: 'quit' }); await rm(cwd, { recursive: true, force: true }); }
}
test('real plan/artifact review commands retain saved comments without authorizing execution', () => fixture(async f => {
  const a = await f.store.create('# Context\n\nsecond line', 'Review');
  const line = a.content.split('\n').indexOf('# Context') + 2;
  await f.store.review(a.record.id, a.revision, 'rejected', '', [{ line, comment: 'keep this comment' }]);
  await f.command(`use ${a.record.id}`); f.ctx.mode = 'tui';
  f.reviewScripts.push(['j', 'a', 'y']); await f.command('review');
  assert.ok(f.reviewFrames[0].includes('comments: 1'));
  assert.equal((await f.store.readReview(a.record.id, a.revision)).lineComments[0].comment, 'keep this comment');
  assert.match(f.messages.at(-1), /# Context/);
  assert.equal((await f.tool('write')).block, true);
  f.reviewScripts.push(['a', 'y']); await f.commands.get('artifact').handler(`review ${a.record.id}`, f.ctx);
  assert.equal(f.reviewFrames.length, 2);
  assert.equal((await f.store.readReview(a.record.id, a.revision)).lineComments[0].comment, 'keep this comment');
}));
test('runtime registers historical schemas plus read/replace/submit, updates same plan and stops review', () => fixture(async f => {
  assert.deepEqual(Object.keys(f.tools.get('create_artifact').parameters.properties), ['content', 'title']);
  assert.deepEqual(Object.keys(f.tools.get('edit_artifact').parameters.properties), ['artifactId', 'edits']);
  await f.command('on implement user feature');
  const [a] = await f.store.list(); assert.ok(a); assert.ok(f.messages.at(-1).includes(a.id));
  assert.ok(!f.active().includes('codemode'));
  const before = await f.tool('read_artifact', { artifactId: a.id }); assert.match(before.content[0].text, /Goal/);
  await f.tool('edit_artifact', { artifactId: a.id, edits: [{ oldText: '## Approach', newText: '## Chosen approach' }] });
  assert.match((await f.store.read(a.id)).content, /Chosen approach/);
  await f.tool('create_artifact', { content: '# Revised same plan' });
  assert.equal((await f.store.list()).length, 1);
  assert.match((await f.store.read(a.id)).content, /Revised same plan/);
  assert.equal((await f.tool('bash', { command: 'touch forbidden' })).block, true);
  await f.emit('input', { text: 'looks good', source: 'interactive' });
  assert.equal((await f.tool('write', { path: 'bad' })).block, true);
  assert.equal((await f.tool('request_plan_review')).block, true);
}));
test('runtime explicit approval and execute confirmations cannot be bypassed by chat or generic review', () => fixture(async f => {
  await f.command('on feature'); const [a] = await f.store.list();
  await f.tool('request_plan_review');
  await f.store.review(a.id, (await f.store.read(a.id)).revision, 'approved');
  f.ctx.mode = 'tui';
  await f.command('execute'); assert.match(f.notices.at(-1).text, /approve first/);
  await f.emit('input', { text: 'approved go implement it', source: 'interactive' });
  assert.equal((await f.tool('bash')).block, true);
  f.setConfirm(false); await f.command('approve'); assert.equal((await f.tool('write')).block, true);
  f.setConfirm(true); await f.command('approve'); assert.equal((await f.tool('write')).block, true);
  await f.command('execute'); assert.equal(await f.emit('tool_call', { toolName: 'write', input: {} }), undefined);
  assert.ok(f.active().includes('codemode')); assert.match(f.messages.at(-1), /exact revision/);
  const current = await f.store.read(a.id);
  await writeFile(join(f.cwd, a.path), current.content + '\nexternal change');
  assert.equal((await f.emit('tool_call', { toolName: 'write', input: {} })).block, true);
  assert.ok(!f.active().includes('bash'));
}));
test('runtime user shell and nested call hooks enforce policy; off is explicit and restores tools', () => fixture(async f => {
  await f.command('on feature');
  const shell = await f.emit('user_bash', { command: 'rm -rf target' });
  assert.equal(shell.result.exitCode, 1); assert.match(shell.result.output, /blocks bash/);
  const nested = await f.emit('tool_call', { toolName: 'write', input: {}, parentToolCallId: 'wrapper' });
  assert.equal(nested.block, true);
  f.setConfirm(false); await f.command('off'); assert.equal((await f.tool('bash')).block, true);
  f.setConfirm(true); await f.command('off'); assert.equal(await f.emit('tool_call', { toolName: 'bash', input: {} }), undefined);
  assert.deepEqual(f.active(), ['read', 'bash', 'write', 'codemode', 'subagent']);
}));
test('runtime tree restore uses active branch and invalidates execution after reload', () => fixture(async f => {
  await f.command('on feature'); const planningBranch = structuredClone(f.entries);
  await f.tool('request_plan_review'); f.ctx.mode = 'tui'; await f.command('approve'); await f.command('execute');
  assert.equal(await f.emit('tool_call', { toolName: 'write', input: {} }), undefined);
  await f.emit('session_start'); assert.equal((await f.tool('write')).block, true);
  f.entries.splice(0, f.entries.length, ...planningBranch); await f.emit('session_tree');
  await f.command('status'); assert.match(f.notices.at(-1).text, /"phase": "planning"/);
}));
test('busy agent and noninteractive execution are refused; create stop guard survives restore', () => fixture(async f => {
  f.setIdle(false); await f.command('on unsafe'); assert.match(f.notices.at(-1).text, /finish or interrupt/);
  f.setIdle(true);
  const result = await f.tool('create_artifact', { content: '# Report', title: 'report' });
  assert.ok(result.details.artifactId); assert.equal(result.terminate, true);
  await f.emit('session_start'); assert.equal((await f.tool('read')).block, true);
  await f.emit('input', { text: 'revise', source: 'interactive' });
  assert.equal(await f.emit('tool_call', { toolName: 'read', input: {} }), undefined);
  await f.command(`use ${result.details.artifactId}`); await f.tool('request_plan_review');
  await f.command('approve'); assert.match(f.notices.at(-1).text, /interactive/);
}));
