const { logger, isProduction } = require('./logger');

// The ONLY file that knows Sentry exists. Everything else calls
// reportError / setUser / flush. Swapping the vendor (CloudWatch RUM, Rollbar,
// nothing) is a rewrite of this file, not a hunt through the controllers.
//
// With no SENTRY_DSN — locally, in tests, in a fresh deploy — every function
// here still logs and simply does not ship anything anywhere.

let sentry = null;

function init() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  try {
    // eslint-disable-next-line global-require
    sentry = require('@sentry/node');
    sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.LOG_ENV_NAME || process.env.NODE_ENV || 'development',
      release: process.env.SENTRY_RELEASE || undefined,
      // Errors are always sent. Performance traces are sampled so the free
      // tier is not spent on timing data.
      tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
      sendDefaultPii: false,
      // Never ship request bodies or auth headers, whatever the SDK's defaults.
      beforeSend(event) {
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          if (event.request.headers) {
            delete event.request.headers.authorization;
            delete event.request.headers.Authorization;
            delete event.request.headers.cookie;
          }
        }
        return event;
      },
    });
    logger.info('error reporting enabled');
    return true;
  } catch (err) {
    sentry = null;
    logger.warn({ err }, 'error reporting could not start; continuing without it');
    return false;
  }
}

// Request-scoped facts worth attaching to every report. The user is
// identified by id only; email is PII and lives in the DB, one lookup away.
function contextFrom(req) {
  if (!req) return {};
  return {
    correlationId: req.correlationId || req.id,
    userId: req.userId ? String(req.userId) : undefined,
    method: req.method,
    path: req.originalUrl || req.url,
  };
}

/**
 * Log an error and, when enabled, ship it. Safe to call from anywhere:
 * `req` may be null (services, timers, queues), `err` may be anything.
 *
 *   reportError(req, err)                      // in a controller catch
 *   reportError(null, err, 'bunny status poll') // no request in scope
 */
function reportError(req, err, message, extra) {
  const error = err instanceof Error ? err : new Error(String(err));
  const log = req?.log || logger;
  const ctx = contextFrom(req);
  log.error({ err: error, ...ctx, ...(extra || {}) }, message || error.message);

  if (!sentry) return;
  try {
    sentry.withScope((scope) => {
      if (ctx.userId) scope.setUser({ id: ctx.userId });
      if (ctx.correlationId) scope.setTag('correlationId', ctx.correlationId);
      if (ctx.path) scope.setTag('path', ctx.path);
      if (message) scope.setTag('context', message);
      if (extra) scope.setContext('extra', extra);
      sentry.captureException(error);
    });
  } catch (reportErr) {
    logger.warn({ err: reportErr }, 'error report failed');
  }
}

// Serverless: the process may be frozen right after the response, before the
// SDK's background send completes. Await this at the end of an invocation.
async function flush(timeoutMs = 2000) {
  if (!sentry) return;
  try {
    await sentry.flush(timeoutMs);
  } catch (err) {
    // nothing useful to do
  }
}

function isEnabled() {
  return Boolean(sentry);
}

module.exports = { init, reportError, flush, isEnabled, contextFrom, isProduction };
