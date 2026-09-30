# medicoprep-backend

## Deploying RBAC

This backend enforces access control through a permission catalogue
(`src/rbac/permissions.js`) and per-route `authorize(...)` rules, backed by
`Role` documents and each user's `roles`. When you deploy the branch that
introduces or changes this system, follow this sequence.

1. **Always dry-run first.** Before touching a real database, run
   `node scripts/migrateRbac.js --dry-run` and read every line of output. It
   reports, per role and per user, exactly what would change (role renames,
   permission top-ups, custom roles that would be created, users whose
   per-user permissions would map to nothing) without writing anything. Only
   once you've reviewed that output should you run the same command without
   `--dry-run` to apply it.

2. **`--reset-defaults` is opt-in, and changes behavior.** Passing
   `--reset-defaults` forces the four built-in roles (`admin`, `student`,
   `teacher`, `content_writer`) back to their catalogue permission set, even
   if an admin has since edited one of them by hand. Use it only when you
   deliberately want that reset. A plain re-run (no flag) does **not**
   restore permissions an admin has removed from a default role — this is a
   documented, deliberate change from the original spec text (see the RBAC
   project ledger), not an oversight. Skipping `--reset-defaults` is the
   normal, safe choice for a routine deploy.

3. **Deploy backend and frontend together.** The frontend's admin pages
   (Permissions, Roles, User Roles, Audit Log) call the `/permissions`,
   `/roles`, `/users/:id/roles` and `/audit-log` endpoints, and every backend
   route now enforces the new permission codes instead of the old
   role-string checks. Do not deploy one side without the other — an old
   frontend against a new backend (or vice versa) will not agree on what a
   user is allowed to do.

4. **Check for a legacy `admin`/`student`-spelled role BEFORE you deploy the
   backend, not just before you migrate.** Role names resolve case- and
   whitespace-insensitively everywhere in this system (`normalizeRoleName`),
   which is deliberate — it's what lets `"Teacher"` and `"teacher"` mean the
   same thing. But it also means that the moment the new backend (with the
   new `authMiddleware`) is live, ANY user whose legacy `role` field happens
   to be stored as a case/whitespace variant of `"admin"` (`"Admin"`,
   `"ADMIN "`, etc.) resolves to a full admin — every permission, by
   identity — regardless of whether `scripts/migrateRbac.js` has run yet.
   The migration script itself refuses to *rename* a role document into
   `admin` for exactly this reason, but that refusal cannot protect a value
   that's already sitting in a *user's* `role`/`roles` field. Before
   deploying, query the `users` collection for any `role`/`roles` value that
   case-insensitively equals `admin` or `student` but isn't spelled exactly
   that way, and confirm by hand that every such user is meant to have that
   access. Do the same check again after the migration runs, since it can
   introduce a normalised `student`/`admin` role rename on a `Role` document
   (not a `User` document) that this pre-check wouldn't have seen.

5. **Mind the gap before migration runs.** Until `scripts/migrateRbac.js` has
   been run, any non-admin staff member whose roles still hold only
   old-style permission strings (`manage_*`, `view_*`) effectively has **no**
   permissions under the new system — those strings are not read anywhere
   outside `src/rbac/legacyMap.js`'s one-time mapping helper. Admins are
   unaffected, since an admin resolves to every permission code by identity
   check, not from a stored permission list. There is no partial-compatibility
   fallback period, so plan the migration's timing (and the deploy window)
   accordingly.

6. **Secret rotation is a separate, still-open action item.** Any secrets
   that were committed to the GitHub repo before this branch started still
   need to be rotated by the user as their own action; that cleanup is
   unrelated to, and not performed by, this migration.

7. **The migration is manual and one-time; startup seeding is automatic and
   safe alongside it.** `scripts/migrateRbac.js` is never run automatically —
   it is a deliberate, one-time operator action. Server start-up seeding
   (`ensureDefaultRoles` / `syncPermissions`, called from `src/server.js` on
   boot) is separate: it upserts the permission catalogue and inserts the
   four default roles only if they don't already exist (`$setOnInsert`, so it
   never overwrites permissions an admin has since edited). Because it is
   insert-only, it never conflicts with a later manual migration run.
