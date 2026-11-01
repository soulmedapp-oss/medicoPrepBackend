# Login method and recent login history

Successful Google and email/password logins now record the method on the user and append a LoginEvent in the application MongoDB database. Existing users show Not recorded until they next log in. No historical login method is inferred from a linked Google identity. Refreshes and logout do not count as logins; the frontend no longer rewrites last_login_date on logout, and /auth/me updates cannot set it.

Detailed events contain only user ID, server-selected method, time, IP and truncated browser User-Agent. Passwords, Google tokens, cookies and request bodies are not stored. Browser/IP details are informational, not proof of device identity. Failed sign-ins are not included. A history-write failure produces a warning but does not block a valid login. Last-login metadata remains on the user as before; detailed events expire after 30 days.

## Local test using the usual checkout folders

The feature files are mirrored as uncommitted working-tree edits into:
- Backend: D:\SoulMedAi\myBranch\backend\medicoPrepBackend
- Frontend: D:\SoulMedAi\myBranch\frontend\soulmed

Both stay on main. Existing .env files are preserved. The feature branch commits and PRs are separate. No agents source change is needed. Do not discard the mirrored changes before testing; after the PRs are merged, reconcile these local edits before updating main.

1. Verify the backend .env selects the intended development database.
2. Prepare ONLY the login-history collection's indexes once in that database:

```powershell
cd D:\SoulMedAi\myBranch\backend\medicoPrepBackend
node scripts/prepareLoginHistoryIndexes.js
```

This creates the user/time query index and an expiry TTL index. Without the TTL index, API responses still exclude expired events, but MongoDB will not automatically remove stored expired documents. MongoDB TTL deletion runs asynchronously; it is not an exact-time deletion guarantee. This script is supplied but was not run against any live database by the implementation task. It does not drop indexes or modify existing user accounts.

3. Start the backend and frontend with your normal local configuration.
4. Log in with email/password, then open Admin Users or Manage Students. The Last Login cell shows Email & password.
5. Log out, then sign in to the same account with Google. Confirm its ID, subscription and permissions are unchanged and Last Login now shows Google.
6. A viewer with CanViewAuditLog can select Login history in either user-management page. The dialog lists the most recent 20 successful logins within 30 days.
7. A viewer with only CanViewUsers can see the last method but cannot open detailed history. The server also rejects the detailed-history endpoint without CanViewAuditLog.
8. Session refreshes and logout should not create events or move the last-login date.

## Production

Deploy through the normal reviewed application release process. Prepare the LoginEvent indexes on the intended production database as a reviewed deployment step; automatic index creation is not assumed. There is no database wipe, backfill, role/permission creation, new AWS service, or historical data inference. The history endpoint is GET /users/:id/login-history, protected by authentication, ObjectId validation and CanViewAuditLog. It is no-store/private, returns at most 20 rows and excludes expired events even before TTL cleanup.

## Local mirroring preference

For future backend/frontend/agents feature work, use separate feature branches for commits/PRs and mirror only that feature's reviewed files into the user's corresponding normal main checkouts for local testing. Check for local edits before mirroring; never overwrite conflicts or copy .env/secrets. Only change the repositories required by the feature. Keep the main checkouts on their existing branches and do not commit or push their mirrored edits automatically.
