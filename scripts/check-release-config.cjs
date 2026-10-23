const assert = require('node:assert/strict');
function check(env, buildOnly = false) {
  const target = env.DEPLOY_ENVIRONMENT;
  assert.ok(['dev', 'qa', 'uat', 'prod'].includes(target), 'Select an environment');
  assert.ok((env.DEPLOY_REF || '').startsWith('refs/heads/'), 'Select a branch');
  if (['uat', 'prod'].includes(target)) assert.equal(env.DEPLOY_REF, 'refs/heads/main', 'Production and UAT require main');
  const account = env.AWS_ACCOUNT_ID;
  assert.match(account || '', /^[0-9]{12}$/, 'Set AWS_ACCOUNT_ID');
  assert.equal(env.AWS_REGION, 'ap-south-1');
  const prefix = `soulmed-${target}-backend`;
  assert.equal(env.ECR_REPOSITORY, prefix, 'Wrong image repository');
  assert.equal(env.AWS_RELEASE_ROLE_ARN, `arn:aws:iam::${account}:role/${prefix}-release`, 'Wrong release role');
  if (!buildOnly) {
    assert.equal(env.ECS_CLUSTER, prefix, 'Wrong ECS cluster');
    for (const [key, suffix] of [['ECS_API_SERVICE', ''], ['ECS_TUTOR_SERVICE', '-tutor'], ['ECS_MAINTENANCE_SERVICE', '-maintenance']]) assert.equal(env[key], prefix + suffix, 'Wrong service target');
    assert.match(env.HEALTH_URL || '', /^https:\/\/[a-z0-9]+\.cloudfront\.net\/api\/ready$/, 'Set CloudFront readiness URL');
  }
}
module.exports = { check };
if (require.main === module) { check(process.env, process.argv.includes('--build-only')); console.log('Release targets verified.'); }
