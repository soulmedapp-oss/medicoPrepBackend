# AI isolation remediation — 7 October 2026

## Result and deployment status

The legacy **AI Tools** navigation group is hidden; **AI Tools V2** remains.
The three reported gaps have application-code fixes with regression coverage.
Restart/deploy the AI API and deploy/reload the frontend together to activate
private image delivery. The backend was not restarted by the assistant.

Commits (local only; not pushed):

- AI service `3c59223`: private media, parent/subject authorization and shared-cache removal.
- Frontend `a512b33`: hide legacy AI Tools menu.
- Frontend `064f0b2`: authenticated image rendering in editors and question displays.

Unrelated existing working-tree changes were excluded from these commits.

## 1. Shared tutor answers

Previously, subject/question cache keys could reuse conversation-dependent answers
across students. Application-level answer reuse is now disabled entirely: cached
answers are neither read nor written. This is a privacy fix, not a new per-user
cache implementation. Repeated questions may therefore make more model calls.
Model-side system-prompt caching is separate and remains available.

The answer-cache setting now resolves to zero, cannot be raised above zero and
explains the privacy restriction in Settings. Startup clears the old
`tutor_answer_cache` collection. Session reuse also requires the same subject
as well as the same user.

Executed against the configured **dev / soulmed_ai_local** database:

- Set `tutor.answer_cache_days` to zero.
- Deleted unsafe answer-cache entries: **0** (the collection was already empty).

This cleanup did not delete chat sessions, accounts or source material. Restart
all AI API instances so older code cannot resume writing unsafe cache entries.
Other environments receive the startup cleanup when the patched API is deployed.

## 2. Private media downloads

`/ai/v2/media/...` and `/ai/figures/...` now require a valid AI token and a
current resource-access check before reading bytes. The legacy import asset
route also uses V2 token validation. Unknown/orphaned assets fail closed.

- Draft/import readers need the relevant feature permission and parent access.
- Teachers must own the subject.
- Content writers may access their own batches/imports across subjects.
- Admins retain staff access to valid parent records.
- Students can read an image only when an active published question references
  it and their current subscription permits it. The new media authorization
  helper uses active plan tiers and checks expiry for paid content.
- New private media responses use `Cache-Control: private, no-store`.
- Image resize checks both the target draft and source image. Saving/submitting/
  approving question content validates private inline/slot image links too.

Frontend image components fetch bytes with an Authorization header, create a
temporary blob URL and revoke it on cleanup. JWTs are never put in image URLs.
Requests are sent only to the configured AI origin, including when stored links
contain an old hostname. Inline rich text, TipTap image views, image previews,
resizing and student question displays use this authenticated delivery path.
Blob URLs remain display-only and are not saved into question content.

Already downloaded bytes cannot be recalled. Old publicly cached copies need
separate browser/CDN invalidation where applicable. Updated clients request the
new private access URL with no-store to avoid their old public-cache entries.
Do not grant public S3/CloudFront access to private AI prefixes; direct storage
permissions can otherwise bypass application authorization.

## 3. Staff capability and subject scope

Jobs are filtered by allowed job types and owned subjects before pagination.
The Overview recent-jobs panel uses this same filtered list; overview-only
permission does not grant access to feature jobs.
Content writers see only their requested jobs. Job detail and cancellation use
the same resource checks; cancellation additionally requires a write capability.

Media-index queries require generation/import/review capability, subject access
and the appropriate source type. Content writers are filtered to their own
parent records.

Generated batch listing/detail and workflow overview now follow the creator and
subject policy. Draft save, submit, submit-all, discard/undo, confirm flags,
AI reread, reset and final decisions authorize the parent. Existing stage locks
and final-review separation remain in force.

Content writers are explicitly limited to their own batches/imports. Legacy
records without a creator cannot silently grant writers access; an admin must
resolve their ownership. Broader content-team collaboration would require an
explicit policy change rather than staff-wide access.

## Verification

- **121 AI tests passed** across isolation, workflow, V2 API, authentication,
  extraction and template import suites.
- A subsequent **35-test isolation/V2 API run passed**, including the added
  Overview bypass regression.
- **9 frontend tests passed** for private-media fetch routing and review navigation.
- Frontend production build succeeded.
- New tests cover anonymous downloads, foreign-subject staff, no-permission
  staff, unrelated writers, active/unpublished questions, expired subscriptions,
  image copying/resizing, job detail/cancellation, draft mutations, cache purge
  and two students asking the same follow-up question.

The tests use synthetic records and mocked model/storage operations. This is
not a claim that every endpoint in the application has been audited or that a
deployed AWS environment has been penetration tested.

## Activation checklist

1. Restart/deploy the patched AI API; ensure all older API instances are replaced.
2. Reload/deploy the frontend containing the authenticated image components.
3. Confirm authorized draft images, resizing and published student images load.
4. Test a known private image URL without authentication: it must return 401.
5. Test teachers from different subjects and content writers with different
   parent records; unauthorized reads and mutations must be denied.
6. Review deployed S3/CDN access and invalidate previously public private-media
   caches if such a cache exists. No AWS policies were modified in this work.

This addresses SEC-01, the AI-media portion of SEC-03, SEC-05 and SEC-06 from the
5 October review. Backend public upload delivery, other legacy-route/auth policy
differences, permission resolution, tutor entitlement/quota concurrency and other
items in that review remain separate work. Hiding the old menu does not retire
its API endpoints.
