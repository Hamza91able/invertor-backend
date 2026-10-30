import type { FastifyError, FastifyInstance } from 'fastify';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error(error);
    } else {
      request.log.warn({ err: error }, error.message);
    }

    reply.status(statusCode).send({
      error: error.name || 'Error',
      message: statusCode >= 500 ? 'Internal Server Error' : error.message,
      statusCode,
      ...(error.validation ? { details: error.validation } : {}),
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      statusCode: 404,
    });
  });
}
