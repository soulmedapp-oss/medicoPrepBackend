# AI service cost and authorization review

> Update, 7 October 2026: SEC-01, the AI-media portion of SEC-03, SEC-05 and SEC-06 have code fixes and regression coverage. See `C:/SoulMedAi/myBranch/docs/AI-Isolation-Remediation-2026-10-07.md` for activation steps, commits, verification and remaining limits. The findings below preserve the original audit evidence.

Review date: 5 October 2026. Status: review backlog; application fixes are not included.

## Decision

**Do not conclude that every endpoint protects every user's data.** The Express application has extensive authentication, permission and ownership controls, but this review confirmed exceptions in the AI service and identified additional access-control inconsistencies. Most importantly, the tutor answer cache can return an answer derived from one student's conversation to another student. This was reproduced with synthetic records, not real student information.

Prioritize isolation and authorization fixes before adding more shared caching or cheaper-model routing. No production accounts, live databases, cloud billing or deployment configuration were inspected. This is a local code review with isolated tests, not a penetration-test certificate.

This dated companion supplements `SoulMed-Security-Review-and-Pending-2026-10-01.docx`, `Security-Review-2026-09-26.docx` and `Pending-and-Needs-Review.docx` in the shared docs folder. Those historical documents remain intact. The canonical version and evidence are committed under the backend's `docs/reviews/2026-10-05/`; the shared docs directory is not a Git repository.

## Scope and evidence

Paths below are relative to these repositories:

- **Backend:** `C:/SoulMedAi/myBranch/backend/medicoPrepBackend`
- **AI:** `C:/SoulMedAi/myBranch/agents/soulmed-agents`
- **Frontend:** `C:/SoulMedAi/myBranch/frontend/soulmed`

The route inventories describe the working tree reviewed, including existing uncommitted AI/frontend work. They are not proof of the deployed version.

| Check | Result | What it establishes |
| --- | --- | --- |
| Express runtime route inventory | 172 routes: 18 public, 18 self-service, 136 permission-gated; zero missing/multiple rule markers or ordering violations | Route registration follows the RBAC convention; controller ownership logic still needs review |
| FastAPI application route inventory | 83 routes: 3 public, 34 legacy-authenticated, 46 V2-authenticated | Identifies which authentication implementation each application route uses |
| Anonymous FastAPI requests | All 80 declared authenticated routes returned 401 | Authentication dependencies reject requests without a token; does not establish object-level authorization |
| Existing backend tests | 541 passed, 0 failed | Selected RBAC, session, security, attempts, discussions and playback regression coverage |
| Existing AI tests | 71 passed | Auth, V2 auth/checks, V2 API and workflow regression coverage |
| Additional isolated AI audit probes | 11 passed | Includes reproduced flaws and successful denial controls; a passing finding test means the flaw exists |

Evidence files beside the canonical document: `express-route-inventory.json`, `ai-route-inventory.json`, `audit_ai.py`. Static mounts, WebSockets and FastAPI's automatically generated documentation endpoints are outside the application route totals. The Express wildcard OPTIONS path serializes as an object in the inventory.

## Security backlog

All items below remain **open**. P0 means address first; P1 means next security hardening batch; P2 means planned improvement. Priority reflects potential impact, not a claim of exploitation.

### SEC-01 — P0 / High: tutor cache crosses student and conversation boundaries

**Evidence: reproduced.** AI `app/v2/tutor.py:66`, `:76`, `:101` and `app/tutor/service.py`. Cache lookup uses subject and normalized question. Model generation can include session history, but cache keys contain neither user nor conversation context. An isolated test gave student B a synthetic answer previously cached for student A for the same follow-up question. Direct session-history access correctly denied B; the cache bypasses that isolation.

**Fix:** immediately stop sharing context-dependent answers across users. Prefer per-user/session caching with a context fingerprint, or cache only explicitly context-free, published-source answers. Include model, prompt and source-version information; invalidate on source changes. Audit existing cache retention and purge unsafe entries as part of remediation.

**Acceptance:** two users with different histories asking the same follow-up never receive each other's contextual answer; changed source/model/prompt invalidates affected entries. Measure safe cache hit rate before claiming savings.

### SEC-02 — P0 / High: legacy AI routes bypass stronger V2 controls

**Evidence: reproduced token-revocation gap; remaining bypasses confirmed in code.** AI `app/auth.py:107`, `app/v2/auth.py`, `app/routers/qa.py:52`, `app/main.py`. Legacy authentication verifies the JWT and active user, but does not enforce V2's AI token scope and token-version checks. A token with an old version was accepted by legacy authentication and rejected by V2. Legacy `/ai/qa/ask` also bypasses V2 tutor enablement, daily quotas, model settings and answer caching. Legacy `require_permission` accepts staff even without the requested capability.

**Fix:** centralize token validation and effective permission resolution. Route legacy tutor calls through the same policy/quota layer or retire them after checking callers. Inventory shared extraction/import dependencies before disabling legacy routes.

**Acceptance:** revoked and wrong-scope tokens fail everywhere; disabling tutor or exhausting quota blocks every tutor entry point; staff without the relevant capability cannot bypass V2 through V1.

### SEC-03 — P0 / High for private material: file URLs do not enforce reader authorization

**Evidence: anonymous AI media access reproduced; other mounts confirmed in code.** AI `app/v2/media.py:300` and `app/routers/figures.py:23` return image bytes without authentication, with long-lived public immutable caching. Media includes draft-question and imported-page imagery. Backend `src/server.js` publicly mounts `/uploads`. Upload authorization does not authorize subsequent downloads. Opaque/random filenames reduce discovery but do not enforce access control.

**Fix:** classify public versus private assets. Protect draft/import/private student assets with parent-record authorization and authenticated delivery or short-lived signed URLs. Ensure private responses are not publicly cached. Review already distributed URLs and CDN caches. Keep intentionally public assets explicitly public.

**Acceptance:** anonymous users and unrelated students cannot download private assets even with a known URL; authorized readers can; publication/unpublication and deletion update access. Verify S3/CDN policy in the deployed environment separately.

### SEC-04 — P1 / Medium: tutor permission and entitlement checks are incomplete

**Evidence: reproduced.** AI `/ai/v2/tutor/ask` requires a valid V2 user but does not enforce `CanUseAiTutor`; the isolated cache request succeeds for a student with no permissions. Subject existence is checked, but paid-content entitlement is not established there. AI user construction also copies `subscription_plan` without the backend's subscription-expiry normalization.

**Fix:** explicitly define whether tutor is available to every active student or permission/plan-gated. Enforce the chosen policy server-side, including accessible subject material and expired plans, consistently across both API versions.

**Acceptance:** no-permission, expired-plan and inaccessible-subject cases match the agreed policy; hiding a menu is never the enforcement mechanism.

### SEC-05 — P1 / Medium: AI staff metadata is not consistently scoped

**Evidence: reproduced.** AI `app/v2/jobs_api.py:18` permits a teacher without feature permissions to list jobs without an owned-subject restriction when no subject filter is provided. `app/v2/media.py:269` permits staff to query another subject's asset index without a corresponding subject/capability check. Synthetic foreign job and asset records were returned to a teacher with an empty permission list.

**Fix:** apply capability and allowed-subject filters before database queries. Preserve intentional content-team collaboration only where policy explicitly allows it. Review cancellation and detail routes alongside listing routes.

**Acceptance:** a teacher from subject A cannot list, inspect or act on subject B's restricted jobs/assets; removing a capability immediately prevents access.

### SEC-06 — P1 / Medium: draft workflow subject checks need alignment

**Evidence: code review; exploit flow not exercised.** AI `app/v2/workflow.py` preparer checks validate staff/capability but do not consistently apply parent-subject/creator restrictions to draft edits, submission, discard and reread. Compare the teacher restrictions in `app/v2/questions.py` and writer ownership rules on imports.

**Fix:** define a shared parent-resource authorization policy and apply it to every draft mutation. Decide explicitly which content-team roles may collaborate across owners; do not accidentally restrict intended team access.

**Acceptance:** cross-subject teachers and unauthorized writers cannot mutate a draft by supplying its parent/draft ID; authorized collaborators can.

### SEC-07 — P1 / Medium: Python and Express resolve permissions differently

**Evidence: code review.** AI `app/auth.py:69` trusts a nonempty user-level permissions array instead of resolving current role permissions. Backend `src/rbac/resolvePermissions.js` resolves the union of active role documents and ignores direct user permissions. AI role/admin normalization also differs. Stale user-level permissions could therefore retain AI access after a role change; some legitimate multi-role users may instead be incorrectly denied.

**Fix:** use one documented effective-permission contract across services, including role union, disabled roles, legacy names, admin handling and revocation. Migrate stale user-level values deliberately.

**Acceptance:** the same synthetic users and role changes produce identical permissions in both services; removing a role permission removes AI access.

### SEC-08 — P1 / Medium: broadcast notification read state is shared

**Evidence: code review.** Backend `src/controllers/notificationsController.js`, `updateNotification`, lets a user mark a notification addressed to `all` as read by updating the single shared `is_read` field. That changes other users' read state. This is cross-user integrity loss, not demonstrated disclosure of private notification text.

**Fix:** store recipient-specific read receipts or per-user notification records. Apply the same design consistently to students/teachers audience notifications.

**Acceptance:** student A marking a broadcast read does not change student B's unread count; neither can update another user's private notification.

### SEC-09 — P1 / Medium: WebSocket lifecycle differs from HTTP authentication

**Evidence: code review; live socket testing pending.** Backend `src/server.js`, `initRealtime`, checks JWT/user/token version at connection time, but does not visibly reject AI-scoped tokens, validate Origin or revalidate access after account/token revocation. Recipients are scoped, which is useful; an already connected session can nevertheless retain stale identity/access until disconnected.

**Fix:** enforce the intended token scope and explicit browser Origin policy; disconnect or revalidate sockets after revocation/deactivation/role changes. Review query-token handling and logging.

**Acceptance:** disallowed origins and token scopes fail; an existing connection loses access promptly after revocation; notifications still reach only their intended audience.

### SEC-10 — P1 / Conditional High: alternate vector stores have incomplete deletion lifecycle

**Evidence: code review, conditional on pgvector/Qdrant use.** AI `app/v2/documents.py:184`, `:203`, `:219` handles chunk listing, chapter tagging and document deletion through Mongo collections, whereas ingestion/retrieval support alternative vector backends. Deleting a document through V2 may leave searchable vectors in an alternative backend. The reviewed local selection was Atlas; this is not a claim that the local Atlas path leaks deleted vectors.

**Fix:** put chunk listing/update/delete behind the active vector-store abstraction and invalidate related answer caches. Handle partial deletion failures and retries.

**Acceptance:** ingest, retag and delete a document separately on every supported backend; deleted/restricted source text must never appear in retrieval or cached answers.

### SEC-11 — P2 / Policy review: diagnostics and public-profile fields

**Evidence: code review.** New settings metadata is conditionally restricted to admins, but older overview/health diagnostics expose some infrastructure/model details to staff. Student-facing teacher directory responses intentionally include teacher email and public-profile fields. FastAPI's default `/docs`, `/redoc` and `/openapi.json` are also not gated by application route dependencies.

**Fix:** decide which metadata is truly admin-only and minimize directory fields. Disable or protect development documentation in production if it is not intended to be public. Public schema visibility alone is not equivalent to access to protected data.

**Acceptance:** explicit role/field response tests cover the agreed visibility policy, including multi-role accounts.

## Controls that were present

The backend has server-side route authorization rather than relying only on menu visibility. Reviewed protections include self-profile sensitive-field rejection, role/permission escalation checks, last-admin protection, own-attempt writes and answer-key restrictions, own video progress and class notes, owner-scoped payments/subscriptions, filtered doubts/feedback, group membership checks and discussion identity/lecture gates. Intentional shared or privileged access still depends on the assigned permission policy.

AI V2 validates token scope and version. An isolated student request to settings, status, jobs and media index returned 403. Reading another student's tutor session returned 404 without its contents. These controls are useful but do not negate the cache or public-file exceptions above.

## AI quality and cost backlog

All items are proposed work. No savings percentage is claimed without production measurements.

| ID / priority | Finding and evidence location (AI repository) | Proposed change and acceptance |
| --- | --- | --- |
| COST-01 / P0 | Shared cache is unsafe and does not reflect source/model changes (`app/v2/tutor.py`) | Fix SEC-01 before optimizing hit rate; track safe hits, invalidations and cost per accepted answer |
| COST-02 / P1 | Tutor quota is checked before the model call and usage recorded afterward (`app/v2/tutor.py`, `app/v2/usage.py`); concurrent calls can pass the same remaining allowance | Atomically reserve quota, settle actual use and release failed reservations; concurrency test must never admit more than the allowance |
| COST-03 / P1 | Initial AI extraction does not consistently use the UI-selected extraction model, unlike reread (`app/extraction/service.py`, `app/extraction/vision.py`, `app/v2/workflow.py`) | Resolve effective model settings at job start, record model/version on each job, and test initial extraction as well as reread |
| COST-04 / P1 | Cost estimates use limited token accounting and fallback model prices (`app/bedrock/cost.py`, `app/v2/usage.py`, tutor call path); query embeddings and prompt-cache accounting need completeness | Record generation, embeddings, cache reads/writes, retries and other billable extraction stages; mark unknown prices as unknown and reconcile with billing |
| COST-05 / P1 | Daily spend alert is an alert, not a hard spending limit (`app/v2/settings.py`, usage flow) | Label clearly; add an atomic budget admission mechanism if a hard cap is required, accounting for in-flight calls |
| QUAL-01 / P1 | Tutor marks successful responses with retrieved chunks as grounded; citation support is not independently verified, and truncation is not reliably excluded before caching (`app/tutor/service.py`, `app/v2/tutor.py`) | Validate citation references, capture completion/stop reasons and refuse to cache incomplete answers; evaluate support with a reviewed medical question set |
| QUAL-02 / P1 | Chunking is custom heading-based structural plus size/overlap logic (`app/ingestion/chunking.py`, `app/ingestion/graph.py`), not a semantic chunking model; zero overlap and heading-boundary handling have edge cases | Honor zero overlap end-to-end (avoid falsy default substitution), avoid carrying text across unrelated headings, preserve tables/questions, and test exact boundaries |
| QUAL-03 / P2 | V2 chunk defaults and environment fallbacks differ; long chunks are truncated in tutor context assembly (`app/v2/settings.py`, ingestion graph, `app/tutor/service.py`) | Unify effective defaults and display units; align chunk size with the actual context budget and measure retrieval recall, truncation and tokens |
| COST-06 / P2 | Prompt caching targets a short system prefix; enabling it does not demonstrate a cache hit (`app/tutor/service.py`) | Measure actual cache-read/write tokens and provider eligibility for each model; optimize stable prefixes only when quality and billing measurements justify it |
| COST-07 / P2 | Generation sub-batches resend source context (`app/generation/service.py`, `app/generation/graph.py`) | Measure duplicate input tokens; tune batch size/context reuse against quality, output limits and retry cost |
| QUAL-04 / P2 | No dedicated reranking or RAGAS evaluation path was found in the reviewed AI code | Start with a versioned, staff-reviewed retrieval/answer evaluation set. Compare recall, citation support, abstention, latency and cost. Trial reranking only if retrieval errors justify its extra call/latency; use RAGAS as an optional offline evaluation aid, not an automatic clinical correctness guarantee |
| COST-08 / P2 | Embedding model changes affect existing vectors, while generation changes affect subsequent calls | Validate provider/model compatibility and dimensions, plan versioned re-embedding and atomic index cutover; do not merely switch a UI model string and query incompatible old vectors |

Suggested sequence: (1) SEC-01 to SEC-03; (2) unify authorization and quota admission; (3) fix model-setting and vector lifecycle consistency; (4) measure complete costs and create evaluation baselines; (5) tune chunking/context/batching; (6) experiment with model routing and reranking against that baseline.

## Prior review items requiring separate verification

Existing security reviews reported committed credentials, a credential CSV in the shared docs folder, root access keys, tracked upload artifacts, public storage permissions and infrastructure/network concerns. **Their present remediation status was not verified in this audit.** Do not interpret omission from the reproduced findings as resolution. Never copy credential values into this document. Confirm rotation/revocation, history cleanup and deployed storage/network policy with the responsible administrator.

## Reproduction and next review

Run from the backend root for the JavaScript checks:

```powershell
node --test test/rbac*.test.js test/session.test.js test/security.test.js test/testsAttempts.test.js test/testsLocked.test.js test/discussions*.test.js test/videoPlayback.test.js
```

Run the isolated probes from the backend root using the sibling AI virtual environment:

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
& C:/SoulMedAi/myBranch/agents/soulmed-agents/.venv/Scripts/python.exe -m pytest docs/reviews/2026-10-05/audit_ai.py -q -p no:cacheprovider --basetemp=.security-probes-pytest
```

Run the existing Python checks from the AI repository:

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
& .venv/Scripts/python.exe -m pytest tests/test_auth.py tests/test_checks_and_v2_auth.py tests/test_v2_api.py tests/test_workflow.py -q -p no:cacheprovider
```

The audit probes use synthetic records and mocked model/storage results. Tests named `finding` deliberately assert today's vulnerable behavior: change their assertions into denial/isolation regression checks when fixing the issue. They depend on the current sibling repository layout and are audit evidence, not a permanent passing-security badge.

Before declaring isolation complete, run an authenticated endpoint/resource matrix in staging with two students, two differently assigned teachers, content roles and an admin. Cover read/list/create/update/delete/download/export, valid foreign IDs, batch IDs, pagination, websockets, expired/revoked tokens, removed permissions, unpublished content and signed-link expiry. Verify cloud policies, reverse-proxy routes, production versions, log redaction and cache/CDN behavior separately. Re-run route inventory checks whenever routes change.

Track each item by ID, owner, target date, fixing commit, regression test and deployed verification. Keep related fixes in separate logical commits; do not push without authorization.
