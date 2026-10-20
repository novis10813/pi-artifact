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
test('approve grants execution for the exact revision in one step; review is optional', () => fixture(async ({ plan, a, store }) => {
  await plan.enter(a.record.id, ['read', 'bash']);
  assert.ok(await plan.block('bash', {}));
  await assert.rejects(plan.approve('0'.repeat(64)), /已變更/); assert.equal(plan.state.phase, 'planning');
  await plan.approve(a.revision);
  assert.equal(plan.state.phase, 'executing'); assert.equal(plan.state.approval.revision, a.revision);
  assert.equal(await plan.block('write', {}), undefined);
  await assert.rejects(plan.approve(a.revision), /已在實作/); await assert.rejects(plan.submit(), /實作進行中/);
  plan.finish(); assert.ok(await plan.block('write', {})); await assert.rejects(plan.approve(a.revision), /計畫已完成/); await assert.rejects(plan.submit(), /計畫已完成/);
  assert.throws(() => plan.finish(), /已標記完成.*\/plan revise/);
  const edited = await store.update(a.record.id, c => c + '\nafter done');
  await assert.rejects(plan.approve(edited.revision), /計畫已完成/); await assert.rejects(plan.submit(), /計畫已完成/); assert.equal(plan.state.phase, 'done');
  await plan.revise(); await plan.approve(edited.revision); assert.equal(plan.state.phase, 'executing'); plan.finish();
  assert.deepEqual(plan.off(), ['read', 'bash']); assert.equal(await plan.block('bash', {}), undefined);
  await plan.enter(a.record.id, []); await plan.submit(); await plan.approve(plan.state.revision); assert.equal(plan.state.phase, 'executing');
}));
test('fail-closed planning policy blocks nested wrappers, delegation, shell, background and unknown tools', () => fixture(async ({ plan, a }) => {
  await plan.enter(a.record.id, []);
  for (const tool of ['bash', 'powershell', 'write', 'edit', 'codemode', 'workflow', 'subagent', 'spawn_background', 'mcp__server__unknown', 'imagegen']) assert.match(await plan.block(tool, {}), /blocks.*\/plan approve/);
  for (const tool of ['read', 'grep', 'web_search', 'read_artifact', 'TaskList', 'set_verify']) assert.equal(await plan.block(tool, {}), undefined);
  assert.match(await plan.block('edit_artifact', { artifactId: 'art_other' }), /only its active/);
  assert.match(await plan.block('edit_artifact', { artifactId: a.record.id }, true), /Unsaved/);
}));
test('review keeps Q&A and revisions open; an edit returns to planning; generic approval grants nothing', () => fixture(async ({ plan, a, store }) => {
  await plan.enter(a.record.id, []); await store.review(a.record.id, a.revision, 'approved');
  assert.equal(plan.state.phase, 'planning');
  await plan.submit(); assert.equal(plan.state.phase, 'review');
  for (const tool of ['ask_user_question', 'grep', 'web_search', 'TaskCreate', 'edit_artifact']) assert.equal(await plan.block(tool, { artifactId: a.record.id }), undefined, tool);
  assert.ok(await plan.block('write', {}));
  await store.update(a.record.id, c => c + '\nrevised during review');
  assert.equal(await plan.block('read', {}), undefined); assert.equal(plan.state.phase, 'planning');
  await assert.rejects(plan.approve(a.revision), /已變更/);
  assert.match(plan.prompt(), /only the user's \/plan approve/i); assert.doesNotMatch(plan.prompt(), /execute/);
}));
test('disk changes and unsaved manual edits revoke permission before next tool', () => fixture(async ({ plan, a, cwd }) => {
  await plan.enter(a.record.id, []); await plan.approve(a.revision);
  await writeFile(join(cwd, a.record.path), a.content + '\nnew');
  assert.ok(await plan.block('write', {})); assert.equal(plan.state.phase, 'planning'); assert.equal(plan.state.approval, undefined);
  await plan.approve(plan.state.revision);
  assert.ok(await plan.block('write', {}, true)); assert.equal(plan.state.phase, 'planning');
}));
test('branch reconstruction never auto-resumes execution, including old persisted approved state', () => fixture(async ({ plan, a, store, entries }) => {
  await plan.enter(a.record.id, ['read', 'bash']); const planning = structuredClone(entries);
  await plan.approve(a.revision);
  const resumed = new PlanController(store, () => {}); resumed.restore(entries);
  assert.equal(resumed.state.phase, 'review'); assert.equal(resumed.state.approval, undefined); assert.ok(await resumed.block('write', {}));
  const legacy = { ...entries.at(-1).data, phase: 'approved' };
  resumed.restore([{ type: 'custom', customType: PLAN_ENTRY, data: legacy }]);
  assert.equal(resumed.state.phase, 'review'); assert.ok(await resumed.block('write', {}));
  resumed.restore(planning); assert.equal(resumed.state.phase, 'planning');
  const changed = await store.update(a.record.id, c => c + '\nbranch B');
  await resumed.sync(); assert.equal(resumed.state.revision, changed.revision);
  assert.equal(await store.revision(a.record.id, a.revision), a.content);
}));
test('malformed latest state never revives an execution grant; unreadable plan locks tools', () => fixture(async ({ plan, a, entries, cwd }) => {
  await plan.enter(a.record.id, []); await plan.approve(a.revision);
  plan.restore([...entries, { type: 'custom', customType: PLAN_ENTRY, data: { v: 1, phase: 'executing' } }]);
  assert.ok(await plan.block('write', {}));
  plan.off(); plan.restore([{ type: 'custom', customType: PLAN_ENTRY, data: 'bad' }]);
  assert.ok(await plan.block('bash', {})); plan.off();
  await plan.enter(a.record.id, []); await plan.approve(a.revision);
  await rm(join(cwd, a.record.path)); assert.match(await plan.block('write', {}), /unreadable/);
  assert.equal(plan.state.approval, undefined);
}));
test('persist failure cannot unlock execution', () => fixture(async ({ store, a }) => {
  let fail = false;
  const plan = new PlanController(store, () => { if (fail) throw Error('disk full'); });
  await plan.enter(a.record.id, []); fail = true;
  await assert.rejects(plan.approve(a.revision), /disk full/); assert.equal(plan.state.phase, 'planning');
  assert.ok(await plan.block('write', {}));
}));
