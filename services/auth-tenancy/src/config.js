import 'dotenv/config';
import { z } from 'zod';

const schema = z
  .object({
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().min(1),
    SUPER_ADMIN_EMAIL: z.string().email(),
    SUPER_ADMIN_PASSWORD: z.string().optional(),
    SUPER_ADMIN_PASSWORD_HASH: z.string().optional(),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('12h'),
    SUPER_ADMIN_JWT_EXPIRES_IN: z.string().default('2h'),
  })
  .refine((e) => e.SUPER_ADMIN_PASSWORD_HASH || (e.SUPER_ADMIN_PASSWORD && e.SUPER_ADMIN_PASSWORD.length >= 12), {
    message: 'Set SUPER_ADMIN_PASSWORD_HASH, or SUPER_ADMIN_PASSWORD with at least 12 characters',
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast: never boot with a missing/weak super admin or JWT config.
  console.error('Invalid environment:', parsed.error.issues.map((i) => i.message).join('; '));
  process.exit(1);
}

export const env = { ...parsed.data, SUPER_ADMIN_EMAIL: parsed.data.SUPER_ADMIN_EMAIL.toLowerCase() };
