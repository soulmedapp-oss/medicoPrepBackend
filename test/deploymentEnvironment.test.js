const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { normalizeEnvironment, uploadsBucket, logDirectory } = require('../src/lib/deploymentEnvironment');

test('environment names and aliases select distinct buckets', () => {
  for (const [input, expected] of [['local', 'dev'], ['development', 'dev'], ['uat', 'uat'], ['prod', 'production'], ['dev 2', 'dev2']]) {
    assert.equal(normalizeEnvironment(input), expected);
    assert.equal(uploadsBucket({ APP_ENV: input }), `soulmed-${expected}-uploads-thumbnails`);
  }
});
test('legacy explicit buckets are preserved and templates support globally unique suffixes', () => {
  assert.equal(uploadsBucket({}), '');
  assert.equal(uploadsBucket({ APP_ENV: 'uat', UPLOADS_S3_BUCKET: 'existing-uploads' }), 'existing-uploads');
  assert.equal(uploadsBucket({ APP_ENV: 'dev2', UPLOADS_S3_BUCKET: 'soulmed-{env}-uploads-123' }), 'soulmed-dev2-uploads-123');
  assert.throws(() => uploadsBucket({ UPLOADS_S3_BUCKET: 'soulmed-{env}-uploads' }));
});
test('invalid environments cannot escape log folders', () => {
  for (const input of ['../prod', 'dev/prod', 'dev\\prod', '.', 'a'.repeat(31)]) assert.throws(() => normalizeEnvironment(input));
  assert.equal(logDirectory({ LOG_DIR: 'logs', APP_ENV: 'dev 2' }), path.join('logs', 'dev2', 'backend'));
  assert.equal(logDirectory({ LOG_DIR: 'logs' }), 'logs');
  assert.equal(logDirectory({ APP_ENV: 'dev' }), '');
});

test('logger writes environment-separated files and redacts secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soulmed-env-log-'));
  try {
    const env = { ...process.env, APP_ENV: 'dev 2', LOG_DIR: root, LOG_FILE_PREFIX: 'server', NODE_ENV: 'production', LOG_LEVEL: 'info' };
    delete env.NODE_TEST_CONTEXT;
    delete env.AWS_LAMBDA_FUNCTION_NAME;
    const result = spawnSync(process.execPath, ['-e', "const {logger}=require('./src/lib/logger'); logger.error({user:{password:'TEST_SECRET'}}, 'environment-log-probe'); logger.flush();"], { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const dir = path.join(root, 'dev2', 'backend');
    const text = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
    assert.match(text, /environment-log-probe/);
    assert.match(text, /"env":"dev2"/);
    assert.doesNotMatch(text, /TEST_SECRET/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
