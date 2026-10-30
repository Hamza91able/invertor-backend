import type { FastifyInstance } from 'fastify';
import type { GridService } from './grid.service.js';

export async function registerGridApi(app: FastifyInstance, service: GridService): Promise<void> {
  app.get('/grid', async () => service.getStatus());
}
