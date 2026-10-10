# Development data reset — 6 October 2026

User authorized clearing both configured Mongo databases and both S3 buckets, then explicitly excluded user accounts and permissions. Roles were also preserved to retain account access.

## Verified result

| Target | Result |
| --- | --- |
| Mongo `dkrTest` | Deleted 114 records outside the protected collections; zero remaining in those collections |
| Protected backend records | 4 users, 4 roles, 86 permissions; complete document fingerprints unchanged |
| Mongo `soulmed_ai_local` | Deleted 1,796 records; all 17 collections empty, including all 145 chunks, drafts, imports, settings, caches and checkpoints |
| S3 `soulmed-dev-ai-ingest` | Deleted 825 current objects; current object listing empty |
| S3 `soulmed-uploads-thumbnails` | 5 objects remain; deletion returned `AccessDenied` using both AI and backend configured credentials |

Database collections and indexes were retained. Buckets were retained. Historical S3 versions/delete markers could not be listed with the available credentials, so permanent removal of older versions is **not verified**. No IAM policies, active configuration, local upload folders or external video-provider assets were changed.

Machine-readable evidence: `2026-10-06-data-reset-result.json`. The reset utility is `scripts/reset_confirmed_dev_data.py`; it defaults to dry-run and checks the approved AI Mongo host/database, app Mongo host/database, bucket and Atlas vector backend before execution. It is deliberately restricted to this confirmed development scope. Do not rerun it on new data without authorization.

## Remaining AWS work

An authorized AWS administrator must allow the reset identity to delete objects in `arn:aws:s3:::soulmed-uploads-thumbnails/*` (`s3:DeleteObject`), or delete the five objects through an identity that already has access. An explicit bucket/IAM deny may also need review; an additional Allow alone may not resolve it.

To verify and, if present, permanently purge historical versions in the two approved buckets, the identity needs `s3:ListBucketVersions` on the bucket ARNs and `s3:DeleteObjectVersion` on their object ARNs. `s3:GetBucketVersioning` is also currently denied. Do not broaden permissions to unrelated buckets. No bucket deletion is needed.

## Local services

Stopped the verified backend processes and local AI API/worker processes before deleting records. The frontend was left running. Services have **not** been restarted, to avoid recreating worker heartbeats or seeded data during verification.

When ready, restart the stack from `C:/SoulMedAi/myBranch/agents/soulmed-agents/scripts/start-dev.ps1 -Restart` in your normal development terminal. Startup may recreate defaults and operational records; this does not indicate that the cleared question/chunk content survived. Account documents were preserved intact, including profile/subscription/statistic fields; no profile reset was performed.

Current `APP_ENV` was unset. No production or additional environment databases/buckets were enumerated for deletion.
