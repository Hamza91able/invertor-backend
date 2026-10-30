import net from 'node:net';
import os from 'node:os';

/**
 * Minimal Solarman V5 client for IGEN stick loggers (LSW-3 etc.).
 *
 * The logger listens on TCP 8899 and wraps Modbus RTU frames in a V5 envelope
 * addressed by the logger's serial number. Only "read holding registers"
 * (function 0x03) is implemented for now.
 */

export interface SolarmanOptions {
  host: string;
  serial: number;
  port?: number;
  slaveId?: number;
  timeoutMs?: number;
}

export interface SolarmanConnection {
  readHoldingRegisters(address: number, count: number): Promise<number[]>;
  close(): void;
}

const START = 0xa5;
const END = 0x15;
const CONTROL_REQUEST = 0x4510;
const CONTROL_RESPONSE = 0x1510;
const HEADER_LENGTH = 11;
const RESPONSE_PAYLOAD_PREFIX = 14;

export function modbusCrc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}

function buildModbusRead(slaveId: number, address: number, count: number): Buffer {
  const frame = Buffer.alloc(8);
  frame.writeUInt8(slaveId, 0);
  frame.writeUInt8(0x03, 1);
  frame.writeUInt16BE(address, 2);
  frame.writeUInt16BE(count, 4);
  frame.writeUInt16LE(modbusCrc16(frame.subarray(0, 6)), 6);
  return frame;
}

function v5Checksum(frame: Buffer): number {
  let sum = 0;
  for (let i = 1; i < frame.length - 2; i++) sum += frame[i]!;
  return sum & 0xff;
}

function buildV5Request(serial: number, sequence: number, modbusFrame: Buffer): Buffer {
  // Payload: frame type (1) + sensor type (2) + three 4-byte time fields (12) + Modbus frame.
  const payload = Buffer.alloc(15 + modbusFrame.length);
  payload.writeUInt8(0x02, 0);
  modbusFrame.copy(payload, 15);

  const frame = Buffer.alloc(HEADER_LENGTH + payload.length + 2);
  frame.writeUInt8(START, 0);
  frame.writeUInt16LE(payload.length, 1);
  frame.writeUInt16LE(CONTROL_REQUEST, 3);
  frame.writeUInt16LE(sequence, 5);
  frame.writeUInt32LE(serial, 7);
  payload.copy(frame, HEADER_LENGTH);
  frame.writeUInt8(v5Checksum(frame), frame.length - 2);
  frame.writeUInt8(END, frame.length - 1);
  return frame;
}

/**
 * Pulls complete V5 frames off the front of `buffer`. Returns the frames and
 * the unconsumed remainder.
 */
function extractFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = [];
  let rest = buffer;
  while (rest.length > 0) {
    const start = rest.indexOf(START);
    if (start === -1) return { frames, rest: Buffer.alloc(0) };
    rest = rest.subarray(start);
    if (rest.length < 3) break;
    const total = HEADER_LENGTH + rest.readUInt16LE(1) + 2;
    if (rest.length < total) break;
    frames.push(rest.subarray(0, total));
    rest = rest.subarray(total);
  }
  return { frames, rest };
}

function parseRegisters(frame: Buffer, slaveId: number, count: number): number[] {
  if (frame[frame.length - 1] !== END || v5Checksum(frame) !== frame[frame.length - 2]) {
    throw new Error('Solarman: bad V5 frame checksum');
  }

  const modbus = frame.subarray(HEADER_LENGTH + RESPONSE_PAYLOAD_PREFIX, frame.length - 2);
  if (modbus.length < 5) throw new Error('Solarman: response has no Modbus payload');

  const body = modbus.subarray(0, modbus.length - 2);
  if (modbusCrc16(body) !== modbus.readUInt16LE(modbus.length - 2)) {
    throw new Error('Solarman: bad Modbus CRC');
  }
  if (modbus[0] !== slaveId) throw new Error(`Solarman: unexpected slave id ${modbus[0]}`);
  if (modbus[1] === 0x83) throw new Error(`Solarman: Modbus exception code ${modbus[2]}`);
  if (modbus[1] !== 0x03) throw new Error(`Solarman: unexpected function code ${modbus[1]}`);

  const byteCount = modbus[2]!;
  if (byteCount !== count * 2) throw new Error('Solarman: register count mismatch');

  const registers: number[] = [];
  for (let i = 0; i < count; i++) registers.push(modbus.readUInt16BE(3 + i * 2));
  return registers;
}

/**
 * Opens a TCP connection to the logger. Requests on one connection are
 * serialized; close it when done.
 */
export async function connectSolarman(options: SolarmanOptions): Promise<SolarmanConnection> {
  const port = options.port ?? 8899;
  const slaveId = options.slaveId ?? 1;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const socket = net.createConnection({ host: options.host, port });
  socket.setNoDelay(true);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Solarman: connect to ${options.host}:${port} timed out`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  let sequence = Math.floor(Math.random() * 0xff);
  let queue: Promise<unknown> = Promise.resolve();

  function request(address: number, count: number): Promise<number[]> {
    sequence = (sequence + 1) & 0xff;
    const seq = sequence;
    const frame = buildV5Request(options.serial, seq, buildModbusRead(slaveId, address, count));

    return new Promise<number[]>((resolve, reject) => {
      let buffer: Buffer = Buffer.alloc(0);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      const fail = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onError = (err: Error) => fail(err);
      const onClose = () => fail(new Error('Solarman: connection closed by logger'));
      const onData = (chunk: Buffer) => {
        const extracted = extractFrames(Buffer.concat([buffer, chunk]));
        buffer = extracted.rest;
        for (const candidate of extracted.frames) {
          // Loggers also push heartbeats and other unsolicited frames; skip them.
          if (candidate.readUInt16LE(3) !== CONTROL_RESPONSE) continue;
          if ((candidate[5]! & 0xff) !== seq) continue;
          if (candidate.readUInt32LE(7) !== options.serial) continue;
          try {
            const registers = parseRegisters(candidate, slaveId, count);
            cleanup();
            resolve(registers);
          } catch (err) {
            fail(err as Error);
          }
          return;
        }
      };

      const timer = setTimeout(
        () => fail(new Error(`Solarman: read of register ${address} timed out`)),
        timeoutMs,
      );
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.write(frame);
    });
  }

  return {
    readHoldingRegisters(address, count) {
      const next = queue.then(() => request(address, count));
      queue = next.catch(() => undefined);
      return next;
    },
    close() {
      socket.destroy();
    },
  };
}

export interface DiscoverOptions {
  serial: number;
  port?: number;
  slaveId?: number;
}

const PROBE_CONNECT_TIMEOUT_MS = 1_000;
const PROBE_READ_TIMEOUT_MS = 5_000;
const PROBE_CONCURRENCY = 64;

/** Every host address in the /24 of each local IPv4 interface. */
function localScanTargets(): string[] {
  const targets = new Set<string>();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const prefix = address.address.split('.').slice(0, 3).join('.');
      for (let i = 1; i <= 254; i++) {
        const host = `${prefix}.${i}`;
        if (host !== address.address) targets.add(host);
      }
    }
  }
  return [...targets];
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PROBE_CONNECT_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function isLogger(host: string, options: DiscoverOptions): Promise<boolean> {
  try {
    const connection = await connectSolarman({ ...options, host, timeoutMs: PROBE_READ_TIMEOUT_MS });
    try {
      await connection.readHoldingRegisters(0, 1);
      return true;
    } finally {
      connection.close();
    }
  } catch {
    return false;
  }
}

/**
 * Finds the logger on the local network: scans the /24 of each local interface
 * for the logger port, then confirms each candidate with a read addressed to
 * `serial` (only the matching logger answers). Returns its IP, or null.
 */
export async function discoverSolarman(options: DiscoverOptions): Promise<string | null> {
  const port = options.port ?? 8899;
  const targets = localScanTargets();
  const open: string[] = [];

  for (let i = 0; i < targets.length; i += PROBE_CONCURRENCY) {
    const batch = targets.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(batch.map((host) => isPortOpen(host, port)));
    batch.forEach((host, index) => results[index] && open.push(host));
  }

  for (const host of open) {
    if (await isLogger(host, options)) return host;
  }
  return null;
}

/** Interprets a 16-bit register as a signed integer. */
export function toSigned16(value: number): number {
  return value > 0x7fff ? value - 0x10000 : value;
}
