// AWS Lambda entrypoint. API Gateway HTTP API (payload format 2.0) -> Express.
// Local/dev still runs `npm start` (src/server.js starts an HTTP listener).
const serverlessExpress = require('@codegenie/serverless-express');

const { rawApp, ensureDbConnected } = require('./src/server');

// Build the serverless-express handler once (module scope = reused warm).
const proxy = serverlessExpress({ app: rawApp });

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  // Connect to Mongo BEFORE handing the request to serverless-express, so the
  // request body stream isn't consumed while we await.
  try {
    await ensureDbConnected();
  } catch (err) {
    console.error('DB connection failed:', err);
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Service unavailable' }),
    };
  }
  return proxy(event, context);
};
