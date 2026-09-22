const multer = require('multer');

const CORS_ERROR_CODE = 'CORS_NOT_ALLOWED';

function createCorsError() {
  const err = new Error('Not allowed by CORS');
  err.code = CORS_ERROR_CODE;
  err.status = 403;
  return err;
}

/** Maps an error to { status, message } without leaking internals. */
function mapError(err) {
  if (!err) return { status: 500, message: 'Internal server error' };
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
  return { status: 500, message: 'Internal server error' };
}

// Final Express error handler (must keep 4 args).
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const { status, message } = mapError(err);
  if (status >= 500) {
    res.locals.logErrorMessage = err && err.message;
    res.locals.logErrorStack = err && err.stack;
  } else if (err && err.message) {
    res.locals.logErrorMessage = err.message;
  }
  if (res.headersSent) {
    return next(err);
  }
  const body = { error: message };
  if (req && req.correlationId) body.correlationId = req.correlationId;
  return res.status(status).json(body);
}

module.exports = { errorHandler, mapError, createCorsError, CORS_ERROR_CODE };
