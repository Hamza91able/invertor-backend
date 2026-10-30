import type { FastifyInstance } from 'fastify';

export async function registerHealthApi(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });
}
