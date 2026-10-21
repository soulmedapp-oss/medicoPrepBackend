# Staging capacity validation

Do not run against production. Provision an isolated database and staging deployment,
synthetic verified users on the appropriate plan, and a published exam with a sufficiently
long server deadline. Store credentials in `users.local.json` (ignored by Git):

```json
[{"email":"student00001@staging.example","password":"staging-only-password"}]
```

Install k6, then run from this directory, first with 100 students:

```powershell
$env:LOAD_TEST_APPROVED='staging-only'
$env:BASE_URL='https://your-staging-domain/api'
$env:TEST_ID='staging-test-object-id'
$env:STUDENTS='100'
k6 run --summary-export=results.local.json exam.js
```

Advance through 500, 1,000, 5,000 and 10,000 only after the previous run meets
thresholds. Use a new test or clean staging fixtures between runs; a completed
attempt resumes differently from an active attempt. For simultaneous starts/submits,
set `START_EPOCH_SECONDS` and `SUBMIT_EPOCH_SECONDS` to future Unix timestamps.
Use distributed generators for 10,000 users; monitor generator CPU, sockets and
bandwidth so the generator does not become the bottleneck.

Capture API p95/p99, HTTP errors/429s, ALB target health, ECS CPU/memory and
desired/running tasks, Mongo CPU/IO/connection counts/query latency, finalizer
backlog and oldest overdue deadline, and tutor pending age/failed jobs/provider
throttles. Acceptance requires zero lost acknowledged answers, no duplicate active
attempts, and grading from the original paper. Target finalization within 120 seconds;
measure it rather than assuming configured worker counts achieve it.

Failure drills while the synthetic exam runs:

1. Stop one API task during saves; verify retry/resume and no duplicate attempts.
2. Stop the maintenance task; wait for restart and check overdue attempts drain.
3. Stop a tutor worker after a batch checkpoint; confirm lease expiry and resume
   without repeating checkpointed feedback. Stopping during a provider call may
   repeat that uncheckpointed call and its cost.
4. Disconnect a browser after an acknowledged save and close it at the deadline;
   verify server grading. Unsaved offline edits cannot count as acknowledged saves.
5. Force stale answer versions and late saves; expect 409 and unchanged stored answers.
6. Deny database connectivity in staging; confirm readiness fails and model capacity
   fails closed. Restore access and verify worker recovery.
7. Exercise video separately: many broadcast viewers, limited interactive publishers,
   token refresh, revoked plans, wrong-class access and browser permissions. Arrange
   AWS quota increases before paid large-viewer testing; HTTP API load alone does
   not validate video capacity or billing.

No production capacity claim is valid until these results and a database failover
drill have been recorded for the actual deployment size.
