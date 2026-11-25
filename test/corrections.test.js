// Manual corrections: persistence, upsert, delete-by-empty-text and same-category matching.
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const cds = require('@sap/cds');
const corrections = require('../srv/corrections');

const user = { id: 'alice' };
const other = { id: 'bob' };

before(async () => {
  await cds.deploy('db').to('sqlite::memory:');
});

test('save stores a correction and reads it back by failure', async () => {
  const saved = await corrections.save({ user }, {
    source: 'job', sourceKey: 'run-1', correctionText: '1) Activated scenario\n2) Re-ran the job',
    failure: { objectId: 'Job A', category: 'ISLM', system: 's4.example', errorText: 'Scenario not active' }
  });
  assert.ok(saved.ID);
  assert.equal(saved.createdBy, 'alice');
  assert.equal(saved.category, 'ISLM');

  const read = await corrections.byFailure('job', 'run-1');
  assert.equal(read.correctionText, '1) Activated scenario\n2) Re-ran the job');
  assert.equal(read.system, 's4.example');
});

test('saving again updates instead of duplicating', async () => {
  const saved = await corrections.save({ user: other }, {
    source: 'job', sourceKey: 'run-1', correctionText: 'Second attempt worked'
  });
  const all = await SELECT.from(corrections.ENTITY).where({ source: 'job', sourceKey: 'run-1' });
  assert.equal(all.length, 1);
  assert.equal(saved.correctionText, 'Second attempt worked');
  assert.equal(saved.createdBy, 'alice');
  assert.equal(saved.modifiedBy, 'bob');
  assert.equal(saved.category, 'ISLM', 'metadata from the first save is kept when not supplied');
});

test('empty text deletes the correction', async () => {
  await corrections.save({ user }, { source: 'job', sourceKey: 'run-1', correctionText: '   ' });
  assert.equal(await corrections.byFailure('job', 'run-1'), null);
});

test('same category matches, other categories and sources do not', async () => {
  await corrections.save({ user }, { source: 'idoc', sourceKey: 'idoc-1', correctionText: 'Fix A', failure: { category: 'ORDERS', objectId: 'IDoc 1' } });
  await corrections.save({ user }, { source: 'idoc', sourceKey: 'idoc-2', correctionText: 'Fix B', failure: { category: 'ORDERS', objectId: 'IDoc 2' } });
  await corrections.save({ user }, { source: 'idoc', sourceKey: 'idoc-3', correctionText: 'Fix C', failure: { category: 'INVOIC', objectId: 'IDoc 3' } });

  const matches = await corrections.byCategory('idoc', 'ORDERS', { excludeKey: 'idoc-1' });
  assert.deepEqual(matches.map((row) => row.correctionText), ['Fix B']);

  const self = await corrections.byCategory('idoc', 'ORDERS', { excludeKey: 'idoc-2' });
  assert.deepEqual(self.map((row) => row.correctionText), ['Fix A']);

  assert.deepEqual(await corrections.byCategory('job', 'ORDERS'), []);
  assert.deepEqual(await corrections.byCategory('idoc', ''), []);
});

test('invalid source and missing key are rejected', async () => {
  await assert.rejects(() => corrections.save({ user }, { source: 'mail', sourceKey: 'x', correctionText: 'y' }), /Unsupported source/);
  await assert.rejects(() => corrections.save({ user }, { source: 'job', sourceKey: '  ', correctionText: 'y' }), /failure key is required/);
});

test('clip strips control characters and truncates', () => {
  assert.equal(corrections.clip('a\u0000b', 10), 'a b');
  assert.equal(corrections.clip('x'.repeat(50), 10).length, 10);
  assert.equal(corrections.clip(undefined, 10), '');
});
