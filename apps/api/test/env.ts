import { randomBytes } from 'node:crypto';
import { loadEnv, type Env } from '../src/env.js';

/** A complete, valid test Env. Defaults come from the real schema, so new settings never break the tests. */
export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return loadEnv({
    APP_DATABASE_URL: process.env.TEST_APP_DATABASE_URL ?? 'postgres://cs_app:cs_app@localhost:5432/campaign_suite',
    JWT_SECRET: 'test-secret-test-secret',
    JWT_REFRESH_SECRET: 'test-refresh-test-refresh',
    DEPLOY_REGION: 'IN',
    OTP_PROVIDER: 'console',
    PHONE_ENC_KEY: randomBytes(32).toString('base64'),
    PHONE_HASH_KEY: randomBytes(32).toString('base64'),
    PORT: '0',
    PUBLIC_BASE_URL: 'http://t',
    ANTHROPIC_MODEL: 'x',
    NODE_ENV: 'test',
    DEV_RETURN_OTP: 'true',
    ...overrides,
  });
}
