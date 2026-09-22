const { isValidObjectId } = require('../utils/security');

/**
 * Registers router.param validators so that any route on `router` using one of
 * `paramNames` responds 400 for malformed ObjectIds instead of a 500 CastError.
 */
function validateObjectIdParams(router, paramNames = ['id']) {
  paramNames.forEach((name) => {
    router.param(name, (req, res, next, value) => {
      if (!isValidObjectId(value)) {
        return res.status(400).json({ error: `Invalid ${name}` });
      }
      return next();
    });
  });
  return router;
}

module.exports = { validateObjectIdParams };
