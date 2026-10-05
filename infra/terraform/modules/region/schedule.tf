# Daily personal-data retention job: deletes data of campaigns past their retention date (pnpm --filter @cs/api purge:due).

data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "events" {
  name               = "${local.prefix}-events"
  assume_role_policy = data.aws_iam_policy_document.events_assume.json
}

data "aws_iam_policy_document" "events_run_task" {
  statement {
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task-definition/${aws_ecs_task_definition.api.family}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
  }
}

resource "aws_iam_role_policy" "events_run_task" {
  name   = "run-purge-task"
  role   = aws_iam_role.events.id
  policy = data.aws_iam_policy_document.events_run_task.json
}

resource "aws_cloudwatch_event_rule" "purge" {
  name                = "${local.prefix}-retention-purge"
  description         = "Daily deletion of personal data past its retention date"
  schedule_expression = var.purge_schedule
}

resource "aws_cloudwatch_event_target" "purge" {
  rule     = aws_cloudwatch_event_rule.purge.name
  arn      = aws_ecs_cluster.main.arn
  role_arn = aws_iam_role.events.arn
  input = jsonencode({
    containerOverrides = [{
      name    = "api"
      command = ["pnpm", "--filter", "@cs/api", "purge:due"]
    }]
  })
  ecs_target {
    task_definition_arn = aws_ecs_task_definition.api.arn
    launch_type         = "FARGATE"
    task_count          = 1
    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.app.id]
      assign_public_ip = false
    }
  }
}
