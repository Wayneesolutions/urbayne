# Postgres (RDS) and Redis (ElastiCache) with encryption at rest and in transit, backups, and no public access.

resource "random_password" "db_owner" {
  length  = 32
  special = false
}

resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "random_password" "redis" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = aws_subnet.private[*].id
}

# TLS is mandatory for every connection.
resource "aws_db_parameter_group" "main" {
  name_prefix = "${local.prefix}-"
  family      = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name         = "log_min_duration_statement"
    value        = "1000" # slow queries (over 1 s) are logged
    apply_method = "immediate"
  }
  lifecycle { create_before_destroy = true }
}

resource "aws_db_instance" "main" {
  identifier     = local.prefix
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  db_name  = "campaign_suite"
  username = "cs"
  password = random_password.db_owner.result

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.main.name

  backup_retention_period      = var.db_backup_retention_days
  backup_window                = "21:00-22:00"
  maintenance_window           = "sun:22:30-sun:23:30"
  copy_tags_to_snapshot        = true
  deletion_protection          = true
  skip_final_snapshot          = false
  final_snapshot_identifier    = "${local.prefix}-final"
  auto_minor_version_upgrade   = true
  performance_insights_enabled = true
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  lifecycle { prevent_destroy = true }
}

resource "aws_elasticache_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = local.prefix
  description          = "Rate limits, sessions and job queues"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  port                 = 6379

  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result

  # BullMQ needs keys it writes to be kept (not evicted) when memory is tight.
  parameter_group_name = aws_elasticache_parameter_group.main.name

  snapshot_retention_limit = 3
  snapshot_window          = "20:00-21:00"
  maintenance_window       = "sun:21:00-sun:22:00"
  apply_immediately        = false
}

resource "aws_elasticache_parameter_group" "main" {
  name   = local.prefix
  family = "redis7"
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}
