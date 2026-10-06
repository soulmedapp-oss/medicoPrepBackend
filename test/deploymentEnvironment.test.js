const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { normalizeEnvironment, uploadsBucket, logDirectory } = require('../src/lib/deploymentEnvironment');
const { sharedBucket, uploadsPrefix } = require('../src/lib/deploymentEnvironment');

test('shared environment bucket wins over old bucket overrides', () => {
  const env = { APP_ENV: 'dev 2', AWS_ACCOUNT_ID: '123456789012', UPLOADS_S3_BUCKET: 'old-uploads' };
  assert.equal(sharedBucket(env), 'soulmed-dev2-123456789012');
  assert.equal(uploadsBucket(env), 'soulmed-dev2-123456789012');
  assert.equal(uploadsPrefix(env), 'soulmed-dev2-uploads-question');
  assert.equal(sharedBucket({ APP_ENV: 'uat', S3_BUCKET: 'my-{env}-bucket' }), 'my-uat-bucket');
  assert.throws(() => sharedBucket({ APP_ENV: 'dev', S3_BUCKET: 'soulmed-{env}-{account_id}' }));
  assert.throws(() => sharedBucket({ AWS_ACCOUNT_ID: '123456789012' }));
  assert.throws(() => sharedBucket({ APP_ENV: 'dev', AWS_ACCOUNT_ID: 'invalid' }));
});

test('shared upload URL and readback retain the service prefix', async () => {
  const { createUploadStorage, uploadKeyFromUrl } = require('../src/lib/uploadStorage');
  const sent = [];
  class Command { constructor(input) { this.input = input; } }
  const store = createUploadStorage({ bucket: 'soulmed-dev-123456789012', region: 'ap-south-1', prefix: 'soulmed-dev-uploads-question',
    s3Client: { send: async (command) => { sent.push(command.input); return {}; } }, PutObjectCommand: Command, isInlineSafeExtension: () => true });
  const url = await store.storeUpload({ buffer: Buffer.from('test'), originalname: 'question.png' }, { ext: 'png', contentType: 'image/png' }, 'questions');
  assert.match(sent[0].Key, /^soulmed-dev-uploads-question\/questions\//);
  assert.equal(uploadKeyFromUrl(url, store.config, 'questions'), sent[0].Key);
  assert.equal(uploadKeyFromUrl(url.replace('soulmed-dev-uploads-question/', 'soulmed-dev-ai-ingest/'), store.config, 'questions'), null);
});

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
