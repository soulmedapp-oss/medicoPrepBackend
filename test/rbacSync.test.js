const test = require('node:test');
const assert = require('node:assert/strict');
const Permission = require('../src/models/Permission');
const Role = require('../src/models/Role');
const { syncPermissions } = require('../src/rbac/syncPermissions');
const { ALL_CODES } = require('../src/rbac/permissions');

test('syncPermissions upserts the catalogue, deactivates removed codes and strips them from roles', async () => {
  const calls = { bulk: null, deactivated: null, pulled: null };
  const orig = [Permission.bulkWrite, Permission.find, Permission.updateMany, Role.updateMany];
  Permission.bulkWrite = async (ops) => { calls.bulk = ops; return {}; };
  Permission.find = () => ({ select: () => ({ lean: async () => [{ code: 'CanOldThing' }, { code: ALL_CODES[0] }] }) });
  Permission.updateMany = async (filter, update) => { calls.deactivated = { filter, update }; return {}; };
  Role.updateMany = async (filter, update) => { calls.pulled = { filter, update }; return {}; };
  try {
    const result = await syncPermissions();
    assert.equal(calls.bulk.length, ALL_CODES.length);
    assert.equal(calls.bulk[0].updateOne.upsert, true);
    assert.deepEqual(result.deactivated, ['CanOldThing']);
    assert.deepEqual(calls.deactivated.filter, { code: { $in: ['CanOldThing'] } });
    assert.deepEqual(calls.pulled.update, { $pull: { permissions: { $in: ['CanOldThing'] } } });
  } finally {
    [Permission.bulkWrite, Permission.find, Permission.updateMany, Role.updateMany] = orig;
  }
});
