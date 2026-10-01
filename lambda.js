// AWS Lambda entrypoint. API Gateway HTTP API (payload format 2.0) -> Express.
// Local/dev still runs `npm start` (src/server.js starts an HTTP listener).
const serverlessExpress = require('@codegenie/serverless-express');

const { rawApp, ensureDbConnected, runClassRemindersOnce } = require('./src/server');
const errorReporter = require('./src/lib/errorReporter');

// Build the serverless-express handler once (module scope = reused warm).
const proxy = serverlessExpress({ app: rawApp });

// The EventBridge schedule in iac/reminders.tf invokes this function directly
// every 5 minutes with exactly this payload. Such a call never comes through
// API Gateway (it has no requestContext) and only principals allowed to invoke
// the function — that schedule — can send it, so no secret is needed.
const SCHEDULED_TASKS = { 'class-reminders': () => runClassRemindersOnce() };
function scheduledTask(event) {
  if (!event || event.requestContext || typeof event.task !== 'string') return null;
  return SCHEDULED_TASKS[event.task] || null;
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  // Connect to Mongo BEFORE handing the request to serverless-express, so the
  // request body stream isn't consumed while we await.
  try {
    await ensureDbConnected();
  } catch (err) {
    errorReporter.reportError(null, err, 'DB connection failed');
    await errorReporter.flush();
    return {
      statusCode: 503,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Service unavailable' }),
    };
  }
  const task = scheduledTask(event);
  if (task) {
    try {
      return await task(); // e.g. { checked, sent } — visible in the Lambda's logs
    } catch (err) {
      errorReporter.reportError(null, err, `scheduled task ${event.task} failed`);
      throw err; // a failed invocation shows up in CloudWatch metrics
    } finally {
      await errorReporter.flush();
    }
  }
  try {
    return await proxy(event, context);
  } finally {
    // Lambda may freeze the process right after the response; make sure any
    // error report queued during this invocation has left the building.
    await errorReporter.flush();
  }
};
