# Backend workflow guide

Only two active GitHub Actions workflows remain:

| Workflow | Purpose |
| --- | --- |
| CI (`ci.yml`) | Existing automated tests/build checks on pushes and pull requests; job names and permissions unchanged. |
| Release backend containers (`release.yml`) | Existing manual release workflow; environment choices, branch policy, OIDC and release guards unchanged. |

For production, run Release backend containers on main with environment prod. It publishes an immutable image only. In soulmed-infrastructure use Prepare production application release, review/merge its image PR, then Deploy production application release (preview before apply). The retained release supports build-only for dev too, so the dedicated dev-image workflow is redundant.

## Archived workflows

- `build-image-dev.yml`
- `test-aws-dev.yml`

Original YAML is retained under docs/workflow-archive/workflows outside .github/workflows. This removes one-time identity/AWS connectivity diagnostics and duplicate dev image builders from current main; historical run records may remain visible in GitHub. No existing CI/release workflow is renamed or modified, and no reusable-workflow references target these archived files.

Merging does not deploy application code, alter AWS IAM, remove resources or change data/secrets. Old branches/tags can still contain these workflow definitions; repository archival is not IAM revocation. Do not restore/run an archived workflow against a retired environment without a deliberate review.
