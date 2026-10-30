import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  LOGGER_HOST: z.string().min(1, 'LOGGER_HOST is required'),
  LOGGER_SERIAL: z.coerce.number().int().positive(),
  LOGGER_PORT: z.coerce.number().int().positive().default(8899),
  MODBUS_SLAVE_ID: z.coerce.number().int().min(0).max(247).default(1),

  GRID_POLL_INTERVAL_MS: z.coerce.number().int().min(2000).default(10_000),

  PUSHOVER_APP_TOKEN: z.string().min(1).optional(),
  PUSHOVER_USER_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('❌ Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '(root)';
      console.error(`  - ${path}: ${issue.message}`);
    }
    process.exit(1);
  }

  cached = parsed.data;
  return cached;
}
