# India deployment (ap-south-1). Data never leaves this AWS region: no cross-region replication, backups or logs.
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.50" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # State holds generated secrets: keep the bucket private, encrypted and versioned. Configure with:
  #   terraform init -backend-config=backend.hcl   (see backend.hcl.example)
  backend "s3" {}
}

provider "aws" {
  region = "ap-south-1"
  default_tags {
    tags = {
      Project     = "campaign-suite"
      Edition     = "IN"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

module "region" {
  source = "../../modules/region"

  region_code         = "IN"
  environment         = var.environment
  domain_name         = var.domain_name
  acm_certificate_arn = var.acm_certificate_arn
  route53_zone_id     = var.route53_zone_id
  container_image     = var.container_image
  alarm_email         = var.alarm_email
  app_env             = var.app_env
  provider_secrets    = var.provider_secrets

  api_desired_count    = var.api_desired_count
  worker_desired_count = var.worker_desired_count
  db_instance_class    = var.db_instance_class
  db_multi_az          = var.db_multi_az
  single_nat_gateway   = var.single_nat_gateway
}

output "api_url" { value = module.region.api_url }
output "alb_dns_name" { value = module.region.alb_dns_name }
output "vapi_webhook_url" { value = module.region.vapi_webhook_url }
output "ecr_repository_url" { value = module.region.ecr_repository_url }
output "cluster_name" { value = module.region.cluster_name }
output "migrate_task_definition" { value = module.region.migrate_task_definition }
output "private_subnet_ids" { value = module.region.private_subnet_ids }
output "app_security_group_id" { value = module.region.app_security_group_id }
output "app_secret_arn" { value = module.region.app_secret_arn }
