# SoulMed project handover and laptop recovery

Last updated: 11 October 2026 (Asia/Calcutta).

This document preserves the known work from this collaboration. It is not a claim
that every historical project change has been audited. Use the repository history
and the detailed guides linked below for implementation details.

## 1. Current status: read this first

- Backend, frontend, AI agents, and Terraform changes were committed and pushed.
- Infrastructure now has its own **private** GitHub repository. Terraform source
  was removed from the frontend repository after being saved there.
- No AWS deployment, Terraform apply, production database migration, or live load
  test was performed as part of this work.
- The target is 10,000 concurrent students, with broadcast and interactive classes
  and room for future growth. Actual supported capacity is **not measured yet**.
- Passing regression tests and valid Terraform do not establish production capacity.
- Secrets, local Terraform state, local databases/uploads, and machine credentials
  are not recoverable from the source repositories alone. Back these up separately.

## 2. Repositories, branches, and saved checkpoints

These are the branches used in this collaboration; they were not merged into main.
Commit IDs identify the saved application changes before this handover document.

| Project | GitHub repository | Branch | Checkpoint |
| --- | --- | --- | --- |
| Backend | https://github.com/soulmedapp-oss/medicoPrepBackend | `feature/dkrSeptAPI` | `502d773` (scaling changes in `79e1833`) |
| Frontend | https://github.com/soulmedapp-oss/soulmed | `feature/dkrSept` | `b939cb7` |
| AI agents/API/worker | https://github.com/soulmedapp-oss/soulmed-agents | `dev/deewakar` | `211ec5c` |
| Infrastructure, private | https://github.com/soulmedapp-oss/soulmed-infrastructure | `main` | `6ea4e71` |

Expected local layout (keep this layout because some deployment scripts use siblings):

```text
C:\SoulMedAi\myBranch\
  backend\medicoPrepBackend\
  frontend\soulmed\
  agents\soulmed-agents\
  infrastructure\
    aws\
    uploads-s3\
```

## 3. How the projects fit together

- Frontend: React/Vite student and staff UI; exam taking, results, classes, and AI tools.
- Backend: Node.js/Express/Mongoose application API, authentication, permissions,
  exams, classes, notifications, and OpenAI tutor integration.
- Backend workers: tutor feedback processing and expired-exam/statistics maintenance.
- AI service: Python/FastAPI/LangGraph API and separate durable processing worker;
  AWS Bedrock generation/embeddings, ingestion/extraction, Mongo persistence and
  PostgreSQL/pgvector retrieval. The API validates the application's JWT and access.
- Infrastructure: Terraform and release support for AWS networking, storage,
  CloudFront, API/worker hosting, database options, live video, and monitoring.

The prepared ECS deployment separates API traffic from background jobs. Realtime
notifications use a shared Mongo invalidation feed between backend replicas.
S3 holds durable shared media in the prepared cloud configuration. Live video is
handled by a video provider, rather than streamed through the application API.
Existing Zoom classes are retained; IVS is optional and requires configuration.

## 4. Completed work and its purpose

### Backend

- Immutable exam paper snapshots prevent later question edits changing an active
  student's paper or grade. A unique active-attempt constraint protects exam start.
- Server deadlines and versioned compare-and-set saves prevent stale tabs from
  overwriting newer answers. Changed-answer deltas reduce autosave payloads.
- Students can resume owned attempts; review/grading use the frozen paper.
- A dedicated maintenance worker grades expired attempts and applies replay-safe
  completion statistics. Failed snapshots back off instead of blocking the sweep.
- A shared results cache reduces repeated score-distribution aggregation. Cache
  age is exposed; a cold concurrent request can receive a retryable busy response.
- Tutor work uses durable jobs, renewable leases, owner fencing, checkpoints, and
  bounded retries. Merely reading tutor status does not create billable model work.
- Shared OpenAI concurrency/request/token budgets bound demand across replicas.
- Shared realtime events, socket heartbeats/backpressure, and expiry handling make
  notifications work across replicas. Persisted notifications remain authoritative.
- Cursor-paginated class lists use server-side filters and avoid writes during GET.
- Optional IVS endpoints issue short-lived, authorized playback/stage access.
- Non-root Docker image, bounded DB pools, readiness, graceful shutdown, explicit
  index/default preparation, CI, and manually triggered release workflows added.

Important paths: `src/services/examAttemptService.js`, `src/services/tutorWorker.js`,
`src/services/modelCapacity.js`, `src/services/testStatsCache.js`,
`src/services/realtimeBus.js`, `src/services/ivsService.js`, and `scripts/`.

### Frontend

- Version-aware autosave with changed-answer deltas, local recovery, reconciliation,
  conflict handling, server-aligned timer, and attempt resume behavior.
- Explicit Generate AI feedback action and bounded status polling.
- Reduced/jittered polling and reconnect traffic; hidden-tab work is reduced.
- Video progress avoids duplicate/unchanged writes and normally saves less often.
- Class list pagination/search and Load more controls replace large list fetching.
- Lazy-loaded IVS broadcast and interactive players; server-selected publishers,
  camera/microphone controls, and media cleanup. Zoom joins are retained.
- Updated security headers, CI, and manual S3/CloudFront release workflow.

Important paths: `src/hooks/useExamAutosave.js`, `src/pages/TakeTest.jsx`,
`src/components/classes/LiveSessionPlayer.jsx`, `src/pages/LiveClasses.jsx`,
`src/lib/RealtimeContext.jsx`, and `.github/workflows/`.

### AI service

- Access hardening covers subject/media ownership, legacy endpoints, tutor access,
  and tenant/user isolation. Security guides and regression tests are in the repo.
- Production API/background-worker separation; legacy processing requests enqueue
  durable work instead of relying on API-process background tasks.
- Active-job uniqueness and an outbox repair loop recover interrupted scheduling.
- Shared Bedrock capacity leases and request/token windows bound replica demand;
  local model concurrency and Mongo/pgvector pools are also bounded.
- Readiness endpoint, explicit production preparation, CI and API/worker release
  workflow added. API and workers must share compatible configuration and databases.

Important paths: `app/bedrock/capacity.py`, `app/jobs.py`, `app/worker.py`,
`app/main.py`, `scripts/prepare_production.py`, and `docs/`.

### Infrastructure

- Extracted Terraform source/support files into standalone `aws/` and `uploads-s3/`
  roots. Their state remains independent; do not combine state ownership.
- Prepared optional ECS API and worker deployment, autoscaling, immutable image
  requirements, rolling deployment checks, and rollback support.
- Prepared private networking/NAT, private Multi-AZ RDS production options,
  backups/deletion protection, and a guard against standalone production Mongo.
- Prepared CloudFront routing, optional WAF, operational alarms, and optional IVS.
- CI validates Terraform; release workflow supports plan and explicit apply.
  Optional features are not proof that AWS resources were created or activated.

## 5. Validation recorded before pushing

| Check | Recorded result |
| --- | --- |
| Backend regression tests | 934 passed |
| AI regression tests | 327 passed, 10 skipped, 29 warnings |
| Frontend autosave tests | 8 passed |
| Focused frontend lint | 0 errors, 8 warnings |
| Backend Docker build | Passed using Node 22 Linux image |
| Clean frontend production build | Passed using Node 22 Linux image |
| Main Terraform configuration | Provider-backed validation passed |
| Workflow YAML and release shell syntax | Parsed/checked locally |

These are historical local results, not a report of current GitHub Actions status.
Dependency audits still reported advisories; forced major upgrades were not made.
Real browser video integration, cloud failure recovery, and 10,000-user traffic were
not validated. Work interrupted before a durable AI checkpoint can repeat a provider
call; offline answers never acknowledged by the server cannot be guaranteed saved.

## 6. Back up BEFORE replacing the disk

1. Make a private external-drive backup of **all of `C:\SoulMedAi\myBranch`**, including
   hidden files, ignored files, and `.git` directories. Verify the backup can be read.
2. Preserve `.env`/environment files for all services, local deployment configuration,
   Terraform `backend.hcl`, real variable files, and any key/certificate files.
3. Preserve existing Terraform state if it is local: `*.tfstate` and backups, including
   old frontend `iac` locations. For remote state, record the exact bucket/key,
   region, workspace, and how to authenticate. Source code is not Terraform state.
4. Securely back up relevant `%USERPROFILE%\.aws`, `%USERPROFILE%\.ssh`, `.gitconfig`,
   and any local tool settings you need. Stored Windows/Git credentials may need
   fresh sign-in; copying their files does not guarantee they work on a new install.
5. Export any locally running MongoDB/PostgreSQL or Docker-volume data you need
   using database-supported backup tools. Copy local uploads/source documents too.
   A source-folder backup does not capture data in Docker volumes or elsewhere.
6. Retain access to the GitHub account and MFA recovery method, AWS account, and
   model/payment/email provider accounts. Confirm the private infra repo is visible.
7. Keep the old disk intact until restores, sign-ins, and application checks succeed.

Never upload this private backup or real secrets/state to GitHub. This document
intentionally contains no secret values. Cloud-hosted data is separate from the
laptop, but it needs its own verified backup and access recovery plan.

Local items deliberately not pushed include backend `.env-config-tests/` and
`.review-workflow-tests/`, frontend `.claude/`, caches, environment files, and
Terraform state. There was also an inaccessible local `.shared-storage-tests/`
directory; its contents were not reviewed. Preserve it in the private backup if needed.

## 7. Restore on the new disk

Install Git, Node.js 22, Python matching the AI project's current requirements
(its README identifies Python 3.11), and Terraform matching the workflow
(currently 1.11.4). Install Docker/AWS CLI if using their workflows. Sign in to GitHub.

Run these in PowerShell after creating the corresponding parent directories:

```powershell
git clone --branch feature/dkrSeptAPI https://github.com/soulmedapp-oss/medicoPrepBackend.git C:\SoulMedAi\myBranch\backend\medicoPrepBackend
git clone --branch feature/dkrSept https://github.com/soulmedapp-oss/soulmed.git C:\SoulMedAi\myBranch\frontend\soulmed
git clone --branch dev/deewakar https://github.com/soulmedapp-oss/soulmed-agents.git C:\SoulMedAi\myBranch\agents\soulmed-agents
git clone --branch main https://github.com/soulmedapp-oss/soulmed-infrastructure.git C:\SoulMedAi\myBranch\infrastructure
```

Restore environment/configuration privately, then run `npm.cmd ci` in backend and
frontend. Recreate the Python virtual environment and install dependencies using
the AI setup guide; do not depend on copying `node_modules` or `.venv` across installs.
Restore local data if needed. Use the service READMEs for start commands and test
against development/staging databases first. Do not run migration scripts against
production merely to verify that the laptop restore worked.

For Terraform, reconnect to the **existing** backend/workspace or restore existing
local state before any plan/apply. Never apply an empty state to existing resources.
Encrypted RDS conversion can require snapshot/restore and replacement planning;
review the plan instead of assuming every production toggle is an in-place change.

## 8. Remaining work, in practical order

1. Verify private backups and credentials, then restore the development environment.
2. Review live AWS resources, database HA, state ownership, provider limits, costs,
   and existing deployment configuration. No current cloud inventory was established.
3. Configure GitHub staging/production environments, OIDC IAM roles, ECR/ECS and
   S3/CloudFront values, secrets, and alarm destinations required by the workflows.
4. Back up databases; review duplicate active attempts/jobs before adding unique
   indexes. Prepare backend indexes/defaults and AI indexes/schema in staging first.
5. Coordinate frontend/backend/worker rollout away from active exams. Old cached
   frontends lack answer versions and will have saves rejected by the new backend.
6. Supervise API, tutor worker, maintenance worker, AI API, and AI worker. Verify
   lease recovery, queue processing, readiness, and database connectivity.
7. Configure/test private IVS playback and stage permissions in real browsers;
   confirm quotas. Broadcast and interactive sessions have different capacity costs.
   Advanced composition/recording/hand-raise/breakout product features are not
   delivered by the basic player integration.
8. Run approved staging load tests in steps: 100, 500, 1,000, 5,000, then 10,000;
   include mass start/submit, results, worker restarts, database failure, and restore
   drills. Measure latency, errors, answer loss, queue lag, resource use, and costs.
9. Resolve remaining dependency advisories, review results and production sizing,
   then approve production activation. Do not equate autoscaling settings with capacity.

## 9. Detailed references

Backend repository:
- `docs/scaling-changes-and-rollout.md`: changes, configuration, release/rollback,
  IVS constraints, and deployment prerequisites. Its opening refers to the original
  pre-push batch; the repositories were subsequently pushed on 11 October 2026.
- `docs/architecture-capacity-review-2026-10-10.md`: static architecture assessment.
- `docs/exam-reliability-rollout.md`: exam protocol and migration notes.
- `load-tests/README.md` and `load-tests/exam.js`: staging load harness and drills.

AI repository:
- `docs/scaling-rollout.md`, `docs/security-hardening.md`, and
  `docs/deployment-security-review-2026-10-08.md`.
- `docs/ai-tools-v2/README.md`: current AI setup; some top-level README statements
  describe the older Phase 1 service rather than all current functionality.

Infrastructure repository:
- `README.md`, `aws/README.md`, `uploads-s3/README.md`, and `.github/workflows/`.
  Any earlier instructions to create/publish the repo are historical: it exists now.

## 10. Context to paste into a future assistant conversation

> I am continuing SoulMed after a laptop disk replacement. Read
> `backend/medicoPrepBackend/docs/PROJECT-HANDOVER-AND-DISK-RECOVERY.md` first, then
> the scaling rollout and exam reliability guides. The repos are medicoPrepBackend
> (`feature/dkrSeptAPI`), soulmed (`feature/dkrSept`), soulmed-agents (`dev/deewakar`),
> and private soulmed-infrastructure (`main`) under soulmedapp-oss on GitHub.
> Exam reliability/scaling, durable workers/model budgets, frontend traffic fixes,
> optional IVS, and Terraform/CI/CD were implemented and pushed. They were not
> deployed or proven for 10,000 users. Preserve local edits and secrets, inspect
> current Git/cloud state before acting, and reconnect Terraform to existing state.
> My next task is: [insert what I want to do next].

Update this document after deployment, branch merges, migrations, quota changes,
or measured load tests. A future assistant should verify current files and state
rather than treating this historical handover as live infrastructure evidence.
