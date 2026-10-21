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
  const reviewScripts = [], reviewFrames = [], confirms = [], shortcuts = new Map();
  let active = ['read', 'bash', 'write', 'codemode', 'subagent'], idle = true, confirmation = true;
  const pi = {
    registerTool: tool => { assert.ok(!tools.has(tool.name), `Duplicate tool: ${tool.name}`); tools.set(tool.name, tool); },
    registerCommand: (name, spec) => { assert.ok(!commands.has(name), `Duplicate command: ${name}`); commands.set(name, spec); },
    registerShortcut: (key, spec) => { assert.ok(!shortcuts.has(key), `Duplicate shortcut: ${key}`); shortcuts.set(key, spec); },
    on: (name, handler) => { const values = events.get(name) ?? []; values.push(handler); events.set(name, values); },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data: structuredClone(data) }),
    getActiveTools: () => active.slice(), setActiveTools: next => { active = next; },
    sendUserMessage: content => messages.push(content),
  };
  const ctx = { cwd, mode: 'print', hasUI: true, isIdle: () => idle,
    sessionManager: { getBranch: () => entries.slice() },
    ui: { notify: (text, type) => notices.push({ text, type }), setStatus: (k, v) => v === undefined ? statuses.delete(k) : statuses.set(k, v),
      getEditorComponent: () => undefined, setEditorComponent: () => { throw Error('no viewport'); },
      confirm: async (...args) => { confirms.push(args); return typeof confirmation === 'function' ? confirmation(...args) : confirmation; }, select: async () => undefined,
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
    reviewScripts, reviewFrames, confirms, shortcuts, store: new ArtifactStore(cwd), active: () => active, setIdle: value => { idle = value; }, setConfirm: value => { confirmation = value; } }); }
  finally { await emit('session_shutdown', { reason: 'quit' }); await rm(cwd, { recursive: true, force: true }); }
}
const last = f => f.notices.at(-1).text;
test('registers each artifact tool, command and shortcut exactly once', () => fixture(async f => {
  assert.deepEqual([...f.tools.keys()].sort(), ['create_artifact', 'edit_artifact', 'read_artifact', 'replace_artifact', 'request_plan_review']);
  assert.deepEqual([...f.commands.keys()].sort(), ['artifact', 'plan', 'plan-pane']);
  assert.deepEqual([...f.shortcuts.keys()], ['f7']);
}));
test('/plan review requests revision-bound subagent review in chat; legacy line comments remain compatible', () => fixture(async f => {
  const a = await f.store.create('# Context\n\nsecond line', 'Review');
  const line = a.content.split('\n').indexOf('# Context') + 2;
  await f.store.review(a.record.id, a.revision, 'rejected', '', [{ line, comment: 'keep this comment' }]);
  await f.command(`use ${a.record.id}`); f.ctx.mode = 'tui';
  await f.command('review');
  assert.equal(f.reviewFrames.length, 0, 'no manual line-review UI'); assert.match(last(f), /已提交 rev .*subagent 審查。審查不是執行授權/);
  const request = f.messages.at(-1);
  assert.match(request, /call subagent directly now, in foreground/);
  assert.ok(request.includes(join(f.cwd, '.pi/artifacts/revisions', a.record.id, `${a.revision}.md`)));
  assert.match(request, /NOT a Plan Mode tool restriction/); assert.match(request, /If it changed, label the result stale/);
  assert.equal(await f.emit('tool_call', { toolName: 'subagent', input: { agent: 'spec-reviewer', task: request } }), undefined);
  assert.equal((await f.tool('write')).block, true);
  f.reviewScripts.push(['a', 'y']); await f.commands.get('artifact').handler(`review ${a.record.id}`, f.ctx);
  assert.equal(f.reviewFrames.length, 1); assert.match(last(f), /does not change Plan Mode or authorize/);
  assert.equal((await f.store.readReview(a.record.id, a.revision)).lineComments[0].comment, 'keep this comment');
  assert.equal((await f.tool('write')).block, true);
}));
test('/plan review reports unavailable subagent and clears a prior create stop guard when available', () => fixture(async f => {
  await f.command('feature');
  f.active().splice(f.active().indexOf('subagent'), 1);
  const count = f.messages.length;
  await f.command('review'); assert.match(last(f), /subagent 工具未啟用.*略過審查/); assert.equal(f.messages.length, count);
  f.active().push('subagent');
  await f.tool('create_artifact', { content: '# Revised' });
  assert.equal((await f.tool('read')).block, true, 'create stop guard is armed');
  await f.command('review'); assert.match(f.messages.at(-1), /Plan review requested:/);
  assert.equal(await f.emit('tool_call', { toolName: 'subagent', input: {} }), undefined, 'review clears the stop guard');
  await f.tool('edit_artifact', { artifactId: (await f.store.list())[0].id, edits: [{ oldText: 'Revised', newText: 'After review' }] });
  await f.command('status'); assert.match(last(f), /PLAN planning/); assert.equal((await f.tool('write')).block, true);
}));
test('runtime registers historical schemas plus read/replace/submit, updates same plan and keeps review open', () => fixture(async f => {
  assert.deepEqual(Object.keys(f.tools.get('create_artifact').parameters.properties), ['content', 'title']);
  assert.deepEqual(Object.keys(f.tools.get('edit_artifact').parameters.properties), ['artifactId', 'edits']);
  await f.command('implement user feature');
  const [a] = await f.store.list(); assert.ok(a); assert.ok(f.messages.at(-1).includes(a.id));
  assert.match((await f.store.read(a.id)).content, /## Goal\nimplement user feature/); assert.match(last(f), /已開始規劃.*尚未允許實作/);
  assert.ok(!f.active().includes('codemode')); assert.ok(f.active().includes('subagent'));
  assert.match(last(f), /子代理權限未受 Plan Mode 限制/);
  const before = await f.tool('read_artifact', { artifactId: a.id }); assert.match(before.content[0].text, /Goal/);
  const originalRevision = (await f.store.read(a.id)).revision;
  assert.ok(before.content[0].text.includes(`Revision: ${originalRevision}`));
  await assert.rejects(f.tool('read_artifact', { artifactId: a.id, revision: '' }), /Invalid revision reference/);
  await f.tool('edit_artifact', { artifactId: a.id, edits: [{ oldText: '## Approach', newText: '## Chosen approach' }] });
  assert.match((await f.store.read(a.id)).content, /Chosen approach/);
  const historical = await f.tool('read_artifact', { artifactId: a.id, revision: originalRevision });
  assert.ok(historical.content[0].text.includes(`Revision: ${originalRevision}`)); assert.doesNotMatch(historical.content[0].text, /Chosen approach/);
  const changed = await f.tool('read_artifact', { artifactId: a.id });
  assert.ok(changed.content[0].text.includes(`Revision: ${(await f.store.read(a.id)).revision}`));
  await f.tool('create_artifact', { content: '# Revised same plan' });
  assert.equal((await f.store.list()).length, 1);
  assert.match((await f.store.read(a.id)).content, /Revised same plan/);
  assert.equal((await f.tool('bash', { command: 'touch forbidden' })).block, true);
  await f.emit('input', { text: 'looks good', source: 'interactive' });
  assert.equal((await f.tool('write', { path: 'bad' })).block, true);
  const submitted = await f.tool('request_plan_review');
  assert.equal(submitted.terminate, true); assert.match(submitted.content[0].text, /\/plan approve to approve and start/); assert.doesNotMatch(submitted.content[0].text, /execute/);
  const blocked = await f.tool('write'); assert.equal(blocked.block, true); assert.equal(blocked.terminate, undefined, 'review does not lock follow-up turns');
  assert.equal(await f.emit('tool_call', { toolName: 'ask_user_question', input: {} }), undefined);
  await f.tool('edit_artifact', { artifactId: a.id, edits: [{ oldText: 'Revised', newText: 'Re-revised' }] });
  await f.command('status'); assert.match(last(f), /PLAN planning/);
}));
test('approve confirms once, rechecks the revision, and cannot be bypassed by chat or generic review', () => fixture(async f => {
  await f.command('feature'); const [a] = await f.store.list();
  await f.store.review(a.id, (await f.store.read(a.id)).revision, 'approved');
  f.ctx.mode = 'tui';
  await f.command('execute'); assert.match(last(f), /\/plan execute 已移除.*\/plan approve/);
  await f.command('on another'); assert.match(last(f), /\/plan on 已移除.*\/plan <目標>/);
  await f.emit('input', { text: 'approved go implement it', source: 'interactive' });
  assert.equal((await f.tool('bash')).block, true);
  f.setConfirm(false); await f.command('approve'); assert.match(last(f), /已取消核准.*尚未允許實作/); assert.equal((await f.tool('write')).block, true);
  f.setConfirm(async () => { const c = await f.store.read(a.id); await writeFile(join(f.cwd, a.path), c.content + '\nchanged during dialog'); return true; });
  await f.command('approve'); assert.match(last(f), /確認期間已變更/); assert.equal((await f.tool('write')).block, true);
  f.setConfirm(true); await f.command('approve');
  const [title, body] = f.confirms.at(-1); assert.match(title, /核准並開始實作/); assert.match(body, /寫入.*shell.*委派/);
  assert.match(last(f), /已核准 rev .*開始實作/);
  assert.equal(await f.emit('tool_call', { toolName: 'write', input: {} }), undefined);
  assert.ok(f.active().includes('codemode')); assert.match(f.messages.at(-1), /exact revision/);
  await f.command('approve'); assert.match(last(f), /已在實作中/);
  const current = await f.store.read(a.id);
  await writeFile(join(f.cwd, a.path), current.content + '\nexternal change');
  assert.equal((await f.emit('tool_call', { toolName: 'write', input: {} })).block, true);
  assert.ok(!f.active().includes('bash'));
}));
test('runtime user shell and nested call hooks enforce policy; off is explicit and restores tools', () => fixture(async f => {
  await f.command('off'); assert.match(last(f), /目前不在 Plan Mode/);
  await f.command('feature');
  const shell = await f.emit('user_bash', { command: 'rm -rf target' });
  assert.equal(shell.result.exitCode, 1); assert.match(shell.result.output, /blocks bash/);
  const nested = await f.emit('tool_call', { toolName: 'write', input: {}, parentToolCallId: 'wrapper' });
  assert.equal(nested.block, true);
  f.setConfirm(false); await f.command('off'); assert.match(last(f), /已取消，仍在 Plan Mode/); assert.equal((await f.tool('bash')).block, true);
  f.setConfirm(true); await f.command('off'); assert.match(last(f), /已退出 Plan Mode，已恢復原本的工具權限/);
  assert.equal(await f.emit('tool_call', { toolName: 'bash', input: {} }), undefined);
  assert.deepEqual(f.active(), ['read', 'bash', 'write', 'codemode', 'subagent']);
}));
test('runtime tree restore uses active branch and invalidates execution after reload', () => fixture(async f => {
  await f.command('feature'); const planningBranch = structuredClone(f.entries);
  f.ctx.mode = 'tui'; await f.command('approve');
  assert.equal(await f.emit('tool_call', { toolName: 'write', input: {} }), undefined);
  await f.emit('session_start'); assert.equal((await f.tool('write')).block, true);
  await f.command('status'); assert.match(last(f), /PLAN review .*尚未允許實作/);
  f.entries.splice(0, f.entries.length, ...planningBranch); await f.emit('session_tree');
  await f.command('status'); assert.match(last(f), /PLAN planning/);
}));
test('revise and done give explicit feedback without granting execution', () => fixture(async f => {
  await f.command('revise'); assert.match(last(f), /沒有進行中的計畫.*\/plan <目標>/);
  await f.command('feature'); f.ctx.mode = 'tui'; await f.command('approve');
  await f.command('revise'); assert.equal(last(f), '已回到規劃模式，可以繼續提問與修改計畫；尚未允許實作');
  assert.equal((await f.tool('write')).block, true);
  await f.command('done'); assert.match(last(f), /沒有正在實作的計畫/);
  await f.command('approve'); await f.command('done'); assert.match(last(f), /已標記完成/); assert.equal((await f.tool('write')).block, true);
  const donePlan = await f.store.read((await f.store.list())[0].id);
  await assert.rejects(f.tool('create_artifact', { content: '# Must not replace a finished plan' }), /計畫已完成.*\/plan revise/);
  assert.deepEqual(await f.store.read(donePlan.record.id), donePlan, 'done create rejection must not write content or revision');
  assert.ok(!f.active().includes('subagent'));
  assert.equal((await f.emit('tool_call', { toolName: 'subagent', input: {} })).block, true);
  await f.command('review'); assert.match(last(f), /計畫已完成.*\/plan revise/);
  await f.command('approve'); assert.match(last(f), /計畫已完成.*\/plan revise/); assert.equal((await f.tool('write')).block, true);
  await f.command('revise'); await f.command('approve');
  await assert.rejects(f.tool('create_artifact', { content: '# hijack' }), /實作進行中/);
  assert.match((await f.store.read((await f.store.list())[0].id)).content, /Goal/);
}));
test('corrupt plan state: off reports tools were not restored; goal start names the corrupt state', () => fixture(async f => {
  f.entries.push({ type: 'custom', customType: 'pi-artifact:plan:v1', data: 'bad' }); await f.emit('session_start');
  await f.command('new goal'); assert.match(last(f), /狀態損毀.*\/plan off/);
  await f.command('off'); assert.match(last(f), /工具未還原.*\/reload/); assert.equal(f.notices.at(-1).type, 'warning');
}));
test('bare /plan shows usage only; reserved words in goal text start a plan; completions are phase-aware', () => fixture(async f => {
  const complete = prefix => f.commands.get('plan').getArgumentCompletions(prefix);
  assert.match(f.commands.get('plan').description, /\/plan <目標>.*approve 核准並執行/);
  await f.command(''); assert.match(last(f), /未在 Plan Mode[\s\S]*\/plan <目標>[\s\S]*approve.*核准.*不可用：沒有進行中的計畫/);
  assert.equal((await f.store.list()).length, 0, 'bare /plan creates nothing');
  const names = complete('').map(i => i.value);
  assert.deepEqual(names, ['status', 'show', 'review', 'approve', 'revise', 'done', 'off', 'use']);
  assert.ok(!names.includes('execute') && !names.includes('on'));
  assert.deepEqual(complete('re').map(i => i.value), ['review', 'revise']);
  assert.match(complete('ap')[0].description, /目前不可用：沒有進行中的計畫/);
  assert.equal(complete('fix the'), null, 'free goal text is not intercepted'); assert.equal(complete('zzz'), null);
  await f.command('review the auth module');
  const [a] = await f.store.list(); assert.match((await f.store.read(a.id)).content, /## Goal\nreview the auth module/);
  assert.doesNotMatch(complete('ap')[0].description, /不可用/);
  assert.match(complete('done')[0].description, /不可用：沒有正在實作/);
  await f.command('another goal'); assert.match(last(f), /已有進行中的計畫.*\/plan off/);
  await f.command('use'); assert.match(last(f), /用法：\/plan use/);
}));
test('busy agent and noninteractive execution are refused; create stop guard survives restore', () => fixture(async f => {
  f.setIdle(false); await f.command('unsafe'); assert.match(last(f), /模型仍在回應/);
  f.setIdle(true);
  const result = await f.tool('create_artifact', { content: '# Report', title: 'report' });
  assert.ok(result.details.artifactId); assert.equal(result.terminate, true);
  await f.emit('session_start'); assert.equal((await f.tool('read')).block, true);
  await f.emit('input', { text: 'revise', source: 'interactive' });
  assert.equal(await f.emit('tool_call', { toolName: 'read', input: {} }), undefined);
  await f.command(`use ${result.details.artifactId}`); await f.tool('request_plan_review');
  await f.command('approve'); assert.match(last(f), /互動式確認/);
}));
