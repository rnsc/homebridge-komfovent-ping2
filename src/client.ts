import type { Logging } from 'homebridge';
import type { Device } from './types';

import ModbusRTU from 'modbus-serial';

// C4 controller Modbus holding register addresses
// modbus-serial uses 0-based addresses; C4 docs use 1-based register references.
// Subtract 1 from the documented register number to get the modbus-serial address.
export const C4_REGISTERS = {
  START_STOP: 999,       // doc: 1000
  SEASON: 1000,          // doc: 1001
  TIME: 1001,            // doc: 1002
  DAY_OF_WEEK: 1002,     // doc: 1003
  MONTH_DAY: 1003,       // doc: 1004
  YEAR: 1004,            // doc: 1005
  VENTILATION_LEVEL: 1099,          // doc: 1100
  VENTILATION_LEVEL_CURRENT: 1100,  // doc: 1101
  MODE: 1101,            // doc: 1102
  INTAKE_LEVEL_1: 1102,  // doc: 1103
  INTAKE_LEVEL_2: 1103,  // doc: 1104
  INTAKE_LEVEL_3: 1104,  // doc: 1105
  INTAKE_LEVEL_4: 1105,  // doc: 1106
  EXHAUST_LEVEL_1: 1106, // doc: 1107
  EXHAUST_LEVEL_2: 1107, // doc: 1108
  EXHAUST_LEVEL_3: 1108, // doc: 1109
  EXHAUST_LEVEL_4: 1109, // doc: 1110
  FAN_STATUS: 1113,      // doc: 1114
  SUPPLY_FAN_SPEED: 1114, // doc: 1115
  EXHAUST_FAN_SPEED: 1115, // doc: 1116
  SUPPLY_AIR_TEMP: 1199, // doc: 1200
  SETPOINT_TEMP: 1200,   // doc: 1201
} as const;

export interface UnitStatus {
  active: boolean;
  mode2Speed: number;
  supplyAirTemp: number;
  setpointTemp: number;
}

type NormalizedDevice = Device & Required<Pick<Device, 'port' | 'slaveId'>>;

export class ModbusClient {
  private client: ModbusRTU;
  private connected = false;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private statusPromise: Promise<UnitStatus> | null = null;
  private statusPromiseTime = 0;
  private statusInFlight = false;
  private failureCount = 0;
  private nextRetryTime = 0;
  private static readonly STATUS_CACHE_TTL_MS = 5000;
  private static readonly CONNECT_TIMEOUT_MS = 5000;
  private static readonly REQUEST_TIMEOUT_MS = 10000;
  private static readonly BACKOFF_BASE_MS = 2000;
  private static readonly BACKOFF_MAX_MS = 60000;
  private readonly device: NormalizedDevice;

  constructor(
    private readonly log: Logging,
    device: Device,
  ) {
    // port/slaveId defaults are applied by the platform before the device reaches here
    this.device = device as NormalizedDevice;
    this.client = new ModbusRTU();
  }

  // Serializes all Modbus operations to prevent concurrent socket access
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => { /* keep chain alive */ });
    return result;
  }

  // Wraps a Modbus operation with connection handling and uniform error recovery
  private async withConnection<T>(label: string, operation: () => Promise<T>): Promise<T> {
    try {
      await this.ensureConnection();
      return await operation();
    } catch (error) {
      this.connected = false;
      this.closeExistingConnection();
      this.invalidateCache();
      this.log.error(`Failed to ${label}:`, error);
      throw error;
    }
  }

  // Rejects if the wrapped promise does not settle within `ms`, so a hung socket cannot block the queue
  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  private invalidateCache(): void {
    this.statusPromise = null;
    this.statusPromiseTime = 0;
  }

  private closeExistingConnection(): void {
    try {
      if (this.client.isOpen) {
        this.client.close(() => { /* noop */ });
      }
    } catch {
      // ignore close errors on stale connections
    }
  }

  private async ensureConnection(): Promise<void> {
    if (this.connected && this.client.isOpen) {
      return;
    }

    // Fail fast while a previous connection failure is still cooling down
    if (Date.now() < this.nextRetryTime) {
      throw new Error(
        `Connection to ${this.device.host}:${this.device.port} cooling down after ${this.failureCount} failure(s)`,
      );
    }

    this.connected = false;
    this.closeExistingConnection();

    try {
      this.client = new ModbusRTU();
      await this.withTimeout(
        this.client.connectTCP(this.device.host, { port: this.device.port }),
        ModbusClient.CONNECT_TIMEOUT_MS,
        `connect to ${this.device.host}:${this.device.port}`,
      );
      this.client.setID(this.device.slaveId);
      this.client.setTimeout(ModbusClient.REQUEST_TIMEOUT_MS);
      this.connected = true;
      this.failureCount = 0;
      this.nextRetryTime = 0;
      this.log.info(`Connected to ${this.device.host}:${this.device.port} (slave ${this.device.slaveId})`);
    } catch (error) {
      this.failureCount++;
      const backoff = Math.min(
        ModbusClient.BACKOFF_MAX_MS,
        ModbusClient.BACKOFF_BASE_MS * 2 ** (this.failureCount - 1),
      );
      this.nextRetryTime = Date.now() + backoff;
      this.closeExistingConnection();
      this.log.error(
        `Failed to connect to ${this.device.host}:${this.device.port} (retry in ${Math.round(backoff / 1000)}s):`,
        error,
      );
      throw error;
    }
  }

  async getStatus(): Promise<UnitStatus> {
    if (this.statusPromise) {
      // Share the in-flight read, or serve a cached result while it is still fresh
      if (this.statusInFlight || (Date.now() - this.statusPromiseTime) < ModbusClient.STATUS_CACHE_TTL_MS) {
        return this.statusPromise;
      }
    }

    this.statusInFlight = true;
    const promise = this.serialize(() => this.withConnection('read status', async () => {
      const general = await this.client.readHoldingRegisters(C4_REGISTERS.START_STOP, 1);
      this.log.debug(`Registers 1000: [${general.data.join(', ')}]`);

      const ventilation = await this.client.readHoldingRegisters(C4_REGISTERS.VENTILATION_LEVEL, 5);
      this.log.debug(`Registers 1100-1104: [${ventilation.data.join(', ')}]`);

      const temps = await this.client.readHoldingRegisters(C4_REGISTERS.SUPPLY_AIR_TEMP, 2);
      this.log.debug(`Registers 1200-1201: [${temps.data.join(', ')}]`);

      const status: UnitStatus = {
        active: general.data[0] === 1,
        mode2Speed: ventilation.data[4],   // reg 1104 — Mode 2 intake intensity
        supplyAirTemp: temps.data[0] / 10, // reg 1200, value is 10x
        setpointTemp: temps.data[1] / 10,  // reg 1201, value is 10x
      };
      this.log.debug(`Status: active=${status.active}, mode2Speed=${status.mode2Speed}%,`
        + ` supplyAirTemp=${status.supplyAirTemp}°C, setpointTemp=${status.setpointTemp}°C`);
      return status;
    }));

    this.statusPromise = promise;
    // Start the TTL window on completion (not enqueue) and drop a failed read from the cache
    promise.then(
      () => {
        this.statusPromiseTime = Date.now();
      },
      () => {
        this.invalidateCache();
      },
    ).finally(() => {
      this.statusInFlight = false;
    });

    return promise;
  }

  async setPower(on: boolean): Promise<void> {
    return this.serialize(() => this.withConnection('set power', async () => {
      await this.client.writeRegister(C4_REGISTERS.START_STOP, on ? 1 : 0);
      this.invalidateCache();
      this.log.info(`Power set to ${on ? 'ON' : 'OFF'}`);
    }));
  }

  async setMode2Speed(speed: number): Promise<void> {
    speed = Math.round(speed / 5) * 5;
    speed = Math.min(95, Math.max(5, speed));

    return this.serialize(() => this.withConnection('set Mode 2 speed', async () => {
      await this.client.writeRegister(C4_REGISTERS.INTAKE_LEVEL_2, speed);
      await this.client.writeRegister(C4_REGISTERS.EXHAUST_LEVEL_2, speed);
      this.invalidateCache();
      this.log.info(`Mode 2 speed set to ${speed}% (intake + exhaust)`);
    }));
  }

  async syncClock(): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.ensureConnection();
        const now = new Date();
        const tz = this.device.timezone;

        let hours: number, minutes: number, day: number, month: number, date: number, year: number;

        if (tz) {
          const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).formatToParts(now);

          const get = (type: string) => {
            const part = parts.find(p => p.type === type);
            if (!part) {
              throw new Error(`Failed to extract ${type} for timezone "${tz}"`);
            }
            return parseInt(part.value, 10);
          };

          year = get('year');
          month = get('month');
          date = get('day');
          hours = get('hour');
          minutes = get('minute');
          day = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
        } else {
          hours = now.getHours();
          minutes = now.getMinutes();
          day = now.getDay();
          month = now.getMonth() + 1;
          date = now.getDate();
          year = now.getFullYear();
        }

        const time = (hours << 8) | minutes;
        const dayOfWeek = day === 0 ? 7 : day;
        const monthDay = (month << 8) | date;

        await this.client.writeRegister(C4_REGISTERS.TIME, time);
        await this.client.writeRegister(C4_REGISTERS.DAY_OF_WEEK, dayOfWeek);
        await this.client.writeRegister(C4_REGISTERS.MONTH_DAY, monthDay);
        await this.client.writeRegister(C4_REGISTERS.YEAR, year);
        const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
        this.log.info(`Clock synced to ${dateStr} ${timeStr}${tz ? ` (${tz})` : ''}`);
      } catch (error) {
        this.connected = false;
        this.closeExistingConnection();
        this.invalidateCache();
        this.log.error('Failed to sync clock:', error);
        throw error;
      }
    });
  }

  disconnect(): void {
    this.connected = false;
    this.closeExistingConnection();
    this.invalidateCache();
  }
}
