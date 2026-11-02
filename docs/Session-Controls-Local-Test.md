# Session controls and expandable login history

## Behavior

- Admin Users and Manage Students have a separate Login history column. Its summary shows the last successful login date/time; expanding it loads recent events. The existing CanViewAuditLog permission is required for event details and enforced by the backend. Last login method is a separate column.
- After 20 minutes with no confirmed user activity, a warning opens. There are two more minutes to choose Stay signed in. Otherwise the session ends. Background polling and token refresh never extend this deadline.
- Clicking/tapping, typing and wheel interaction while the page is visible can send a throttled activity confirmation. Moving the mouse alone, automatic polling, page focus and hidden tabs do not count. Reading/watching without interaction can trigger the warning; there is no automatic exam submission, job cancellation or content deletion.
- Tabs in one browser share the session cookies and confirmed activity. Separate browsers/profiles/incognito windows are separate sessions.
- After verifying password or Google identity, a login from another browser warns that the account is already active. Cancel leaves that session unchanged. Continue here signs out the previous session. Confirmation is browser-bound, valid for three minutes and invalidated by a changed account/session. No warning reveals account/device details before credentials are verified.
- Password reset, deactivation and logout revoke active-session state. Backend/AI requests reject revoked or expired sessions; open WebSockets are checked within 30 seconds. Already-running jobs are not canceled, and already-delivered data cannot be withdrawn.
- A session also has an absolute lifetime (existing REFRESH_TOKEN_DAYS setting, default 7 days); sign in again when it ends.

## Configure the times

In the backend .env used by your normal local checkout:

```dotenv
SESSION_IDLE_MINUTES=20
SESSION_WARNING_SECONDS=120
```

Restart the backend after changing them. The frontend reads authoritative deadlines from the backend, so there is no duplicated VITE setting. Allowed idle minutes: 1?1440. Allowed warning seconds: 15?600. Invalid values use defaults. New settings apply to new sessions or the next confirmed activity; a live session retains its stored policy until then.

For a quick local test, temporarily use 1 minute and 30 seconds. Restore 20/120 afterwards. The implementation does not change your real .env automatically.

## Local testing

The reviewed files are mirrored into the normal main checkouts for backend, frontend and agents; feature-branch commits/PRs remain separate. Existing .env files are preserved.

1. Restart backend, frontend and agents from the usual checkout folders. Existing browser sessions may need to sign in once again after this security change; no user data is reset.
2. Prepare the targeted session-lookup indexes once against the intended development database:

```powershell
cd D:\SoulMedAi\myBranch\backend\medicoPrepBackend
node scripts/prepareSessionIndexes.js
```

The previous login-event TTL setup remains applicable: `node scripts/prepareLoginHistoryIndexes.js`. Scripts are supplied but were not run against a live database by this task. They add indexes, not user records, and do not drop indexes.

3. Sign in with password. Check the new history column and expand it.
4. Set short local timings, sign in, stop interacting and wait for the warning. Stay signed in should dismiss it only after the backend confirms activity. Without confirmation, logout should occur at the deadline.
5. Open another tab in the same browser. Activity in one should keep the shared session alive in both. Background refreshes alone should not.
6. Open another browser/incognito window and use the same credentials. Cancel should preserve the first browser. Continue here should sign in the second browser; the first browser's next backend/AI request must fail, and its visible-page status polling should notice within about 30 seconds.
7. Repeat with Google sign-in. Failed credentials must never expose a device-conflict prompt.
8. Check password reset, account deactivation and logout, including returning later to a previously idle browser.

## Deployment and compatibility

Deploy backend and agents companion changes together before exposing the new frontend controls. Apply the targeted lookup indexes in the intended production database as a reviewed deployment step. No new AWS service or IAM role is required.

Sessions are stored atomically in the application MongoDB user document, so multiple API processes cannot silently take ownership concurrently. Refresh rotation preserves a short grace window for concurrent tab refreshes without replacing the winning refresh cookie. Tokens carry a session ID and token version; session/refresh state is stripped from serialized user responses. Confirmation tickets and credentials are never persisted in browser storage. Cross-tab storage contains only non-secret session timing metadata.

Legacy browser cookies without session IDs require a fresh sign-in. Previously issued short-lived header/AI tokens without session IDs expire normally when there is no new active session; takeover/logout token-version revocation still invalidates them. Non-browser clients using new session-bound tokens must explicitly confirm activity if they need a long interactive session. This is not an MFA system or a reliable physical-device fingerprint.

Main checkout mirrors intentionally appear as uncommitted feature changes. Do not commit/push main automatically; merge the reviewed PRs and reconcile local mirrors before pulling. The previous login-history PRs are prerequisites if they have not yet been merged.
