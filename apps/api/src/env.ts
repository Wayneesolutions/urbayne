import { z } from 'zod';
import { validateDltTemplate } from '@cs/channels';

const schema = z.object({
  APP_DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  DEPLOY_REGION: z.enum(['IN', 'CA']),
  OTP_PROVIDER: z.enum(['console', 'twilio', 'dlt']).default('console'),
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
  VAPI_PHONE_NUMBER_ID: z.string().optional(),
  VAPI_ASSISTANT_ID: z.string().optional(),
  VAPI_WEBHOOK_SECRET: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  // India SMS through a DLT-registered provider (MSG91). The sender header is the 6-letter registered DLT header.
  DLT_AUTH_KEY: z.string().optional(),
  DLT_SENDER_ID: z.string().regex(/^[A-Za-z]{6}$/, 'DLT_SENDER_ID must be the 6-letter registered header').optional(),
  DLT_BASE_URL: z.string().url().optional(),
  // Login-code SMS (OTP_PROVIDER=dlt): the registered template id and its exact text with ONE {#var#} for the code.
  DLT_OTP_TEMPLATE_ID: z.string().regex(/^\d{10,25}$/).optional(),
  DLT_OTP_TEMPLATE_TEXT: z.string().max(1000).optional(),
  // AI assistant (optional; without it the assistant answers extractively from approved text).
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  // Provider costs are billed in USD; these convert them into the campaign's currency for the spending register. Update to the current rate.
  FX_USD_TO_INR: z.coerce.number().positive().default(85),
  FX_USD_TO_CAD: z.coerce.number().positive().default(1.4),
  // Signs evidence PDFs (HMAC). Required in production; in development it falls back to a key derived from JWT_SECRET.
  EVIDENCE_SIGNING_KEY: z.string().min(32).optional(),
  // Error reports (Sentry). Optional: without a DSN errors are only in the logs.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  // Log level: fatal | error | warn | info | debug | trace | silent. Tests default to silent.
  LOG_LEVEL: z.string().optional(),
  NODE_ENV: z.string().default('development'),
  // DEV/DEMO ONLY: return the OTP in the API response so a demo can log in without SMS.
  DEV_RETURN_OTP: z.enum(['true', 'false']).default('false'),
}).refine((e) => !(e.NODE_ENV === 'production' && !e.REDIS_URL), {
  message: 'REDIS_URL is required in production (rate limits, sessions and call queues must be shared between servers)',
}).refine((e) => !(e.NODE_ENV === 'production' && e.DEV_RETURN_OTP === 'true'), {
  message: 'DEV_RETURN_OTP must never be enabled in production',
}).refine((e) => !(e.NODE_ENV === 'production' && e.OTP_PROVIDER === 'console'), {
  message: 'OTP_PROVIDER=console is for development only; use twilio (CA) or dlt (IN) in production',
}).refine((e) => e.OTP_PROVIDER !== 'twilio' || !!(e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && e.TWILIO_MESSAGING_SERVICE_SID), {
  message: 'OTP_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID',
}).refine((e) => e.OTP_PROVIDER !== 'dlt' || !!(e.DLT_AUTH_KEY && e.DLT_SENDER_ID && e.DLT_OTP_TEMPLATE_ID && e.DLT_OTP_TEMPLATE_TEXT), {
  message: 'OTP_PROVIDER=dlt needs DLT_AUTH_KEY, DLT_SENDER_ID, DLT_OTP_TEMPLATE_ID and DLT_OTP_TEMPLATE_TEXT',
}).refine((e) => e.OTP_PROVIDER !== 'dlt' || !e.DLT_OTP_TEMPLATE_TEXT || (() => { const c = validateDltTemplate(e.DLT_OTP_TEMPLATE_TEXT); return c.ok && c.varCount === 1; })(), {
  message: 'DLT_OTP_TEMPLATE_TEXT must be a valid DLT template with exactly one {#var#} (the code)',
}).refine((e) => !(e.NODE_ENV === 'production' && !e.EVIDENCE_SIGNING_KEY), {
  message: 'EVIDENCE_SIGNING_KEY is required in production',
});

export type Env = z.infer<typeof schema>;
export const loadEnv = (src: NodeJS.ProcessEnv = process.env): Env => schema.parse(src);
