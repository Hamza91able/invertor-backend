import type { FastifyInstance } from 'fastify';
import { registerHealthApi } from './health.api.js';

/** Public interface of the health component. */
export default async function healthComponent(app: FastifyInstance): Promise<void> {
  await registerHealthApi(app);
}
