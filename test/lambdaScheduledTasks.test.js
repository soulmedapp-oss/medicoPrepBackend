// lambda.js: the EventBridge schedule (iac/reminders.tf) invokes the function
// with { task: 'class-reminders' }; that runs the reminders, while API Gateway
// requests (which always carry requestContext) still go to Express.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadHandler({ runs }) {
  const serverPath = require.resolve(path.join(__dirname, '../src/server'));
  const lambdaPath = require.resolve(path.join(__dirname, '../lambda.js'));
  delete require.cache[lambdaPath];
  const express = require('express');
  const app = express();
  app.get('/health', (req, res) => res.json({ ok: true }));
  require.cache[serverPath] = {
    id: serverPath, filename: serverPath, loaded: true,
    exports: {
      rawApp: app,
      ensureDbConnected: async () => {},
      runClassRemindersOnce: async () => { runs.push('ran'); return { checked: 2, sent: 1 }; },
    },
  };
  try {
    return require(lambdaPath).handler;
  } finally {
    delete require.cache[serverPath];
    delete require.cache[lambdaPath];
  }
}

const context = () => ({ callbackWaitsForEmptyEventLoop: true });

test('the scheduled payload runs the class reminders and returns their result', async () => {
  const runs = [];
  const handler = loadHandler({ runs });
  const out = await handler({ task: 'class-reminders' }, context());
  assert.deepEqual(out, { checked: 2, sent: 1 });
  assert.deepEqual(runs, ['ran']);
});

test('an API Gateway request is never treated as a scheduled task, even with a "task" field', async () => {
  const runs = [];
  const handler = loadHandler({ runs });
  const event = {
    version: '2.0', routeKey: '$default', rawPath: '/health', rawQueryString: '', headers: { host: 'x' },
    requestContext: { http: { method: 'GET', path: '/health', sourceIp: '1.1.1.1', protocol: 'HTTP/1.1', userAgent: 't' }, stage: '$default', requestId: 'r', domainName: 'x', timeEpoch: Date.now() },
    isBase64Encoded: false, task: 'class-reminders',
  };
  const res = await handler(event, context());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(runs, [], 'reminders must not run from a web request');
});

test('an unknown task is not run', async () => {
  const runs = [];
  const handler = loadHandler({ runs });
  await assert.rejects(() => handler({ task: 'drop-database' }, context()));
  assert.deepEqual(runs, []);
});
