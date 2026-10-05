# Production infrastructure (P0 item 9)

One Terraform module, deployed **twice and independently**: India (`envs/in`, AWS `ap-south-1`) and Canada (`envs/ca`, AWS `ca-central-1`). Each edition has its own VPC, database, Redis, secrets, logs and backups, in its own region. Nothing is replicated across regions, so data residency holds by construction.

> **Status: written, not yet applied or validated.** `terraform` is not installed on the machine this was written on, so `terraform validate` / `plan` have **not** been run. Expect small fixes on the first `terraform validate` and `plan`; treat the first apply as a rehearsal in a throw-away AWS account (use `environment = "staging"`).

## What it creates (per edition)

| Part | What |
| --- | --- |
| Network | VPC, 2 public subnets (load balancer, NAT), 2 private subnets (app, database, Redis); security groups allow only: internet -> load balancer (443; 80 redirects), load balancer -> app (4000), app -> database (5432), app -> Redis (6379) |
| TLS | HTTPS listener with your ACM certificate (TLS 1.2/1.3 policy), HTTP redirects to HTTPS; database connections require TLS and the app verifies the server certificate; Redis uses TLS and an auth token |
| App | ECS Fargate: `api` service (behind the load balancer, autoscaling on CPU, health check on `/ready`), `worker` service (BullMQ jobs: call runs, reminders, cost lookups), a one-off `migrate` task, and a daily EventBridge schedule for the personal-data retention job |
| Database | RDS Postgres 16: encrypted, Multi-AZ (default), 14-day automated backups + final snapshot, deletion protection, storage autoscaling, slow-query and upgrade logs, Performance Insights |
| Redis | ElastiCache Redis 7 replication group (2 nodes, failover), encrypted at rest and in transit, `noeviction` so queue data is never silently dropped |
| Secrets | One Secrets Manager secret (JSON). Generated: JWT secrets, phone encryption and hash keys, evidence signing key, database passwords. You provide: Vapi, Twilio / DLT, Sentry keys. Tasks get single keys; the database OWNER credentials exist only in the migrate task |
| Observability | CloudWatch logs (retention 90 days), Container Insights, and alarms to an SNS topic that emails you: API 5xx, unhealthy hosts, slow responses, database CPU / disk / memory / connections, Redis CPU / memory, worker not running, app errors, failed jobs, failed retention purge |
| Registry | ECR repository (immutable tags, scan on push) |

## Before the first apply (manual, once per edition)

1. An AWS account (or one account per edition) and credentials for Terraform.
2. A **state bucket + lock table in the same region** (private, versioned, encrypted). The state contains generated secrets, so access to it is access to production.
3. A DNS name for the API (for example `api-in.example.com`) and an **ACM certificate for it in that AWS region**, validated.
4. Provider accounts: Vapi (phone number + assistant, see `docs/vapi-setup.md`), Twilio Messaging Service (Canada) or MSG91 + DLT registration (India), Sentry project (optional).

## Deploy

```bash
cd infra/terraform/envs/in          # or envs/ca
cp backend.hcl.example backend.hcl && cp terraform.tfvars.example terraform.tfvars   # edit both
terraform init -backend-config=backend.hcl

# 1) create the registry first, then push an image
terraform apply -target=module.region.aws_ecr_repository.app
docker build -t <ecr_repository_url>:<tag> ../../../..   # repo root has the Dockerfile
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <registry>
docker push <ecr_repository_url>:<tag>

# 2) everything else (set container_image to that tag; put provider secrets in secrets.auto.tfvars)
terraform apply

# 3) run the database migrations once (and after every release that adds a migration)
aws ecs run-task --cluster <cluster_name> --task-definition <migrate_task_definition> --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<private_subnet_ids>],securityGroups=[<app_security_group_id>],assignPublicIp=DISABLED}"
```

Then: confirm the SNS email subscription, point DNS at `alb_dns_name` (or give `route53_zone_id`), open `https://<domain>/ready` (expect `{"ok":true,...}`), and put `vapi_webhook_url` in your Vapi setup. Set each campaign's `retentionDays` (counsel decides the number) so the daily job knows when to delete.

Releases: build and push a new immutable tag, change `container_image`, `terraform apply` (the ECS circuit breaker rolls back a release whose tasks never become healthy), then run the migrate task if there are new migrations.

## Things to know

- **Costs** (rough, 2 Fargate tasks each for API and worker, Multi-AZ `db.t4g.medium`, 2-node `cache.t4g.small`, NAT gateways): in the order of USD 400 to 600 per month per edition before traffic. `single_nat_gateway = true`, `db_multi_az = false` and fewer tasks cut that for staging.
- **Phone keys are forever.** `PHONE_ENC_KEY` and `PHONE_HASH_KEY` are created once and marked `prevent_destroy`. Replacing them makes every stored number unreadable. Rotation needs a re-encryption job (not built).
- **Database deletion protection is on** (and `prevent_destroy`). Destroying production takes deliberate steps.
- **Backups**: RDS automated backups (14 days, point-in-time restore). Do a restore drill into a scratch instance before launch and write down the steps and the time it took.
- **Not included yet**: WAF, VPC flow logs, cross-account log archive, a CI deploy pipeline (needs AWS OIDC set up in your GitHub), Redis/DB credential rotation, and S3 for receipt photos (Phase 4).
