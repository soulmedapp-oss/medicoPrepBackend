// Task 12: one-time migration of legacy role/user permission data to the new
// RBAC catalogue. All I/O lives here; the planning decisions themselves are
// in src/rbac/migrationPlan.js so they can be unit-tested without a database.
//
// `run()` takes its models, syncPermissions and logger as arguments (never
// reaching for a live model directly) specifically so this file's own tests
// can hand it fakes and prove --dry-run performs not a single write - see
// test/rbacMigration.test.js. The CLI wrapper below (guarded by
// `require.main === module`) is the only part that touches a real
// connection, so `node -e "require('./scripts/migrateRbac')"` loads this
// file without connecting to anything.
const { planRoleMigration, planUserMigration } = require('../src/rbac/migrationPlan');
const { normalizeRoleName } = require('../src/rbac/resolvePermissions');
const { isKnownPermission } = require('../src/rbac/permissions');
const { defaultRoleUpserts } = require('../src/rbac/defaultRoles');
const { countActiveAdmins: realCountActiveAdmins } = require('../src/rbac/countActiveAdmins');

const DEFAULT_ROLE_NAMES = ['admin', 'student', 'teacher', 'content_writer'];
const SYSTEM_ROLE_NAMES = ['admin', 'student'];

function topUpReason(name, permissions, forceTopUp) {
  if (name === 'admin') return 'admin always holds no permissions';
  if (forceTopUp) return '--reset-defaults';
  const neverMigrated = !(permissions || []).some(isKnownPermission);
  return neverMigrated ? 'never migrated' : 'skipped: already holds new codes';
}

// Fetches every role once, applies planRoleMigration to each, guards renames
// against name collisions, and (outside dry-run) writes the changes.
//
// Fix round 1 (C2): also returns `roleStates` - the effective identity
// (name + is_active) each role document ends up under after this pass,
// whether or not a write actually happened (dry run included). `run()`
// hands this to ensureDefaultRoles instead of the raw pre-migration
// snapshot, so a default slot ("teacher") that is about to be filled by a
// rename ("Teacher ") is correctly recognised as no longer missing, and a
// slot whose only candidate was REFUSED (see the reserved-name guard below)
// is correctly still reported as missing so the real role gets seeded.
//
// Fix round 1 (C2, defence in depth): a role is never renamed into the
// reserved name `admin` by this generic path unless it is already spelled
// exactly that way. `resolvePermissions.js` special-cases the literal
// string 'admin' (`names.includes('admin') -> ALL_CODES`) - that is the one
// name where a rename genuinely creates an escalation risk beyond the
// ordinary "wrong permission set" a collision already guards against, so it
// gets an extra, unconditional refusal instead of relying on the database's
// unique index as the only backstop (spec 6.5).
// `student` is deliberately NOT included here: it carries no special-cased
// grant in resolvePermissions.js (a "student"-named role is merged like any
// other), so a same-name-different-case rename such as "Student" ->
// "student" is exactly the safe, desired normalisation addendum B asks for
// and I2 tests - forbidding it here would fix a non-issue and break that
// requirement. See "## Fix round 1" in task-12-report.md for the reasoning.
async function migrateRoles({ Role, User, existingRoles, forceTopUp, dryRun, log }) {
  let rolesChanged = 0;
  const rawNames = existingRoles.map((r) => r.name);
  const roleStates = [];

  for (const name of DEFAULT_ROLE_NAMES) {
    const role = existingRoles.find((r) => normalizeRoleName(r.name) === name);
    if (role) log(`ROLE ${name}: top-up ${topUpReason(name, role.permissions, forceTopUp)}`);
  }

  for (const role of existingRoles) {
    const plan = planRoleMigration(role, { forceTopUp });
    const targetName = plan ? plan.name : normalizeRoleName(role.name);
    const wantsSystem = SYSTEM_ROLE_NAMES.includes(targetName);
    const needsSystemFix = wantsSystem && role.is_system !== true;

    if (plan && plan.renameFrom && plan.name === 'admin') {
      log(`WARNING role "${plan.renameFrom}": refusing to rename into reserved name "admin" - a role renamed to admin would grant every holder full access (spec 6.5); review by hand`);
      roleStates.push({ name: role.name, is_active: role.is_active });
      continue;
    }

    if (!plan && !needsSystemFix) {
      roleStates.push({ name: role.name, is_active: role.is_active });
      continue;
    }

    if (plan && plan.renameFrom) {
      const collision = rawNames.some((n, idx) => existingRoles[idx] !== role && normalizeRoleName(n) === plan.name);
      if (collision) {
        const affected = await User.countDocuments({ $or: [{ role: role.name }, { roles: role.name }] });
        log(`WARNING role "${plan.renameFrom}": cannot normalise, "${plan.name}" already exists (${affected} users affected — review by hand before running again)`);
        roleStates.push({ name: role.name, is_active: role.is_active });
        continue;
      }
    }

    const before = (role.permissions || []).length;
    const after = plan ? plan.permissions.length : before;
    if (plan) log(`ROLE ${role.name}: ${before} -> ${after} permissions${plan.renameFrom ? ` (renamed from "${plan.renameFrom}")` : ''}`);
    else log(`ROLE ${role.name}: marking is_system`);

    rolesChanged += 1;
    if (!dryRun) {
      const set = {};
      if (plan) {
        set.name = plan.name;
        set.permissions = plan.permissions;
      }
      if (needsSystemFix) set.is_system = true;
      await Role.updateOne({ _id: role._id }, { $set: set });
    }
    roleStates.push({ name: plan ? plan.name : role.name, is_active: role.is_active });
  }

  return { rolesChanged, roleStates };
}

// Fix round 1 (C2): takes the roleStates already computed by migrateRoles
// (the roles' effective, post-rename-or-refusal identities) rather than the
// raw pre-migration snapshot, and compares by EXACT string - the same
// exact-string filter defaultRoleUpserts()/bulkWrite uses - so a role that
// is about to become "teacher" via a rename is recognised as filling that
// slot, and a role that was REFUSED a rename into "admin"/"student" is
// correctly NOT mistaken for the real thing.
async function ensureDefaultRoles({ Role, roleStates, dryRun, log }) {
  const existingNames = new Set(roleStates.map((r) => r.name));
  const missing = DEFAULT_ROLE_NAMES.filter((name) => !existingNames.has(name));
  if (dryRun) {
    log(missing.length > 0 ? `Missing default roles: ${missing.join(', ')}` : 'All default roles already exist.');
    return missing;
  }
  if (missing.length > 0) {
    const missingSet = new Set(missing);
    const ops = defaultRoleUpserts()
      .filter((u) => missingSet.has(u.filter.name))
      .map((u) => ({ updateOne: { filter: u.filter, update: u.update, upsert: true } }));
    await Role.bulkWrite(ops);
  }
  return missing;
}

// `allRoleNames` (normalised): every role name known to exist at all -
// used only to decide whether a custom role name is new (isNew) so it is
// not double-counted/double-created. `activeRoleNames` (normalised): the
// subset that is_active - used only for the "grants nothing" orphan report
// (fix round 1, I3 / addendum D bullet 2: "does not exist as an ACTIVE
// role").
async function migrateUsers({ Role, User, dryRun, log, allRoleNames, activeRoleNames }) {
  let usersChanged = 0;
  let customRolesCreated = 0;
  const createdCustomRoleNames = new Set();
  const unknownRoleNames = new Set();
  const clearedOnlyEmails = [];

  const cursor = User.find({}).cursor();
  for await (const user of cursor) {
    const plan = planUserMigration(user);

    (plan ? plan.roles : user.roles || []).forEach((name) => {
      const normalised = normalizeRoleName(name);
      if (!activeRoleNames.has(normalised) && !createdCustomRoleNames.has(normalised)) unknownRoleNames.add(normalised);
    });

    if (!plan) continue;

    // Fix round 1, M2: admins deliberately get no custom role (they keep
    // ALL_CODES regardless), so clearing their stale `permissions` array is
    // not "mapped to nothing" in the same sense a non-admin's is - don't
    // list them alongside users whose grants genuinely evaporated.
    if (plan.clearPermissions && !plan.customRole && !plan.roles.includes('admin')) clearedOnlyEmails.push(user.email);

    if (plan.customRole) {
      // Fix round 1, M3: only write a custom role's document once per
      // unique permission set (name is content-hashed, so every holder
      // computes the same name/permissions) - write it under the first
      // holder and skip the write for the rest, so the document doesn't
      // get rewritten N times with N different array orders.
      const isNew = !allRoleNames.has(plan.customRole.name) && !createdCustomRoleNames.has(plan.customRole.name);
      if (isNew) {
        customRolesCreated += 1;
        createdCustomRoleNames.add(plan.customRole.name);
        unknownRoleNames.delete(plan.customRole.name);
        log(`CUSTOM ROLE ${plan.customRole.name}: ${plan.customRole.permissions.length} permissions (from ${user.email})`);
        if (!dryRun) {
          await Role.updateOne(
            { name: plan.customRole.name },
            {
              $set: {
                name: plan.customRole.name,
                permissions: [...plan.customRole.permissions].sort(),
                description: 'Migrated per-user permissions',
                is_active: true,
              },
            },
            { upsert: true }
          );
        }
      }
    }

    log(`USER ${user.email}: roles [${(user.roles || []).join(', ')}] -> [${plan.roles.join(', ')}]`);
    usersChanged += 1;

    if (!dryRun) {
      const set = { roles: plan.roles, role: plan.role, is_teacher: plan.is_teacher };
      if (plan.clearPermissions) set.permissions = [];
      await User.updateOne({ _id: user._id }, { $set: set });
    }
  }

  return { usersChanged, customRolesCreated, unknownRoleNames: Array.from(unknownRoleNames), clearedOnlyEmails };
}

// The whole migration, expressed purely in terms of its dependencies so it
// can run against fakes in tests and against real Mongoose models from the
// CLI wrapper below. Nothing here reaches for a live model/connection
// directly.
async function run({ dryRun = false, forceTopUp = false, models, syncPermissions, log = console.log, countActiveAdmins = realCountActiveAdmins } = {}) {
  const { Role, User } = models;

  const activeAdmins = await countActiveAdmins();
  log(`Active admins: ${activeAdmins}`);
  if (activeAdmins === 0) log('WARNING: no active admins remain - nobody will be able to manage roles after this migration.');

  if (dryRun) log('Skipping syncPermissions (dry run).');
  else await syncPermissions();

  const existingRoles = await Role.find({}).lean();

  // Fix round 1 (C2): migrateRoles runs FIRST, against the pre-existing
  // documents, so its renames land cleanly; ensureDefaultRoles runs
  // afterwards and only fills genuinely missing defaults (see the
  // roleStates comment on migrateRoles for why raw-snapshot ordering was
  // unsafe).
  const { rolesChanged, roleStates } = await migrateRoles({ Role, User, existingRoles, forceTopUp, dryRun, log });
  const missingDefaults = await ensureDefaultRoles({ Role, roleStates, dryRun, log });
  if (!dryRun && missingDefaults.length > 0) log(`Created ${missingDefaults.length} missing default role(s): ${missingDefaults.join(', ')}`);

  const allRoleNames = new Set(roleStates.map((r) => normalizeRoleName(r.name)));
  const activeRoleNames = new Set(roleStates.filter((r) => r.is_active !== false).map((r) => normalizeRoleName(r.name)));
  DEFAULT_ROLE_NAMES.forEach((n) => { allRoleNames.add(n); activeRoleNames.add(n); });

  const { usersChanged, customRolesCreated, unknownRoleNames, clearedOnlyEmails } = await migrateUsers({
    Role, User, dryRun, log, allRoleNames, activeRoleNames,
  });

  log(`Summary: ${rolesChanged} roles changed / ${usersChanged} users changed / ${customRolesCreated} custom roles created`);
  if (unknownRoleNames.length > 0) log(`Role names in use that grant nothing (no matching active role): ${unknownRoleNames.join(', ')}`);
  if (clearedOnlyEmails.length > 0) log(`Users whose per-user permissions mapped to nothing (cleared only): ${clearedOnlyEmails.join(', ')}`);

  return { rolesChanged, usersChanged, customRolesCreated, unknownRoleNames, clearedOnlyEmails, activeAdmins };
}

const KNOWN_FLAGS = ['--dry-run', '--reset-defaults'];

// Fix round 1 (I5): a typo'd flag (--dryrun, --dry_run, -n, ...) used to be
// silently ignored, which for a one-shot production migration would run a
// full LIVE write pass with no warning. Pure and exported so this property
// (throws before anything else, including any connection) is testable
// without invoking the CLI. `argv` is the CLI-args slice (no node/script
// path entries).
function parseArgs(argv) {
  const unknown = argv.filter((a) => !KNOWN_FLAGS.includes(a));
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. Known flags: ${KNOWN_FLAGS.join(', ')}`);
  return { dryRun: argv.includes('--dry-run'), forceTopUp: argv.includes('--reset-defaults') };
}

async function main() {
  require('dotenv').config();
  const mongoose = require('mongoose');
  // Parsed BEFORE anything else touches the network - an unknown flag must
  // never reach mongoose.connect (I5).
  const { dryRun, forceTopUp } = parseArgs(process.argv.slice(2));
  if (!process.env.MONGODB_URI) throw new Error('Missing required env var: MONGODB_URI');

  // Fix round 1 (I4): a mongoose.connect failure routinely embeds the host
  // in its error message (ENOTFOUND <cluster>.mongodb.net, "Server
  // selection timed out ... <host>:27017") - that is part of the
  // connection string, which addendum D forbids unconditionally. Connect
  // errors get a FIXED message; only errors raised from inside run() (after
  // a successful connect, so never carrying connection details) keep
  // err.message.
  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: true });
  } catch {
    throw new Error('could not connect (check MONGODB_URI)');
  }
  console.log('Connected.');
  try {
    const Role = require('../src/models/Role');
    const User = require('../src/models/User');
    const { syncPermissions } = require('../src/rbac/syncPermissions');
    await run({ dryRun, forceTopUp, models: { Role, User }, syncPermissions, log: console.log });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error('Migration failed:', err.message);
      process.exit(1);
    }
  );
}

module.exports = { run, parseArgs };
