// Creates (or promotes) the first administrator of a database.
//
//   node src/scripts/seed-admin.js --email you@example.com --name "Your Name" [--password '...'] [--force]
//
// Connects to MONGODB_URI from .env — so it acts on whichever database that
// URI names. Meant for a fresh database: registering through the app only
// ever makes a student, and only an admin can grant the admin role, so a new
// database has no way to get its first admin without this.
//
// Safety: refuses when another admin already exists unless --force is given.
// With no --password (and no SEED_ADMIN_PASSWORD env var) a random one is
// generated and printed ONCE — change it after the first login.
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Role = require('../models/Role');
const { syncPermissions } = require('../rbac/syncPermissions');
const { defaultRoleUpserts } = require('../rbac/defaultRoles');
const { parseArgs, planAdminSeed, adminRoleFields } = require('../utils/seedAdmin');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.log('Usage: node src/scripts/seed-admin.js --email <email> --name <full name> [--password <min 8 chars>] [--force]');
  console.log('  Creates the first admin in the database MONGODB_URI points at, or promotes an existing user.');
  console.log('  Refuses if an admin already exists unless --force is given.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    usage(args.error);
    process.exitCode = 1;
    return;
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(mongoUri, { autoIndex: true });
  console.log(`Connected to database "${mongoose.connection.name}" on ${mongoose.connection.host}`);

  try {
    // The same catalogue/role seed the server performs on startup, so the
    // Roles page and permission checks are coherent even before the app has
    // ever been started against this database.
    await syncPermissions();
    await Promise.all(
      defaultRoleUpserts().map(({ filter, update }) => Role.updateOne(filter, update, { upsert: true }))
    );

    const existingUser = await User.findOne({ email: args.email });
    const otherAdminCount = await User.countDocuments({
      $or: [{ role: 'admin' }, { roles: 'admin' }],
      ...(existingUser ? { _id: { $ne: existingUser._id } } : {}),
    });
    const plan = planAdminSeed({ existingUser, otherAdminCount, force: args.force });

    if (plan.action === 'refuse') {
      console.error(`Refused: ${plan.reason}.`);
      process.exitCode = 1;
      return;
    }
    if (plan.action === 'noop') {
      console.log(`${args.email} is already an admin. Nothing to do.`);
      return;
    }

    if (plan.action === 'promote') {
      await User.updateOne(
        { _id: existingUser._id },
        { $set: { ...adminRoleFields(existingUser.roles), is_active: true, email_verified: true } }
      );
      console.log(`Promoted ${args.email} to admin (password unchanged).`);
      return;
    }

    const password = args.password || process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const generated = !args.password && !process.env.SEED_ADMIN_PASSWORD;
    await User.create({
      email: args.email,
      full_name: args.name || args.email.split('@')[0],
      passwordHash: await bcrypt.hash(password, 10),
      ...adminRoleFields([]),
      is_active: true,
      email_verified: true,
      email_verified_at: new Date(),
      email_verified_reason: 'seed-admin',
    });
    console.log(`Created admin ${args.email}.`);
    if (generated) {
      console.log(`Temporary password (shown once): ${password}`);
    }
    console.log('Log in and change the password from the profile page.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
