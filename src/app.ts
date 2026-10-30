import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { loadEnv } from './libraries/config/index.js';
import { buildLoggerOptions } from './libraries/logger/index.js';
import { registerErrorHandler } from './libraries/http-errors/index.js';

import healthComponent from './components/health/index.js';
import gridComponent from './components/grid/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv();

  const app = Fastify({ logger: buildLoggerOptions(env) });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Libraries: generic cross-component capability.
  await app.register(helmet);
  await app.register(cors, { origin: true });
  await app.register(sensible);

  registerErrorHandler(app);

  // Components: business features.
  await app.register(healthComponent);
  await app.register(gridComponent);

  return app;
}
