import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from './host.mjs';
const { ArtifactStore } = await load('store');
const { PlanController, PLAN_ENTRY } = await load('plan');
async function fixture(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-plan-'));
  const store = new ArtifactStore(cwd), entries = [];
  const plan = new PlanController(store, data => entries.push({ type: 'custom', customType: PLAN_ENTRY, data }));
  try { const a = await store.create('# Plan'); await fn({ cwd, store, entries, plan, a }); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}
test('only submitted exact revision can be approved and explicit execution is separate', () => fixture(async ({ plan, a }) => {
  await plan.enter(a.record.id, ['read', 'bash']);
  assert.ok(await plan.block('bash', {}));
  await assert.rejects(plan.approve(a.revision)); await assert.rejects(plan.execute(a.revision));
  await plan.submit(); await plan.approve(a.revision);
  assert.equal(plan.state.phase, 'approved'); assert.ok(await plan.block('write', {}));
  await plan.execute(a.revision); assert.equal(await plan.block('write', {}), undefined);
  plan.finish(); assert.ok(await plan.block('write', {}));
  assert.deepEqual(plan.off(), ['read', 'bash']); assert.equal(await plan.block('bash', {}), undefined);
}));
test('fail-closed planning policy blocks nested wrappers, delegation, shell, background and unknown tools', () => fixture(async ({ plan, a }) => {
  await plan.enter(a.record.id, []);
  for (const tool of ['bash', 'powershell', 'write', 'edit', 'codemode', 'workflow', 'subagent', 'spawn_background', 'mcp__server__unknown', 'imagegen']) assert.match(await plan.block(tool, {}), /blocks/);
  for (const tool of ['read', 'grep', 'web_search', 'read_artifact', 'TaskList', 'set_verify']) assert.equal(await plan.block(tool, {}), undefined);
  assert.match(await plan.block('edit_artifact', { artifactId: 'art_other' }), /only its active/);
  assert.match(await plan.block('edit_artifact', { artifactId: a.record.id }, true), /Unsaved/);
}));
test('generic approval does not grant Plan execution and arbitrary input has no authority', () => fixture(async ({ plan, a, store }) => {
  await plan.enter(a.record.id, []); await store.review(a.record.id, a.revision, 'approved');
  assert.equal(plan.state.phase, 'planning'); await assert.rejects(plan.execute(a.revision));
  await plan.submit(); assert.ok(await plan.block('ask_user_question', {}));
  assert.match(plan.prompt(), /only user \/plan approve/i);
}));
test('disk changes and unsaved manual edits revoke permission before next tool', () => fixture(async ({ plan, a, store, cwd }) => {
  await plan.enter(a.record.id, []); await plan.submit(); await plan.approve(a.revision); await plan.execute(a.revision);
  await writeFile(join(cwd, a.record.path), a.content + '\nnew');
  assert.ok(await plan.block('write', {})); assert.equal(plan.state.phase, 'planning'); assert.equal(plan.state.approval, undefined);
  await plan.submit(); await plan.approve(plan.state.revision); await plan.execute(plan.state.revision);
  assert.ok(await plan.block('write', {}, true)); assert.equal(plan.state.phase, 'planning');
}));
test('branch reconstruction ignores abandoned entries and never auto-resumes execution', () => fixture(async ({ plan, a, store, entries }) => {
  await plan.enter(a.record.id, ['read', 'bash']); const planning = structuredClone(entries);
  await plan.submit(); await plan.approve(a.revision); await plan.execute(a.revision);
  const resumed = new PlanController(store, () => {}); resumed.restore(entries);
  assert.equal(resumed.state.phase, 'approved'); assert.ok(await resumed.block('write', {}));
  resumed.restore(planning); assert.equal(resumed.state.phase, 'planning');
  const changed = await store.update(a.record.id, c => c + '\nbranch B');
  await resumed.sync(); assert.equal(resumed.state.revision, changed.revision);
  assert.equal(await store.revision(a.record.id, a.revision), a.content);
}));
test('malformed latest state never revives an execution grant; unreadable plan locks tools', () => fixture(async ({ plan, a, entries, cwd }) => {
  await plan.enter(a.record.id, []); await plan.submit(); await plan.approve(a.revision); await plan.execute(a.revision);
  plan.restore([...entries, { type: 'custom', customType: PLAN_ENTRY, data: { v: 1, phase: 'executing' } }]);
  assert.ok(await plan.block('write', {}));
  plan.off(); plan.restore([{ type: 'custom', customType: PLAN_ENTRY, data: 'bad' }]);
  assert.ok(await plan.block('bash', {})); plan.off();
  await plan.enter(a.record.id, []); await plan.submit(); await plan.approve(a.revision); await plan.execute(a.revision);
  await rm(join(cwd, a.record.path)); assert.match(await plan.block('write', {}), /unreadable/);
  assert.equal(plan.state.approval, undefined);
}));
test('persist failure cannot unlock execution', () => fixture(async ({ store, a }) => {
  let fail = false;
  const plan = new PlanController(store, () => { if (fail) throw Error('disk full'); });
  await plan.enter(a.record.id, []); await plan.submit(); await plan.approve(a.revision); fail = true;
  await assert.rejects(plan.execute(a.revision), /disk full/); assert.equal(plan.state.phase, 'approved');
  assert.ok(await plan.block('write', {}));
}));
