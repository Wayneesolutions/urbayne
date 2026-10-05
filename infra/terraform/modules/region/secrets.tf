# Every secret lives in ONE Secrets Manager secret (a JSON object), and tasks receive single keys from it.
# Nothing secret is written into task definitions, images, or logs.

resource "random_password" "jwt_access" {
  length  = 64
  special = false
}

resource "random_password" "jwt_refresh" {
  length  = 64
  special = false
}

# PHONE_ENC_KEY encrypts stored phone numbers and PHONE_HASH_KEY makes their lookup hashes.
# Replacing either one makes every stored number unreadable: never rotate them by re-creating these resources.
resource "random_id" "phone_enc" {
  byte_length = 32
  lifecycle { prevent_destroy = true }
}

resource "random_id" "phone_hash" {
  byte_length = 32
  lifecycle { prevent_destroy = true }
}

resource "random_id" "evidence" {
  byte_length = 32
}

locals {
  db_host  = aws_db_instance.main.address
  db_query = "sslmode=verify-full" # encrypted AND the server's certificate is checked (RDS bundle is in the image)

  generated_secrets = {
    JWT_SECRET           = random_password.jwt_access.result
    JWT_REFRESH_SECRET   = random_password.jwt_refresh.result
    PHONE_ENC_KEY        = random_id.phone_enc.b64_std
    PHONE_HASH_KEY       = random_id.phone_hash.b64_std
    EVIDENCE_SIGNING_KEY = random_id.evidence.hex
    # The owner role is for migrations only; the running app uses the cs_app role, which row-level security applies to.
    DATABASE_URL      = "postgres://cs:${random_password.db_owner.result}@${local.db_host}:5432/campaign_suite?${local.db_query}"
    APP_DATABASE_URL  = "postgres://cs_app:${random_password.db_app.result}@${local.db_host}:5432/campaign_suite?${local.db_query}"
    APP_ROLE_PASSWORD = random_password.db_app.result
    REDIS_URL         = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
  }

  all_secrets = merge(local.generated_secrets, var.provider_secrets)
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.prefix}/app"
  description             = "Application secrets for ${local.prefix}"
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(local.all_secrets)
}
