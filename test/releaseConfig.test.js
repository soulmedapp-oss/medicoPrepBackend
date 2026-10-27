const test = require('node:test');
const assert = require('node:assert/strict');
const { check } = require('../scripts/check-release-config.cjs');
const env = { DEPLOY_ENVIRONMENT: 'prod', DEPLOY_REF: 'refs/heads/main', AWS_ACCOUNT_ID: '986518320302', AWS_REGION: 'ap-south-1', ECR_REPOSITORY: 'soulmed-prod-backend', AWS_RELEASE_ROLE_ARN: 'arn:aws:iam::986518320302:role/soulmed-prod-backend-release', ECS_CLUSTER: 'soulmed-prod-backend', ECS_API_SERVICE: 'soulmed-prod-backend', ECS_TUTOR_SERVICE: 'soulmed-prod-backend-tutor', ECS_MAINTENANCE_SERVICE: 'soulmed-prod-backend-maintenance', HEALTH_URL: 'https://example.cloudfront.net/api/ready' };
test('production publishes on main but cannot deploy to retired targets', () => { check(env, true); assert.throws(() => check(env), /infrastructure/); });
test('production rejects feature branches and dev targets', () => {
  for (const extra of [{ DEPLOY_REF: 'refs/heads/feature/test' }, { ECS_CLUSTER: 'soulmed-dev-backend' }, { ECR_REPOSITORY: 'soulmed-dev-backend' }, { AWS_RELEASE_ROLE_ARN: 'arn:aws:iam::986518320302:role/soulmed-dev-backend-release' }]) assert.throws(() => check({ ...env, ...extra }));
});
test('bootstrap build requires no running ECS services', () => { const v = { ...env }; delete v.ECS_CLUSTER; delete v.HEALTH_URL; check(v, true); assert.throws(() => check(v)); });

test('nonproduction still validates service targets and health URLs', () => {
  const dev = Object.fromEntries(Object.entries(env).map(([key,value]) => [key, value.replaceAll('prod', 'dev')]));
  check(dev);
  for (const url of ['https://soulmed.ai/api/ready', 'http://example.cloudfront.net/api/ready', 'https://soulmed.ai.evil.example/api/ready']) assert.throws(() => check({ ...dev, HEALTH_URL: url }));
  assert.throws(() => check({ ...dev, ECS_CLUSTER: 'soulmed-prod-backend' }));
});

test('legacy deploy script rejects production before accessing AWS', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const bash = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe') : 'bash';
  for (const extra of [{ DEPLOY_ENVIRONMENT: 'prod' }, { DEPLOY_ENVIRONMENT: 'uat', ECS_CLUSTER: 'soulmed-prod-backend' }]) {
    const result = spawnSync(bash, ['--noprofile', '--norc', path.join(__dirname, '../scripts/release-ecs.sh')], { encoding: 'utf8', env: { ...process.env, ECS_SERVICES: '', RELEASE_IMAGE: '', ...extra } });
    assert.equal(result.status, 1); assert.match(result.stderr, /infrastructure release workflow/);
  }
});
