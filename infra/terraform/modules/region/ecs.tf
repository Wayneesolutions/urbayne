resource "aws_ecr_repository" "app" {
  name                 = local.prefix
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.prefix}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = local.prefix
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ---- roles: the execution role may read this deployment's secret; the task role can do nothing in AWS ----

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.prefix}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn]
  }
}

resource "aws_iam_role_policy" "execution_secret" {
  name   = "read-app-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secret.json
}

resource "aws_iam_role" "task" {
  name               = "${local.prefix}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# ---- what each kind of task gets ----

locals {
  base_env = merge({
    NODE_ENV        = "production"
    DEPLOY_REGION   = var.region_code
    PORT            = "4000"
    PUBLIC_BASE_URL = "https://${var.domain_name}"
    LOG_LEVEL       = "info"
    # Uploaded files go to this region's own private bucket (files.tf); the app refuses a bucket region that is not its data region.
    STORAGE_DRIVER = "s3"
    FILES_BUCKET   = aws_s3_bucket.files.bucket
    FILES_REGION   = data.aws_region.current.name
  }, var.app_env)

  secret_ref = { for k in concat(
    ["JWT_SECRET", "JWT_REFRESH_SECRET", "PHONE_ENC_KEY", "PHONE_HASH_KEY", "EVIDENCE_SIGNING_KEY", "APP_DATABASE_URL", "REDIS_URL"],
    nonsensitive(keys(var.provider_secrets))
  ) : k => "${aws_secretsmanager_secret.app.arn}:${k}::" }

  app_secrets     = [for k, v in local.secret_ref : { name = k, valueFrom = v }]
  migrate_secrets = [for k in ["DATABASE_URL", "APP_ROLE_PASSWORD"] : { name = k, valueFrom = "${aws_secretsmanager_secret.app.arn}:${k}::" }]

  log_config = {
    logDriver = "awslogs"
    options = {
      "awslogs-group"         = aws_cloudwatch_log_group.app.name
      "awslogs-region"        = data.aws_region.current.name
      "awslogs-stream-prefix" = "app"
    }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name         = "api"
    image        = var.container_image
    essential    = true
    portMappings = [{ containerPort = 4000, protocol = "tcp" }]
    environment  = [for k, v in merge(local.base_env, { RUN_WORKERS = "false" }) : { name = k, value = v }]
    secrets      = local.app_secrets
    logConfiguration = local.log_config
    healthCheck = {
      command     = ["CMD-SHELL", "curl -fsS http://localhost:4000/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 40
    }
    stopTimeout = 30
  }])
}

# Background work (call runs, reminders, cost lookups): its own tasks, so a busy campaign never slows the API.
resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name             = "worker"
    image            = var.container_image
    essential        = true
    command          = ["pnpm", "worker"]
    environment      = [for k, v in local.base_env : { name = k, value = v }]
    secrets          = local.app_secrets
    logConfiguration = local.log_config
    stopTimeout      = 120 # lets the call in progress finish
  }])
}

# One-off: database migrations. The only task that holds the database OWNER credentials.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.prefix}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name             = "migrate"
    image            = var.container_image
    essential        = true
    command          = ["pnpm", "db:migrate"]
    environment      = [for k, v in local.base_env : { name = k, value = v }]
    secrets          = local.migrate_secrets
    logConfiguration = local.log_config
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  health_check_grace_period_seconds = 60
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }
  depends_on = [aws_lb_listener.https]
  lifecycle { ignore_changes = [desired_count] } # autoscaling owns the count
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
}

resource "aws_appautoscaling_target" "api" {
  max_capacity       = max(var.api_desired_count * 3, 6)
  min_capacity       = var.api_desired_count
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.prefix}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification { predefined_metric_type = "ECSServiceAverageCPUUtilization" }
  }
}
