# Production releases after cost migration

Production Release workflow now tests, builds, verifies image contents without network access in the container, and publishes an immutable digest. It never deploys to the retired ECS services, regardless of build_only. Development, QA and UAT keep their existing deployment path.

Copy the published digest into soulmed-infrastructure: Prepare production application release (backend_image or agents_image). Merge the generated runtime/review PR, then run Deploy production application release with Apply checked and RELEASE-PRODUCTION-IMAGES. The infrastructure workflow owns candidate ECS, App Runner and finite-worker Step Functions updates together with Terraform state.

Do not change production GitHub ECS target variables to App Runner or manually deploy the image to a service. The production release summary distinguishes publishing from deployment. Production images carry io.soulmed.production-release=1 only after the workflow checks required API/worker files. No container startup or model call is used in that check.
