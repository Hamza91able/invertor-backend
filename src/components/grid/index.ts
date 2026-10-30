import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../../libraries/config/index.js';
import { createNotifier } from '../../libraries/notifier/index.js';
import { registerGridApi } from './grid.api.js';
import { createGridService } from './grid.service.js';

/** Public interface of the grid component: polls the logger and alerts on grid changes. */
export default async function gridComponent(app: FastifyInstance): Promise<void> {
  const env = loadEnv();
  const service = createGridService(env, createNotifier(env));

  await registerGridApi(app, service);

  app.addHook('onReady', async () => service.start());
  app.addHook('onClose', async () => service.stop());
}
