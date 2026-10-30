import winston from 'winston';
import type { FastifyServerOptions } from 'fastify';
import type { Env } from '../config/index.js';

/**
 * Standalone application logger (boot messages, background tasks, anything
 * outside a request). Colorized console output. Request logging is handled
 * separately by Fastify's pino logger — see `buildLoggerOptions`.
 */
const colorizer = winston.format.colorize();

export const logger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.simple(),
    winston.format.printf((msg) =>
      colorizer.colorize(msg.level, `${msg.timestamp} - ${msg.level}: ${msg.message}`),
    ),
  ),
  transports: [new winston.transports.Console()],
});

/**
 * Request-log headers that must never be written to logs.
 */
const REDACTED_HEADERS = new Set(['access-token', 'refresh-token']);

interface LoggableRequest {
  method: string;
  url: string;
  hostname: string;
  ip: string;
  headers: Record<string, unknown>;
}

/**
 * Fastify (pino) request/response serializers. Redacts sensitive auth headers
 * so tokens never land in logs.
 */
function buildSerializers() {
  return {
    req(req: LoggableRequest) {
      const safeHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers ?? {})) {
        safeHeaders[key] = REDACTED_HEADERS.has(key) ? '[REDACTED]' : String(value ?? '');
      }
      return {
        method: req.method,
        url: req.url,
        hostname: req.hostname,
        remoteAddress: req.ip,
        headers: safeHeaders,
      };
    },
    res(reply: { statusCode: number }) {
      return { statusCode: reply.statusCode };
    },
  };
}

/**
 * Fastify logger options: pretty-printed in development, structured JSON in
 * production, with sensitive headers redacted in both.
 */
export function buildLoggerOptions(env: Env): FastifyServerOptions['logger'] {
  const serializers = buildSerializers();

  if (env.NODE_ENV === 'production') {
    return { serializers };
  }

  return {
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
    },
    serializers,
  };
}
