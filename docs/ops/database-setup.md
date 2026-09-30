# Database setup

How the app finds its database, how to point it at a different one, and how
to make a brand-new one usable.

## Which database am I on?

The database is the path segment of `MONGODB_URI`:

```
mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<DATABASE>
```

With no `<DATABASE>` the MongoDB driver falls back to one literally named
`test`. Always name it. The server prints the name on startup:

```
MongoDB connected (db: soulmed)
```

MongoDB creates a database the first time something is written to it — there
is no "create database" step, and Mongoose creates each collection and its
indexes on first use.

## Suggested layout

| Database      | Used by            | Where the URI lives        |
| ------------- | ------------------ | -------------------------- |
| `soulmed`     | production         | the host's env settings    |
| `soulmed_dev` | local development  | your local `.env`          |
| `test`        | legacy default     | drop once `soulmed` is verified |

## Making a fresh database usable

Point `MONGODB_URI` at the new name, then:

1. **First admin** — registering through the app only ever makes a student,
   and only an admin can grant the admin role, so a new database needs this
   once:

   ```
   node src/scripts/seed-admin.js --email you@example.com --name "Your Name"
   ```

   It creates the user with the admin role (or promotes an existing user),
   seeds the permission catalogue and default roles, and prints a temporary
   password once if you did not pass `--password`. It refuses to run when an
   admin already exists unless you add `--force`.

2. **Subjects** — `node src/scripts/seed-subjects.js` (idempotent).

3. **Subscription plans** — Admin → Subscription Plans, or copy the
   `subscriptionplans` collection from an existing database.

4. Start the server; everything else is created as it is used.

## Copying an existing database (e.g. `test` → `soulmed`)

MongoDB has no rename. Dump and restore under the new name with the
[MongoDB Database Tools](https://www.mongodb.com/try/download/database-tools):

```
mongodump    --uri="mongodb+srv://<user>:<password>@<cluster>.mongodb.net/test" --out=./dump
mongorestore --uri="mongodb+srv://<user>:<password>@<cluster>.mongodb.net" --nsFrom="test.*" --nsTo="soulmed.*" ./dump
```

The source is untouched, so this is reversible. Run the playlist rollout
migrations (see `2026-09-22-playlist-rollout-runbook.md`) against the NEW
name afterwards, not against `test`.
