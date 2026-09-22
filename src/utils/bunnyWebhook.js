const crypto = require('node:crypto');
const { safeCompare } = require('./security');

// Bunny signs the EXACT bytes it sent. express.json() parses and discards them,
// so the route must read req.rawBody (see server.js) - re-serialising req.body
// produces different bytes and every signature silently fails.
function verifyBunnySignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : String(rawBody))
    .digest('hex');
  return safeCompare(expected, String(signature).toLowerCase());
}

module.exports = { verifyBunnySignature };
