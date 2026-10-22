# Shared database selection

APP_DB_NAME explicitly selects the app database for the API, tutor/maintenance
workers, index preparation and seed/migration commands. MONGODB_URI supplies
connection/credentials. Without APP_DB_NAME, legacy local URI selection still
works. In ECS both values come from shared SSM references. No SDK/SSM access
is needed in local application code; use local .env.

GET /dev/build-info (frontend /api/dev/build-info) returns only the connected
Mongoose database NAME when APP_ENV is exactly dev and the connection is ready.
It is 404 for QA/UAT/prod/unset APP_ENV and does not return URI/host/credentials.
It uses no-store caching. For localhost set APP_ENV=dev explicitly if wanted.

Deploy this backwards-compatible code before switching ECS SSM references.
See infrastructure docs/central-database-settings.md for staged rollout.
