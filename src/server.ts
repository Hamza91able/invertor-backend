import { buildApp } from './app.js';
import { loadEnv } from './libraries/config/index.js';
import { logger } from './libraries/logger/index.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info(`Server listening on port ${env.PORT}`);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

void main();
