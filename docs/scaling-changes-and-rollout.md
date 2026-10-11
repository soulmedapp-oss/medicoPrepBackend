# Scaling changes and rollout — 10 October 2026

These are local code and infrastructure changes. No commits were pushed, AWS
resources deployed, database indexes built, or production load tests run in this
batch. The application is **not yet certified for 10,000 concurrent students**.
The earlier capacity assessment remains a static review, not a measured limit.

## What changed, why, and what students see

| Area | Change and reason | Resulting behavior / example |
| --- | --- | --- |
| Exam start and grading | Immutable shared paper, unique active attempt, server deadline and answer-version CAS from the first batch | Refresh resumes the same attempt. Editing a question later does not change the student's paper or grade. A stale tab receives 409 rather than overwriting newer work. |
| Answer traffic | Autosaves send changed questions as `answers_delta`; full sheets remain supported for submit | Changing question 40 sends that selection, rather than all 100 answers. Clearing it sends `[]`. Version checks still protect the entire sheet. |
| Closed-browser completion | Dedicated maintenance worker with bounded parallel grading and shared paper reads per batch | A student who closes the browser is graded from acknowledged answers. A damaged snapshot backs off for five minutes and raises an operational error instead of blocking every sweep. |
| Completion statistics | Batch aggregation and bulk writes, with a durable pending marker | A restart after a counter write retries recomputation safely. The completion request does not wait for all dashboard statistics. |
| Results | Shared Mongo result snapshot, one refresh lease per test, 60-second freshness | 10,000 result viewers reuse the score distribution; each student's percentile is calculated against that snapshot. `as_of` identifies its age. Cold concurrent requests may briefly receive 503/Retry-After while the first snapshot builds. Authorization is checked before cache access. |
| Tutor reliability | Durable TutorSession queue, shared concurrency slots, two-minute renewable leases, owner fencing, checkpoints and bounded retries | Restarting a worker resumes completed feedback batches. An old worker cannot overwrite its successor. A provider call interrupted before checkpointing can still be repeated and billed twice. |
| Tutor demand and cost | Explicit Generate AI feedback action, read-only GET polling, shared OpenAI concurrency/request/token budgets | Merely opening a result does not generate AI work. Feedback queues when requested. Saturated AI capacity does not consume an unbounded number of provider requests. |
| Realtime | Shared indexed Mongo event feed per API replica, socket heartbeats, bounded send buffers and session-expiry closes | A notification created on replica A reaches sockets on replica B, normally after a few seconds. Slow sockets reconnect. The notification database and slower polling remain authoritative; realtime events are refresh hints. |
| Background traffic | Jittered reconnects/polling, foreground-only notification refresh and heartbeat, video-progress change detection | Idle tabs stop sending heartbeat/progress writes. Video progress normally saves every 45–55 seconds, plus pause/end, rather than every 15 seconds while unchanged. |
| Class lists | Cursor pagination, server search/subject/view filters, Load more controls, no writes during GET | A list fetch reads at most 101 rows. Opening a class page no longer updates class status rows. Status is derived from time for display. Legacy array client methods still traverse pages for compatibility; primary student/admin screens load pages on demand. |
| AI API isolation | API worker switch, durable legacy job scheduling, idempotent active-job index and outbox repair loop | With production switches enabled, ingestion/generation run in worker tasks. Interrupted save/enqueue operations are recovered. One worker remains available in the ECS profile even when queue wake-up messages are lost. |
| AI overload | Shared Bedrock leases and per-model request/token windows; bounded local semaphore and DB pools | All replicas share a provider budget. Capacity exhaustion returns a controlled busy error; provider retry backoff remains bounded. Conservative UTF-8 input reservations may reduce throughput below the provider's exact token allowance. |
| Runtime/deployment | Non-root backend container, explicit production index/default preparation, readiness, graceful shutdown, API/worker separation, rolling rollback | Old API tasks drain connections during deployment. Readiness fails when the database disconnects. Production API startup does not rebuild indexes or seed defaults on every scale-out. |
| Databases | Optional private Multi-AZ RDS, longer backups, encryption in the production profile, deletion protection; standalone Mongo production guard | The production profile expects a managed/replicated Mongo URI. Existing single-node Mongo is retained as a development option, rather than silently treated as HA. |
| Live video | Optional private IVS broadcast player and interactive stage player, time/plan checks, server-issued capabilities | Existing Zoom classes keep working. IVS viewers receive short-lived playback authorization. Interactive students are subscribe-only unless explicitly selected; publishers have camera/microphone controls. |
| Operations and release | CI/release workflows, immutable image digests, rollout verification/rollback, WAF option, latency/error/backlog alarms, staging load harness | Releases become repeatable and observable. A stable ECS service that silently rolled back is detected as a failed release. Actual capacity is established through staged tests and failure drills. |

## Prepare before rollout

1. Back up the databases and reattach the infrastructure folder to the **existing**
   Terraform state. Do not initialize a new empty state against live resources.
   Review `C:/SoulMedAi/myBranch/infrastructure/README.md` for the earlier folder move.
2. Run `node scripts/prepareProductionIndexes.js` against the intended staging DB,
   then the production DB during a reviewed migration window. It adds declared
   indexes and never drops or repairs data. Duplicate active attempts must be
   resolved explicitly if the unique index fails. Use
   `node scripts/prepareApplication.js` once for defaults in a fresh database.
3. In the AI repository, run `python scripts/prepare_production.py` with the target
   service environment. The active-job index can reveal existing duplicate jobs;
   review those rather than deleting them automatically. Keep API and workers on
   the same database and index definitions.
4. Deploy backend, frontend and workers as a coordinated protocol release. Cached
   old frontends do not send answer versions; the new backend deliberately refuses
   those saves. Schedule the migration away from active examinations. Existing
   legacy attempts are not automatically given invented deadlines or paper snapshots.
5. Start and supervise the durable workers. A successful API deploy alone does not
   process tutor jobs or overdue exams. Verify worker heartbeats/logs and alarms.
6. Exercise the staging workflow and load/failure tests before switching production
   traffic. Do not infer 10,000-user capacity from the configured task maximum.

## Backend runtime configuration

```dotenv
NODE_ENV=production
RUN_STARTUP_SEEDS=false
MONGO_MAX_POOL_SIZE=20
TEST_STATS_CACHE_ENABLED=true
REALTIME_SHARED_ENABLED=true
MODEL_CAPACITY_ENABLED=true
RATE_LIMIT_FAIL_CLOSED=true
RUN_MAINTENANCE_IN_API=false
TUTOR_GLOBAL_CONCURRENCY=2
OPENAI_GLOBAL_CONCURRENCY=8
OPENAI_REQUESTS_PER_MINUTE=120
OPENAI_TOKENS_PER_MINUTE=100000
OPENAI_TOKENS_PER_DAY=2000000
```

These are initial safeguards, not provider quota approvals or throughput promises.
Set the model limits to the actual account/model quotas and budget. Shared capacity
fails closed if its database is unavailable. Every worker replica must use the same
global limits; reducing limits requires rolling all workers. Store credentials in
SSM/Secrets Manager, not Git or Terraform variable files committed to the repository.

Run `npm run worker:tutor` and `npm run worker:maintenance` as separate supervised
processes locally/staging, or use the prepared ECS task definitions. The long-lived
API retains the first-batch maintenance loop unless explicitly disabled. The Lambda
EventBridge finalizer remains an opt-in alternative, not the high-volume worker path.

The CloudFront → ALB → backend profile sets `TRUST_PROXY=2`. That setting is specific
to those trusted hops and must change if you expose a different network topology.
Uploads use shared S3 storage in ECS; local container disks are not durable storage.

## AWS configuration that still needs real environment values

The infrastructure defaults keep new ECS, IVS and WAF resources off. Supply:

- An immutable backend image URI, backend TLS certificate and DNS name pointing
  to the ALB, database/auth secret ARNs, and the application's remaining runtime
  settings. Create/push the ECR images before bringing up services.
- Two private task subnets with egress, or opt into `backend_manage_private_networking`.
  The supplied subnet/NAT scaffold creates one NAT gateway per AZ and adds cost.
  Check CIDR overlap first. `backend_ecs_enabled` switches CloudFront `/api/*` to
  the TLS ALB origin; Lambda remains available as the previous topology.
- `ai_worker_enabled`, `ai_api_ecs_enabled` and `ai_image_digest_uri` for the AI ECS
  profile. Set frontend `VITE_AI_API_BASE_URL=/ai`. CloudFront strips the first
  `/ai` prefix; existing service routes retain their own `/ai/...` paths. API and
  worker containers use different commands and roll out together.
- A replicated Mongo deployment with tested backups/failover and enough connections
  for every API/worker replica. This change does not provision a managed Mongo
  cluster or migrate production data. Do not treat DocumentDB as an untested
  drop-in replacement for the Mongo operators/indexes used here.
- `ai_pgvector_production=true` for private encrypted Multi-AZ RDS, and a suitable
  instance/storage size. **Enabling encryption on an existing unencrypted RDS
  database may require replacement.** Review the plan and use a snapshot/restore
  migration with validation; do not blindly apply an in-place production conversion.
- An SNS topic ARN with confirmed operational subscribers for alarms. Without
  `backend_alarm_topic_arn`, alarms exist but have no notification destination.
- WAF rate limits tested against shared campus/mobile NAT traffic. They are coarse
  abuse controls, not a student concurrency limit.

## Live-video activation and limits

Keep Zoom as the configured provider until the IVS path has passed real-device
tests. Enable `ivs_enabled`, supply a P-384 playback public key, and store its matching
private key only in the backend secret `IVS_PLAYBACK_PRIVATE_KEY`. Add
`IVS_PLAYBACK_ORIGINS` for allowed site origins. Terraform creates a private broadcast
channel and optional separate interactive stages; it never outputs an ingest stream key.
Configure the teacher encoder's ingest credentials securely in AWS/OBS.

An authorized class editor configures a class using:

```http
PATCH /classes/<id>/live-config
{"live_provider":"ivs-broadcast","ivs_channel_arn":"<Terraform channel ARN>","ivs_playback_url":"<Terraform playback URL>"}
```

For interactive sessions use `live_provider: "ivs-interactive"`, `ivs_stage_arn`,
and up to ten `ivs_publisher_ids`. Give each simultaneous class a separate stage;
do not reuse one channel/stage for unrelated simultaneous classes. Students join
through `POST /classes/:id/live-session`, never by supplying their own publish flag.
Existing publisher sessions are not instantly removed merely by editing the list;
disconnect active participants through IVS for immediate removal.

AWS currently documents 12 simultaneous publishers per stage, a default 10,000
subscribers per stage, and 20,000 concurrent publisher-to-subscriber connections
per region. For example, 10,000 viewers subscribing to five publishers consume
about 50,000 subscriptions, so the default regional subscription quota is insufficient.
Request token-issuance/viewer/subscription quotas before a national event. These
are service quotas, not a claim that this app has passed a 10,000-student test.
See [AWS IVS quotas](https://docs.aws.amazon.com/general/latest/gr/ivs.html) and
[private playback authorization](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/private-channels-generate-tokens.html).

Large audiences normally watch a broadcast; selected students publish interactively.
Thousands of simultaneously publishing cameras require multiple small rooms and
additional product design. Automatic stage composition into a broadcast, hand-raise
moderation, classroom recording/transcription and billing budgets are separate
video-product capabilities; this opt-in player does not silently replace Zoom's features.

## GitHub pipeline setup

Each application now has `.github/workflows/ci.yml` and a manually triggered
`release.yml`. Infrastructure has validation and manual plan/apply workflows.
Create `staging` and `production` GitHub environments and configure production
reviewers/branch restrictions. OIDC role trust must restrict both the exact repository
and `repo:<org>/<repo>:environment:<environment>` subject. No AWS access keys need
to be stored in GitHub.

| Repository | GitHub environment variables / secrets |
| --- | --- |
| Backend | `AWS_REGION`, `AWS_RELEASE_ROLE_ARN`, `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_API_SERVICE`, `ECS_TUTOR_SERVICE`, `ECS_MAINTENANCE_SERVICE` |
| Frontend | `AWS_REGION`, `AWS_RELEASE_ROLE_ARN`, `SITE_BUCKET`, `CLOUDFRONT_DISTRIBUTION_ID`, `VITE_AI_API_BASE_URL`, optional `VITE_WS_URL` |
| AI | `AWS_REGION`, `AWS_RELEASE_ROLE_ARN`, `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_API_SERVICE`, `ECS_WORKER_SERVICE`; expected container names `ai` and `worker` |
| Infrastructure | `AWS_REGION`, `AWS_TERRAFORM_ROLE_ARN`, `BACKEND_REPOSITORY`; secrets `TF_BACKEND_CONFIG`, `TF_VARS`, optional `BACKEND_REPO_READ_TOKEN` for a private backend |

Release roles need the relevant ECR/ECS/PassRole permissions, or S3/CloudFront
permissions for the frontend; Terraform uses a separate reviewed infrastructure
role. Provisioning these account-specific roles/trust policies and GitHub variables
is a deployment prerequisite, not something these local edits have executed.

The infrastructure directory still needs its own repository initialization/remote
before its workflows can run. Preserve the existing state key. Infrastructure plans
contain secrets and are kept on the ephemeral runner instead of uploaded as artifacts.
The manual apply option applies the plan generated by that same run.

Container releases use immutable digests, rolling deployments and circuit-breaker
rollback; they are not traffic-weighted canary deployments. The release script
records previous task definitions and rolls services back if rollout fails. Releasing
the same SHA reuses its existing immutable ECR digest. For rollback after a successful release, restore the recorded
task definitions for all coordinated services. Terraform task definitions must be
kept aligned with the approved image digest to avoid a later apply reverting releases.

Frontend deployment uploads assets before the app shell and retains older hashed
assets for open tabs. The site bucket already has versioning; restore the previous
`index.html` version and invalidate `/` and `/index.html` to roll back.

## Validation and remaining evidence

Backend/AI regression tests, focused frontend lint/build/tests, and provider-backed
Terraform validation were run locally; see the final task report for totals.
The final regression runs passed 934 backend tests, 327 AI tests (10 skipped),
and 8 frontend autosave tests. The backend image and a clean frontend production
build also succeeded with Node 22 in Docker. These checks establish regression coverage, not concurrent-user
capacity or live AWS readiness.
The load harness and failure drills are in `load-tests/README.md`. No generated
student credentials or load-test results are committed.

Compatible dependency patches were applied, including the reported `proxy-addr`
critical finding. Package audits still report other advisories in existing dependency
trees; forced major framework/tooling upgrades were not applied. Review those
before production release rather than treating passing application tests as a clean
dependency audit.

Still required in the actual environment: migration/index preparation, real browser
video verification, quotas/budget confirmation, production-like load results, restore
and failover drills, and measured task/database sizing. Offline edits not acknowledged
by the server remain outside a save guarantee. Existing entitlement/RBAC database
checks are retained; no stale permission cache was introduced to reduce queries.
