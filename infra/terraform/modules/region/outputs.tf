output "ecr_repository_url" {
  description = "Push this region's image here (the repository is created by the first apply; the service needs the image to exist)."
  value       = aws_ecr_repository.app.repository_url
}

output "api_url" {
  value = "https://${var.domain_name}"
}

output "alb_dns_name" {
  description = "Point domain_name at this (CNAME) if route53_zone_id was not given."
  value       = aws_lb.main.dns_name
}

output "vapi_webhook_url" {
  value = "https://${var.domain_name}/webhooks/vapi"
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "migrate_task_definition" {
  value = aws_ecs_task_definition.migrate.family
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}

output "app_secret_arn" {
  description = "Secrets Manager secret holding every key the app uses (read it with the AWS CLI; never commit it)."
  value       = aws_secretsmanager_secret.app.arn
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "data_region" {
  value = data.aws_region.current.name
}

output "files_bucket" {
  description = "Private bucket for uploaded files (receipts, statements, roll copies, recordings), in this region."
  value       = aws_s3_bucket.files.bucket
}
