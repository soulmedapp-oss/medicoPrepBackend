# Backend production releases

Use the existing release workflow with branch `main`, environment `prod`.
For first deployment only, select `build_only` to test/build/publish without
requiring an ECS service. Copy the immutable image URI from the job summary
into the infrastructure production configuration. For normal deployments,
leave `build_only` unchecked; deployment and readiness checks then run.

The production role, ECR, ECS services and environment variables must exist.
Follow `docs/production-deployment.md` in `soulmed-infrastructure` for the
complete initial rollout and variable matrix. Database values remain in SSM,
not this repository. Production is isolated from dev within the same AWS
account. Do not run app releases concurrently with production runtime sync.
