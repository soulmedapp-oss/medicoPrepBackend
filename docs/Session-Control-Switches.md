# Configurable session restrictions

Prepared 5 November 2026. Inactivity logout and the single-device restriction are independent switches. The reviewed production settings set both to false; no production setting is changed just by these application PRs.

| Setting | false | true |
| --- | --- | --- |
| SESSION_IDLE_TIMEOUT_ENABLED | No idle warning or inactivity logout | Enforce the configured idle period and warning countdown |
| SESSION_SINGLE_DEVICE_ENABLED | Allow multiple signed-in browsers/devices | Warn before taking over another device and revoke the old session on confirmation |

Both may be enabled independently. Existing SESSION_IDLE_MINUTES=20 and SESSION_WARNING_SECONDS=120 remain available for later use. Unset switches preserve the existing enabled behavior during a staged rollout. Only an explicit false disables each restriction; new application builds alone do not change current production enforcement.

## Local testing in the normal checkouts

The reviewed source edits are mirrored into the usual backend/frontend/agents folders as uncommitted changes; existing .env files are preserved. In the backend .env add:

```dotenv
SESSION_IDLE_TIMEOUT_ENABLED=false
SESSION_SINGLE_DEVICE_ENABLED=false
```

Restart the agents and backend with the new code and reload the frontend. Sign in on two browsers using the same account. Both should remain signed in; signing out one should not sign out the other. An idle browser should show no inactivity warning. Test either switch with true to re-enable it independently, restarting the backend after editing .env. Do not add private values to Git.

## Authentication and security behavior

The backend now tracks each browser session separately, with a bounded account session collection and atomic updates so concurrent sign-ins/refreshes do not replace other browsers. Each refresh credential remains hashed and rotated; an indexed, short grace record handles parallel refreshes without replacing the winning browser cookie. No new database index is required; existing refresh lookup indexes are reused. Private session records and revision metadata are excluded from user API payloads.

When multi-device mode is enabled (single-device restriction false), a normal login does not bump the account's global token version, and normal logout removes only the requesting browser's session. Password resets/changes, account deactivation and administrative global revocation still invalidate all sessions. JWT expiry, refresh credential expiry and the normal absolute session lifetime remain enforced. Disabling inactivity timeout is not an infinite credential lifetime.

The frontend reads the backend policy and suppresses its timer/heartbeat/warning when idle logout is disabled. It still honors genuine authentication failures such as password revocation or absolute expiry. Agents receive the authenticated policy in signed short-lived AI tokens and validate the specific browser session against the user record. Older tokens with no policy claim retain strict behavior during rollout. Policy changes can take up to the five-minute AI token lifetime to propagate to already-minted AI tokens; per-session and global revocation are still checked against database state.

Existing session records are migrated when used, without a bulk user-data rewrite. Previously revoked sessions are not resurrected. After re-enabling restrictions, users may need to sign in again, particularly when earlier idle activity dates are already past the newly active deadline.

## Production rollout: application support first

1. Review/merge the backend, agents and frontend feature PRs. Backend and agents images add io.soulmed.session-control-switches=1 capability labels.
2. Build the backend and agents production images from main (build-only). Promote them through Prepare production application release, merge the generated image review PR, then Deploy production application release (preview first, confirmed apply second). Deploy frontend main as well.
3. Keep the infrastructure session-switch PR in draft until those compatible images are deployed. Its current review snapshot describes the previous two-setting source and is intentionally not accepted for this change.
4. Refresh that infrastructure branch from main after image deployment. Generate a fresh private session plan/review with `python scripts/configure-production-sessions.py --prepare-review --private <private-directory>`, using authenticated Terraform/AWS access. Only the two switch parameters, existing exact read-policy update, retained API revision and service selection may change. Current reviewed image digests must stay the same.
5. Update the existing soulmed-session-parameter-management managed policy using environments/prod/permissions/production-parameter-management.json. It preserves Google/timing paths and adds the two exact switch parameter paths. Do not create a new managed policy for each setting.
6. Review/merge the refreshed infrastructure PR. Run Configure production session parameters on main with Apply unchecked. The workflow verifies the backend AND agents image capability labels before allowing configuration.
7. After the preview passes, run with Apply checked and confirmation CONFIGURE-SESSION-PARAMETERS. This injects false values into the backend at task startup. The API restart can briefly interrupt requests on the existing single-host deployment. Workers/consumers, images, routing and data are not changed by the flag configuration.
8. Sign in on two browsers and verify both stay active; test logout on one. Leave a browser idle beyond the old warning period and verify no idle warning/logout.

No new GitHub workflow is added: the existing session configuration workflow manages timing and switches. Older/incompatible images are rejected before planning/applying policy changes. The current infrastructure branch is a draft because its frozen review must be regenerated against the subsequently deployed images; do not merge that draft before the app rollout and fresh plan.

## Parameter Store locations and future re-enabling

- /soulmed/prod/session/SESSION_IDLE_TIMEOUT_ENABLED
- /soulmed/prod/session/SESSION_SINGLE_DEVICE_ENABLED

They are Standard String parameters whose runtime values are lowercase true/false, sourced from JSON booleans in session-settings.json. The ECS execution role reads them once at container startup; application requests read process memory, not Parameter Store.

Later set either JSON boolean to true, generate/review a fresh private session plan and apply through the same workflow. A value-only change triggers an API deployment so running containers reload the values. The agents read the signed backend policy, so they need no new parameter lookup or per-request AWS call. No application rebuild is required merely to change these flags after compatible code is deployed.

## Validation

Backend session tests cover all four combinations, multi-device sign-in and refresh races, browser-only logout, same-browser reauthentication, preserved legacy sessions, absolute expiry and global revocation. Agents tests cover signed policies and missing/malformed claims. Frontend tests include a real component timer test proving disabled policy causes no warning or automatic logout. Infrastructure guards serialize booleans as lowercase strings, preserve unrelated resources, and block incompatible images before planning.
