// An update route accepts any(CanEditX, CanDeactivateX); this decides which of
// the two a particular request actually needs (spec 5.2.1).
const { can } = require('./can');

const isActive = (value) => value !== false; // a stored value counts as active unless it's literally `false`

function missingUpdatePermissions(user, body, current, { edit, deactivate }) {
  const data = body || {};
  const keys = Object.keys(data);
  const storedActive = isActive((current || {}).is_active);
  // Fail closed: Mongoose casts "false", 0, "0", "no", etc. to the boolean
  // `false` on write, so anything that ISN'T a strict boolean equal to the
  // stored state counts as a change (even a same-looking value like the
  // string "true" — over-strict on purpose, since it is not the type Mongoose
  // will store as-is).
  const changesActive = keys.includes('is_active') && !(typeof data.is_active === 'boolean' && data.is_active === storedActive);
  const touchesOther = keys.some((key) => key !== 'is_active');
  const missing = [];
  if (changesActive && !can(user, deactivate)) missing.push(deactivate);
  if (touchesOther && !can(user, edit)) missing.push(edit);
  return missing.length > 0 ? missing : null;
}

module.exports = { missingUpdatePermissions };
