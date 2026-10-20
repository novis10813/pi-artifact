import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './host.mjs';
const { openReviewUI } = await load('review');
const theme = { fg: (_token, text) => text };
test('review UI actually exports, retains comments and approves with confirmation', async () => {
  const ctx = { ui: { custom: async factory => {
    let result;
    const view = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, value => { result = value; });
    assert.match(view.render(90).join('\n'), /saved comment/);
    view.handleInput('a'); assert.equal(result, undefined); view.handleInput('y'); return result;
  } } };
  const result = await openReviewUI(ctx, { id: 'art_1', title: 'Plan', lines: ['# Plan', 'line'], frontmatterEnd: 0, initialComments: new Map([[1, 'saved comment']]) });
  assert.equal(result.decision, 'approved'); assert.equal(result.lineComments.get(1), 'saved comment');
});
test('review can reject and cancellation does not approve', async () => {
  for (const keys of [['r', '\r'], ['q']]) {
    const ctx = { ui: { custom: async factory => {
      let result;
      const view = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, value => { result = value; });
      for (const key of keys) view.handleInput(key); return result;
    } } };
    const result = await openReviewUI(ctx, { id: 'art_1', title: 'Plan', lines: ['# Plan'], frontmatterEnd: 0, initialComments: new Map() });
    assert.equal(result.decision, keys[0] === 'r' ? 'rejected' : 'abandoned');
  }
});
