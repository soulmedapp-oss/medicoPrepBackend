// For use inside controllers, where a response is widened for some callers
// (e.g. staff seeing the answer key). Route-level gates use authorize().
function can(user, code) {
  return Array.isArray(user?.effective_permissions) && user.effective_permissions.includes(code);
}
const canAny = (user, codes) => (codes || []).some((code) => can(user, code));

module.exports = { can, canAny };
