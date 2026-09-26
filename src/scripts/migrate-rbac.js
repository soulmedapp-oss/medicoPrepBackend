// One-time legacy -> RBAC migration for roles and users.
//
//   node src/scripts/migrate-rbac.js --dry-run     # read-only report
//   node src/scripts/migrate-rbac.js --execute     # apply the plan
//   node src/scripts/migrate-rbac.js --execute --reset-defaults   # also re-apply default bundles to default roles
//
// Before the RBAC rework, roles held strings like `view_dashboard` and
// `manage_questions`, and some users carried per-user permission lists.
// resolvePermissions() ignores anything that is not a catalogue code, so an
// unmigrated `student` role grants NOTHING at runtime, and the Roles page
// refuses to save such a role ("Unknown permission code(s): …").
//
// The decisions live in src/rbac/migrationPlan.js (pure, tested); this file
// only reads, prints and — with --execute — writes. Re-running is safe: a
// role or user that is already in the new shape produces no plan.
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Role = require('../models/Role');
const User = require('../models/User');
const { planRoleMigration, planUserMigration } = require('../rbac/migrationPlan');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const isDryRun = process.argv.includes('--dry-run');
const isExecute = process.argv.includes('--execute');
const resetDefaults = process.argv.includes('--reset-defaults');

function usage() {
  console.log('Usage: node src/scripts/migrate-rbac.js --dry-run | --execute [--reset-defaults]');
  console.log('  --dry-run          Print what would change. Writes nothing.');
  console.log('  --execute          Apply the plan.');
  console.log('  --reset-defaults   With --execute: re-apply DEFAULT_ROLE_PERMISSIONS to default roles even if');
  console.log('                     they were migrated before (undoes admin edits to those roles — use knowingly).');
}

async function main() {
  if ((!isDryRun && !isExecute) || (isDryRun && isExecute)) {
    usage();
    process.exitCode = 1;
    return;
  }
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(mongoUri, { autoIndex: false });
  console.log(`${isDryRun ? 'DRY RUN' : 'EXECUTE'} — database "${mongoose.connection.name}" on ${mongoose.connection.host}\n`);

  try {
    // ---- Roles ----
    const roles = await Role.find({}).lean();
    const rolePlans = roles
      .map((doc) => ({ doc, plan: planRoleMigration(doc, { forceTopUp: resetDefaults }) }))
      .filter(({ plan }) => plan);

    console.log(`Roles: ${roles.length} scanned, ${rolePlans.length} to change`);
    rolePlans.forEach(({ doc, plan }) => {
      const before = doc.permissions || [];
      const removed = before.filter((c) => !plan.permissions.includes(c));
      const added = plan.permissions.filter((c) => !before.includes(c));
      const rename = plan.renameFrom ? `  (rename "${plan.renameFrom}" -> "${plan.name}")` : '';
      console.log(`  ${doc.name}${rename}`);
      if (removed.length) console.log(`    - legacy removed: ${removed.join(', ')}`);
      if (added.length) console.log(`    + granted:        ${added.join(', ')}`);
    });

    // ---- Users ----
    const users = await User.find({}).select('email role roles is_teacher permissions').lean();
    const userPlans = users
      .map((doc) => ({ doc, plan: planUserMigration(doc) }))
      .filter(({ plan }) => plan);
    const customRoles = new Map();
    userPlans.forEach(({ plan }) => {
      if (plan.customRole) customRoles.set(plan.customRole.name, plan.customRole.permissions);
    });

    console.log(`\nUsers: ${users.length} scanned, ${userPlans.length} to change`);
    userPlans.slice(0, 25).forEach(({ doc, plan }) => {
      const teacherFlag = Boolean(doc.is_teacher) !== plan.is_teacher ? `, is_teacher ${Boolean(doc.is_teacher)} -> ${plan.is_teacher}` : '';
      console.log(`  ${doc.email}: roles ${JSON.stringify(doc.roles || [])} -> ${JSON.stringify(plan.roles)}, role "${doc.role}" -> "${plan.role}"${teacherFlag}${plan.customRole ? `, custom role ${plan.customRole.name}` : ''}`);
    });
    if (userPlans.length > 25) console.log(`  … and ${userPlans.length - 25} more`);
    if (customRoles.size) {
      console.log(`\nCustom roles to create (from per-user permission lists): ${customRoles.size}`);
      customRoles.forEach((perms, name) => console.log(`  ${name}: ${perms.join(', ')}`));
    }

    if (isDryRun) {
      console.log('\nDry run: nothing written. Re-run with --execute to apply.');
      return;
    }

    // ---- Apply: custom roles first (users reference them), then roles, then users ----
    for (const [name, permissions] of customRoles) {
      // eslint-disable-next-line no-await-in-loop
      await Role.updateOne(
        { name },
        { $setOnInsert: { name, description: 'Migrated from per-user permissions', is_active: true, permissions } },
        { upsert: true }
      );
    }
    for (const { doc, plan } of rolePlans) {
      // eslint-disable-next-line no-await-in-loop
      await Role.updateOne({ _id: doc._id }, { $set: { name: plan.name, permissions: plan.permissions } });
    }
    for (const { doc, plan } of userPlans) {
      // eslint-disable-next-line no-await-in-loop
      await User.updateOne(
        { _id: doc._id },
        { $set: { roles: plan.roles, role: plan.role, is_teacher: plan.is_teacher }, $unset: { permissions: '' } }
      );
    }
    console.log(`\nApplied: ${customRoles.size} custom role(s), ${rolePlans.length} role(s), ${userPlans.length} user(s) updated.`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
