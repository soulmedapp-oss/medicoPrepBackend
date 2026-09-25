const multer = require('multer');
const { reportError } = require('../lib/errorReporter');

// What a student reads when the server, not the request, is at fault.
const GENERIC_SERVER_ERROR = 'Something went wrong on our side. Please try again.';

const CORS_ERROR_CODE = 'CORS_NOT_ALLOWED';

function createCorsError() {
  const err = new Error('Not allowed by CORS');
  err.code = CORS_ERROR_CODE;
  err.status = 403;
  return err;
}

/** Maps an error to { status, message } without leaking internals. */
function mapError(err) {
  if (!err) return { status: 500, message: GENERIC_SERVER_ERROR };
  if (err instanceof multer.MulterError || err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') return { status: 413, message: 'File is too large' };
    return { status: 400, message: 'Invalid upload' };
  }
  if (err.code === 'INVALID_FILE_TYPE') {
    return { status: 400, message: err.message || 'File type not allowed' };
  }
  if (err.code === CORS_ERROR_CODE) {
    return { status: 403, message: 'Origin not allowed' };
  }
  // body-parser errors
  if (err.type === 'entity.parse.failed') return { status: 400, message: 'Invalid JSON body' };
  if (err.type === 'entity.too.large') return { status: 413, message: 'Request body is too large' };
  if (err.name === 'CastError') return { status: 400, message: 'Invalid identifier' };
  const status = Number(err.status || err.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { status, message: 'Bad request' };
  }
  return { status: 500, message: GENERIC_SERVER_ERROR };
}

// Final Express error handler (must keep 4 args).
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const { status, message } = mapError(err);
  if (status >= 500) {
    // Unexpected: full report (log line with stack + error tracker). The
    // client only ever sees the generic message and the correlation id.
    reportError(req, err, 'unhandled request error');
  } else if (err && err.message) {
    // Expected client-side fault (bad JSON, oversize upload, CORS): one
    // warn line on the request log, no stack, nothing shipped.
    res.locals.errorMessage = err.message;
  }
  if (res.headersSent) {
    return next(err);
  }
  const body = { error: message };
  if (req && req.correlationId) body.correlationId = req.correlationId;
  return res.status(status).json(body);
}

module.exports = { errorHandler, mapError, createCorsError, CORS_ERROR_CODE, GENERIC_SERVER_ERROR };
