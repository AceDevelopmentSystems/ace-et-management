# Deployment

ace-et-management can be run on premises or in the cloud. Each target lives in its own folder so you only use what you need.

| Folder | Target | Status |
|--------|--------|--------|
| [`docker/`](docker/) | Single host / on-prem via Docker Compose | Placeholder |
| [`kubernetes/`](kubernetes/) | Any Kubernetes cluster (on-prem or managed) | Placeholder |
| [`terraform/`](terraform/) | Cloud infrastructure (AWS, Azure, GCP) | Placeholder |
| [`scripts/`](scripts/) | Helper scripts (backup, migrate, health checks) | Placeholder |

## Conventions
- Configuration comes from environment variables. Never commit real secrets; commit only `.env.example` files.
- Every target should document prerequisites, install, upgrade, backup/restore and uninstall in its own README.
- Keep targets independent: no target should require another.

> The application stack is not yet defined, so these folders contain documentation stubs only.
