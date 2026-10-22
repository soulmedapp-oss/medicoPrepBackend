const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseOptions } = require('../src/utils/databaseConfig');
const { devBuildInfo } = require('../src/utils/devBuildInfo');

test('explicit app database overrides URI database while legacy local configuration remains supported', () => {
  assert.deepEqual(databaseOptions({ APP_DB_NAME: 'test_database' }), { dbName: 'test_database' });
  assert.deepEqual(databaseOptions({}), {});
  assert.deepEqual(databaseOptions({ APP_DB_NAME: '' }), {});
  assert.throws(() => databaseOptions({ APP_DB_NAME: 'mongodb://private/db' }), /database name/);
});
test('dev badge uses the actual connected name and never returns credentials', () => {
  const result = devBuildInfo({ readyState: 1, name: 'actual_db', host: 'private-host' }, { APP_ENV: 'dev' });
  assert.deepEqual(result, { status: 200, body: { environment: 'dev', database: 'actual_db' } });
});
for (const env of ['qa', 'uat', 'prod', '', undefined]) {
  test(`build information is absent in ${env || 'unset environment'}`, () => {
    assert.equal(devBuildInfo({ readyState: 1, name: 'private_db' }, { APP_ENV: env }).status, 404);
  });
}
test('dev information does not pretend a disconnected database is ready', () => {
  assert.equal(devBuildInfo({ readyState: 0, name: 'old_db' }, { APP_ENV: 'dev' }).status, 503);
});
