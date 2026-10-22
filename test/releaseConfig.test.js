const test = require('node:test');
const assert = require('node:assert/strict');
const { check } = require('../scripts/check-release-config.cjs');
const env = { DEPLOY_ENVIRONMENT: 'prod', DEPLOY_REF: 'refs/heads/main', AWS_ACCOUNT_ID: '986518320302', AWS_REGION: 'ap-south-1', ECR_REPOSITORY: 'soulmed-prod-backend', AWS_RELEASE_ROLE_ARN: 'arn:aws:iam::986518320302:role/soulmed-prod-backend-release', ECS_CLUSTER: 'soulmed-prod-backend', ECS_API_SERVICE: 'soulmed-prod-backend', ECS_TUTOR_SERVICE: 'soulmed-prod-backend-tutor', ECS_MAINTENANCE_SERVICE: 'soulmed-prod-backend-maintenance', HEALTH_URL: 'https://example.cloudfront.net/api/ready' };
test('production release accepts matching main targets', () => check(env));
test('production rejects feature branches and dev targets', () => {
  for (const extra of [{ DEPLOY_REF: 'refs/heads/feature/test' }, { ECS_CLUSTER: 'soulmed-dev-backend' }, { ECR_REPOSITORY: 'soulmed-dev-backend' }, { AWS_RELEASE_ROLE_ARN: 'arn:aws:iam::986518320302:role/soulmed-dev-backend-release' }]) assert.throws(() => check({ ...env, ...extra }));
});
test('bootstrap build requires no running ECS services', () => { const v = { ...env }; delete v.ECS_CLUSTER; delete v.HEALTH_URL; check(v, true); assert.throws(() => check(v)); });
