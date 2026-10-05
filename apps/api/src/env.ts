import { z } from 'zod';

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
  // AI assistant (optional; without it the assistant answers extractively from approved text).
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  // Provider costs are billed in USD; these convert them into the campaign's currency for the spending register. Update to the current rate.
  FX_USD_TO_INR: z.coerce.number().positive().default(85),
  FX_USD_TO_CAD: z.coerce.number().positive().default(1.4),
  // Signs evidence PDFs (HMAC). Required in production; in development it falls back to a key derived from JWT_SECRET.
  EVIDENCE_SIGNING_KEY: z.string().min(32).optional(),
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
}).refine((e) => !(e.NODE_ENV === 'production' && !e.EVIDENCE_SIGNING_KEY), {
  message: 'EVIDENCE_SIGNING_KEY is required in production',
});

export type Env = z.infer<typeof schema>;
export const loadEnv = (src: NodeJS.ProcessEnv = process.env): Env => schema.parse(src);
