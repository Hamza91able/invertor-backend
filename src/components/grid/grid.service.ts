import { connectSolarman } from '../../libraries/solarman/index.js';
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

  async function read(): Promise<GridReading> {
    const connection = await connectSolarman({
      host: env.LOGGER_HOST,
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

    await notifyIfNeeded(observed, previous, reading.readAt);
  }

  /**
   * Sends at most one alert per state. An outage already in progress at startup
   * is alerted; a healthy grid at startup is not. In-memory only, so a restart
   * during an outage re-sends the offline alert.
   */
  async function notifyIfNeeded(state: GridState, previous: GridState, at: string): Promise<void> {
    if (state === lastNotified) return;
    lastNotified = state;

    if (state === 'offline') {
      await notifier.notify({
        title: '⚠️ Grid offline',
        message:
          previous === 'unknown'
            ? `Grid power is off (detected at startup, ${at}).`
            : `Grid power lost at ${at}.`,
        priority: 'high',
      });
    } else if (previous !== 'unknown') {
      await notifier.notify({ title: '✅ Grid online', message: `Grid power restored at ${at}.` });
    }
  }

  async function tick(): Promise<void> {
    try {
      await applyReading(await read());
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(`Grid poll failed: ${status.lastError}`);
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
