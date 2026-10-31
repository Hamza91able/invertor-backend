import { logger } from '../logger/index.js';
import type { Env } from '../config/index.js';

/**
 * Delivery channel for user-facing alerts. Every notification is logged; it is
 * also pushed via Pushover when its credentials are configured. `notify`
 * rejects if the push fails, so callers can retry.
 */
export interface Notification {
  title: string;
  message: string;
  /** `urgent` uses Pushover emergency priority: repeats until acknowledged. */
  priority?: 'default' | 'high' | 'urgent';
}

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';
const PUSHOVER_PRIORITY = { default: 0, high: 1, urgent: 2 } as const;
// Emergency alerts re-ring every 60 s for up to an hour unless acknowledged.
const EMERGENCY_RETRY_SECONDS = 60;
const EMERGENCY_EXPIRE_SECONDS = 3600;

function createLogNotifier(): Notifier {
  return {
    async notify({ title, message }) {
      logger.warn(`🔔 ${title} — ${message}`);
    },
  };
}

function createPushoverNotifier(appToken: string, userKey: string): Notifier {
  return {
    async notify({ title, message, priority = 'default' }) {
      const body = new URLSearchParams({
        token: appToken,
        user: userKey,
        title,
        message,
        priority: String(PUSHOVER_PRIORITY[priority]),
      });
      if (priority === 'urgent') {
        body.set('retry', String(EMERGENCY_RETRY_SECONDS));
        body.set('expire', String(EMERGENCY_EXPIRE_SECONDS));
      }

      const response = await fetch(PUSHOVER_URL, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Pushover push failed: HTTP ${response.status} ${await response.text()}`);
      }
    },
  };
}

export function createNotifier(env: Env): Notifier {
  const channels = [createLogNotifier()];
  if (env.PUSHOVER_APP_TOKEN && env.PUSHOVER_USER_KEY) {
    channels.push(createPushoverNotifier(env.PUSHOVER_APP_TOKEN, env.PUSHOVER_USER_KEY));
  }

  return {
    async notify(notification) {
      await Promise.all(channels.map((channel) => channel.notify(notification)));
    },
  };
}
