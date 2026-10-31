import { connectSolarman, discoverSolarman } from '../../libraries/solarman/index.js';
import type { Notifier } from '../../libraries/notifier/index.js';
import type { Env } from '../../libraries/config/index.js';
import { logger } from '../../libraries/logger/index.js';

// Deye-protocol single-phase hybrid holding registers.
const REG_GRID_FREQUENCY = 79; // 0.01 Hz
const REG_GRID_VOLTAGE = 150; // 0.1 V
const REG_GRID_CONNECTED = 194; // non-zero when tied to the grid

const MIN_ONLINE_VOLTAGE = 180;
const MIN_ONLINE_FREQUENCY = 45;

// A new state only counts after this many consecutive agreeing reads.
const CONFIRMATIONS = 2;

// Consecutive failed polls before the logger's IP is rediscovered.
const FAILURES_BEFORE_RESCAN = 3;

// A failed alert is retried once per poll, at most this many times.
const MAX_NOTIFY_RETRIES = 10;

export type GridState = 'online' | 'offline' | 'unknown';

export interface GridReading {
  voltage: number;
  frequency: number;
  connected: boolean;
  online: boolean;
  readAt: string;
}

export interface GridStatus {
  state: GridState;
  since: string | null;
  lastReading: GridReading | null;
  lastError: string | null;
}

export function createGridService(env: Env, notifier: Notifier) {
  const status: GridStatus = { state: 'unknown', since: null, lastReading: null, lastError: null };
  let pending: { online: boolean; count: number } | null = null;
  let lastNotified: GridState = 'unknown';
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  // Configured IP is tried first; otherwise (or after repeated failures) the logger is discovered.
  let host: string | null = env.LOGGER_HOST ?? null;
  let failures = 0;
  let notifyFailures = 0;
  let notifyFailedState: GridState = 'unknown';

  async function resolveHost(): Promise<string> {
    if (host) return host;

    logger.info('Scanning local network for the logger...');
    const found = await discoverSolarman({
      serial: env.LOGGER_SERIAL,
      port: env.LOGGER_PORT,
      slaveId: env.MODBUS_SLAVE_ID,
    });
    if (!found) throw new Error('Logger not found on the local network');

    logger.info(`Logger found at ${found}`);
    host = found;
    return host;
  }

  async function read(): Promise<GridReading> {
    const connection = await connectSolarman({
      host: await resolveHost(),
      serial: env.LOGGER_SERIAL,
      port: env.LOGGER_PORT,
      slaveId: env.MODBUS_SLAVE_ID,
    });
    try {
      const [frequency] = await connection.readHoldingRegisters(REG_GRID_FREQUENCY, 1);
      const [voltage] = await connection.readHoldingRegisters(REG_GRID_VOLTAGE, 1);
      const [connected] = await connection.readHoldingRegisters(REG_GRID_CONNECTED, 1);

      const reading = {
        voltage: voltage! / 10,
        frequency: frequency! / 100,
        connected: connected !== 0,
      };
      return {
        ...reading,
        online: reading.voltage >= MIN_ONLINE_VOLTAGE && reading.frequency >= MIN_ONLINE_FREQUENCY,
        readAt: new Date().toISOString(),
      };
    } finally {
      connection.close();
    }
  }

  async function applyReading(reading: GridReading): Promise<void> {
    status.lastReading = reading;
    status.lastError = null;

    const observed: GridState = reading.online ? 'online' : 'offline';
    if (observed === status.state) {
      pending = null;
      return;
    }

    pending = pending?.online === reading.online ? { ...pending, count: pending.count + 1 } : { online: reading.online, count: 1 };
    if (pending.count < CONFIRMATIONS) return;

    const previous = status.state;
    status.state = observed;
    status.since = reading.readAt;
    pending = null;

    if (previous === 'unknown') {
      logger.info(`Grid initial state: ${observed} (${reading.voltage} V, ${reading.frequency} Hz)`);
    } else {
      logger.info(`Grid changed: ${previous} -> ${observed}`);
    }
  }

  /**
   * Sends at most one alert per state. An outage already in progress at startup
   * is alerted; a healthy grid at startup is not. In-memory only, so a restart
   * during an outage re-sends the offline alert.
   *
   * Runs every poll: an alert only counts as sent once the push succeeds, so a
   * failed push is retried on the next poll.
   */
  async function notifyIfNeeded(): Promise<void> {
    const state = status.state;
    if (state === 'unknown' || state === lastNotified) return;

    if (state === 'offline') {
      await notifier.notify({
        title: '⚠️ Grid offline',
        message:
          lastNotified === 'unknown'
            ? `Grid power is off.`
            : `Grid power lost`,
        priority: 'high',
      });
    } else if (lastNotified !== 'unknown') {
      await notifier.notify({ title: '✅ Grid online', message: `Grid power restored at ${status.since}.` });
    }

    lastNotified = state;
  }

  async function tick(): Promise<void> {
    try {
      await applyReading(await read());
      failures = 0;
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(`Grid poll failed: ${status.lastError}`);

      // The logger's IP may have changed (e.g. router restart): rediscover it.
      failures += 1;
      if (host && failures >= FAILURES_BEFORE_RESCAN) {
        logger.warn(`Logger at ${host} unreachable ${failures} times; will rescan`);
        host = null;
        failures = 0;
      }
    }
    try {
      await notifyIfNeeded();
      notifyFailures = 0;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Count failures per alert: a new grid state starts a fresh count.
      if (notifyFailedState !== status.state) notifyFailures = 0;
      notifyFailedState = status.state;
      notifyFailures += 1;
      if (notifyFailures > MAX_NOTIFY_RETRIES) {
        logger.error(`Notification failed, giving up after ${MAX_NOTIFY_RETRIES} retries: ${reason}`);
        lastNotified = status.state;
        notifyFailures = 0;
      } else {
        logger.error(
          `Notification failed, will retry next poll (${notifyFailures}/${MAX_NOTIFY_RETRIES}): ${reason}`,
        );
      }
    }

    if (!stopped) timer = setTimeout(tick, env.GRID_POLL_INTERVAL_MS);
  }

  return {
    start() {
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    getStatus(): GridStatus {
      return status;
    },
  };
}

export type GridService = ReturnType<typeof createGridService>;
