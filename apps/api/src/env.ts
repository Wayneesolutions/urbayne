import { z } from 'zod';
import { getRegion } from '@cs/regions';

const schema = z.object({
  APP_DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  // Secret rotation: put the old value here while tokens signed with it are still valid, then remove it.
  JWT_SECRET_PREVIOUS: z.string().min(16).optional(),
  JWT_REFRESH_SECRET_PREVIOUS: z.string().min(16).optional(),
  EVIDENCE_SIGNING_KEY_PREVIOUS: z.string().min(32).optional(),
  DEPLOY_REGION: z.enum(['IN', 'CA']),
  PHONE_ENC_KEY: z.string().min(40),
  PHONE_HASH_KEY: z.string().min(40),
  PORT: z.coerce.number().default(4000),
  // Shared state for several servers: rate limits, sessions, BullMQ queues. Required in production.
  REDIS_URL: z.string().optional(),
  // Run the background workers inside the API process. Set false when workers run as their own process (pnpm --filter @cs/api worker).
  RUN_WORKERS: z.enum(['true', 'false']).default('true'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  // Live providers (optional; demo tenants never use them).
  VAPI_API_KEY: z.string().optional(),
  // Inbound texts from providers other than Twilio (India) call /webhooks/sms/inbound with this shared secret.
  SMS_INBOUND_SECRET: z.string().min(16).optional(),
  VAPI_PHONE_NUMBER_ID: z.string().optional(),
  VAPI_ASSISTANT_ID: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Keep Vapi's audio recordings of calls. Off by default: a voter's voice is personal data and nothing here needs it.
  VAPI_RECORDING: z.enum(['true', 'false']).default('false'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  // India SMS through a DLT-registered provider (MSG91). The sender header is the 6-letter registered DLT header.
  DLT_AUTH_KEY: z.string().optional(),
  DLT_SENDER_ID: z.string().regex(/^[A-Za-z]{6}$/, 'DLT_SENDER_ID must be the 6-letter registered header').optional(),
  DLT_BASE_URL: z.string().url().optional(),
  // AI assistant (optional; without it the assistant answers extractively from approved text).
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  // Provider costs are billed in USD; these convert them into the campaign's currency for the spending register. Update to the current rate.
  FX_USD_TO_INR: z.coerce.number().positive().default(85),
  FX_USD_TO_CAD: z.coerce.number().positive().default(1.4),
  // Signs evidence PDFs (HMAC). Required in production; in development it falls back to a key derived from JWT_SECRET.
  EVIDENCE_SIGNING_KEY: z.string().min(32).optional(),
  // Uploaded files (receipt photos, bank statements, roll copies, voice recordings). 'local' = a folder on this server (development only).
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  FILES_BUCKET: z.string().min(3).optional(),
  // Must be this deployment's own data region (ap-south-1 for IN, ca-central-1 for CA): files never leave the region.
  FILES_REGION: z.string().optional(),
  // S3-compatible endpoint override (MinIO, localstack). Leave empty for AWS.
  FILES_ENDPOINT: z.string().url().optional(),
  FILES_LOCAL_DIR: z.string().default('.files'),
  // Map tiles for the dashboard maps. {z}/{x}/{y} placeholders. The default is OpenStreetMap's public server, which its usage policy
  // allows only for light use: use a tile provider or your own tile server for real campaigns.
  MAP_TILE_URL: z.string().default('https://tile.openstreetmap.org/{z}/{x}/{y}.png'),
  MAP_ATTRIBUTION: z.string().default('© OpenStreetMap contributors'),
  // Road routing for sign drops and canvassing routes: an OSRM server (https://project-osrm.org). Without it routes use straight-line distance.
  ROUTING_BASE_URL: z.string().url().optional(),
  // Error reports (Sentry). Optional: without a DSN errors are only in the logs.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  // Log level: fatal | error | warn | info | debug | trace | silent. Tests default to silent.
  LOG_LEVEL: z.string().optional(),
  NODE_ENV: z.string().default('development'),
  // Email for password reset links and invites. Optional: without SMTP_URL, "forgot password" and email invites are switched off in
  // production (a super admin resets passwords by hand); in development the message and its link are written to the log.
  SMTP_URL: z.string().url().optional(),
  // Sign-in attempts allowed per IP address per 10 minutes (each account is also limited separately).
  LOGIN_MAX_PER_IP: z.coerce.number().int().min(5).default(30),
  MAIL_FROM: z.string().default('Campaign Suite <no-reply@localhost>'),
  // DEV/DEMO ONLY: the forgot-password answer includes the reset token, so a demo works without a mail server.
  DEV_RETURN_RESET_TOKEN: z.enum(['true', 'false']).default('false'),
  // First super admin: created at startup when no super admin exists yet. Remove the password from the environment afterwards.
  SUPERADMIN_EMAIL: z.string().email().optional(),
  SUPERADMIN_PASSWORD: z.string().min(10).optional(),
}).refine((e) => !(e.NODE_ENV === 'production' && !e.REDIS_URL), {
  message: 'REDIS_URL is required in production (rate limits, sessions and call queues must be shared between servers)',
}).refine((e) => !(e.NODE_ENV === 'production' && e.DEV_RETURN_RESET_TOKEN === 'true'), {
  message: 'DEV_RETURN_RESET_TOKEN must never be enabled in production',
}).refine((e) => !(e.NODE_ENV === 'production' && !e.EVIDENCE_SIGNING_KEY), {
  message: 'EVIDENCE_SIGNING_KEY is required in production',
}).refine((e) => !(e.NODE_ENV === 'production' && e.STORAGE_DRIVER !== 's3'), {
  message: 'STORAGE_DRIVER=s3 is required in production (uploaded files must be kept in the region\'s own bucket, not on the server)',
}).refine((e) => e.STORAGE_DRIVER !== 's3' || !!e.FILES_BUCKET, {
  message: 'STORAGE_DRIVER=s3 needs FILES_BUCKET',
}).refine((e) => e.STORAGE_DRIVER !== 's3' || !e.FILES_REGION || e.FILES_REGION === getRegion(e.DEPLOY_REGION).dataRegion, {
  message: 'FILES_REGION must be this deployment\'s own data region (data residency)',
});

export type Env = z.infer<typeof schema>;
export const loadEnv = (src: NodeJS.ProcessEnv = process.env): Env => schema.parse(src);
