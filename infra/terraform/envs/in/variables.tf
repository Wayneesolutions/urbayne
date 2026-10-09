variable "environment" {
  type    = string
  default = "prod"
}

variable "domain_name" {
  description = "Public API host for this edition, for example api-in.example.com"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate for domain_name, issued in ap-south-1"
  type        = string
}

variable "route53_zone_id" {
  type    = string
  default = ""
}

variable "container_image" {
  description = "Image URI with tag from this region's ECR repository"
  type        = string
}

variable "alarm_email" {
  type = string
}

variable "app_env" {
  description = "Non-secret app settings. Must include MAIL_FROM"
  type        = map(string)
}

variable "provider_secrets" {
  type      = map(string)
  default   = {}
  sensitive = true
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 2
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "single_nat_gateway" {
  type    = bool
  default = false
}
