// Pure decisions for src/scripts/seed-admin.js, kept out of the script so
// they can be tested without a database.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// argv -> { email, name, password, force } | { error }
function parseArgs(argv) {
  const out = { email: '', name: '', password: '', force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      out.force = true;
    } else if (arg === '--email' || arg === '--name' || arg === '--password') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      out[arg.slice(2)] = value;
      i += 1;
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }
  if (!out.email) return { error: '--email is required' };
  out.email = out.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(out.email)) return { error: `Not an email address: ${out.email}` };
  if (out.password && out.password.length < MIN_PASSWORD_LENGTH) {
    return { error: `--password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }
  return out;
}

// What to do given what is already in the database.
//   create  — no user with that email: insert one with the admin role
//   promote — the user exists: add the admin role (password untouched)
//   noop    — the user exists and is already an admin
//   refuse  — another admin already exists and --force was not given
// The refusal is the safety rail: this script is meant for an EMPTY
// database, and running it by accident against a live one must not quietly
// mint a second administrator.
function planAdminSeed({ existingUser, otherAdminCount, force }) {
  const alreadyAdmin = Boolean(
    existingUser
      && (existingUser.role === 'admin' || (Array.isArray(existingUser.roles) && existingUser.roles.includes('admin')))
  );
  if (alreadyAdmin) return { action: 'noop', reason: 'already an admin' };
  if (otherAdminCount > 0 && !force) {
    return {
      action: 'refuse',
      reason: `${otherAdminCount} admin account(s) already exist in this database; re-run with --force to add another`,
    };
  }
  return existingUser ? { action: 'promote' } : { action: 'create' };
}

// The role fields a user document needs to be recognised as an admin by
// collectRoleNames() — `role` for the legacy single field, `roles` for the
// RBAC list — merged onto whatever roles the user already had.
function adminRoleFields(existingRoles) {
  const roles = new Set(Array.isArray(existingRoles) ? existingRoles : []);
  roles.add('admin');
  return { role: 'admin', roles: Array.from(roles) };
}

module.exports = { parseArgs, planAdminSeed, adminRoleFields, MIN_PASSWORD_LENGTH };
