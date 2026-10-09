variable "region_code" {
  description = "Which edition this deployment serves. It decides the data region and is passed to the app as DEPLOY_REGION."
  type        = string
  validation {
    condition     = contains(["IN", "CA"], var.region_code)
    error_message = "region_code must be IN or CA."
  }
}

variable "name" {
  type    = string
  default = "campaign-suite"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "single_nat_gateway" {
  description = "One NAT gateway (cheaper) or one per availability zone (survives the loss of a zone)."
  type        = bool
  default     = false
}

variable "domain_name" {
  description = "Public host name of this region's API, for example api-in.example.com. Vapi and the browsers use it."
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate for domain_name, issued in THIS AWS region (create and validate it first)."
  type        = string
}

variable "route53_zone_id" {
  description = "If set, an alias record for domain_name is created in this hosted zone. Leave empty to point DNS yourself."
  type        = string
  default     = ""
}

variable "container_image" {
  description = "Full image URI with tag, from this region's ECR repository (see outputs.ecr_repository_url)."
  type        = string
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 2
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling (GiB)."
  type        = number
  default     = 200
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "db_backup_retention_days" {
  type    = number
  default = 14
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "log_retention_days" {
  description = "Application logs contain no phone numbers, bodies or tokens by design, but keep them no longer than needed."
  type        = number
  default     = 90
}

variable "alarm_email" {
  description = "Where alarms are sent. AWS emails this address once to confirm the subscription."
  type        = string
}

variable "purge_schedule" {
  description = "When the daily personal-data retention job runs (UTC cron). Default 21:30 UTC = 03:00 in India, 15:30 in Winnipeg."
  type        = string
  default     = "cron(30 21 * * ? *)"
}

variable "app_env" {
  description = "Non-secret settings passed to the app, for example MAIL_FROM, FX_USD_TO_INR, DLT_SENDER_ID, SENTRY_ENVIRONMENT."
  type        = map(string)
  default     = {}
  validation {
    condition     = lookup(var.app_env, "MAIL_FROM", "") != ""
    error_message = "app_env must set MAIL_FROM (the sender of password reset emails, for example \"Campaign Suite <no-reply@example.com>\")."
  }
}

variable "provider_secrets" {
  description = "Secret settings for the providers of this region: VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, VAPI_ASSISTANT_ID, VAPI_WEBHOOK_SECRET, TWILIO_*, DLT_AUTH_KEY, SMTP_URL (required: password reset email), SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (first super admin, optional), SENTRY_DSN, ANTHROPIC_API_KEY. Stored in Secrets Manager (and, encrypted, in the Terraform state: keep the state private)."
  type        = map(string)
  default     = {}
  sensitive   = true
  validation {
    condition     = contains(nonsensitive(keys(var.provider_secrets)), "SMTP_URL")
    error_message = "provider_secrets must include SMTP_URL: people sign in with email and passwords, and reset links are sent by email."
  }
}
