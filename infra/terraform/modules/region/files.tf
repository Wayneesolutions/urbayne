# Uploaded files (receipt photos, bank statements, roll copies, voice recordings). One private bucket per region, in that region:
# an Indian campaign's files stay in ap-south-1 and a Canadian campaign's in ca-central-1. The bucket cannot be made public, files are
# encrypted at rest, old versions expire, and only this region's app tasks can read or write.

resource "aws_s3_bucket" "files" {
  bucket = "${local.prefix}-files-${data.aws_caller_identity.current.account_id}"
  # Never delete a bucket that still holds a campaign's records by accident.
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "files" {
  bucket = aws_s3_bucket.files.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id
  versioning_configuration { status = "Enabled" }
}

# A file the app deleted (after an election's retention period) disappears for good a week later; nothing else expires.
resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    id     = "expire-deleted"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 7 }
    abort_incomplete_multipart_upload { days_after_initiation = 2 }
  }
}

# Refuse any request that is not over TLS.
data "aws_iam_policy_document" "files_bucket" {
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.files.arn, "${aws_s3_bucket.files.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "files" {
  bucket     = aws_s3_bucket.files.id
  policy     = data.aws_iam_policy_document.files_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.files]
}

# The app tasks may read, write and delete objects in this bucket and nothing else.
data "aws_iam_policy_document" "task_files" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.files.arn}/*"]
  }
}

resource "aws_iam_role_policy" "task_files" {
  name   = "files-bucket"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_files.json
}
