import type { Logging } from 'homebridge';
import type { Device } from './types';

import ModbusRTU from 'modbus-serial';

// C4 controller Modbus holding register addresses
export const C4_REGISTERS = {
  START_STOP: 1000,
  SEASON: 1001,
  VENTILATION_LEVEL: 1100,
  VENTILATION_LEVEL_CURRENT: 1101,
  MODE: 1102,
  INTAKE_LEVEL_1: 1103,
  INTAKE_LEVEL_2: 1104,
  INTAKE_LEVEL_3: 1105,
  INTAKE_LEVEL_4: 1106,
  EXHAUST_LEVEL_1: 1107,
  EXHAUST_LEVEL_2: 1108,
  EXHAUST_LEVEL_3: 1109,
  EXHAUST_LEVEL_4: 1110,
  FAN_STATUS: 1114,
  SUPPLY_FAN_SPEED: 1115,
  EXHAUST_FAN_SPEED: 1116,
  TIME: 1002,
  DAY_OF_WEEK: 1003,
  MONTH_DAY: 1004,
  YEAR: 1005,
  SUPPLY_AIR_TEMP: 1200,
  SETPOINT_TEMP: 1201,
} as const;

export interface UnitStatus {
  active: boolean;
  mode2Speed: number;
  supplyFanSpeed: number;
  exhaustFanSpeed: number;
  supplyAirTemp: number;
  setpointTemp: number;
}

export class ModbusClient {
  private client: ModbusRTU;
  private connected = false;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private statusPromise: Promise<UnitStatus> | null = null;
  private statusPromiseTime = 0;
  private static readonly STATUS_CACHE_TTL_MS = 2000;

  constructor(
    private readonly log: Logging,
    private readonly device: Device,
  ) {
    this.client = new ModbusRTU();
  }

  // Serializes all Modbus operations to prevent concurrent socket access
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => { /* keep chain alive */ });
    return result;
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

    this.connected = false;
    this.closeExistingConnection();

    try {
      this.client = new ModbusRTU();
      await this.client.connectTCP(this.device.host, { port: this.device.port! });
      this.client.setID(this.device.slaveId!);
      this.client.setTimeout(5000);
      this.connected = true;
      this.log.info(`Connected to ${this.device.host}:${this.device.port!} (slave ${this.device.slaveId!})`);
    } catch (error) {
      this.log.error(`Failed to connect to ${this.device.host}:${this.device.port!}:`, error);
      throw error;
    }
  }

  async getStatus(): Promise<UnitStatus> {
    const now = Date.now();
    if (this.statusPromise && (now - this.statusPromiseTime) < ModbusClient.STATUS_CACHE_TTL_MS) {
      return this.statusPromise;
    }

    this.statusPromiseTime = now;
    this.statusPromise = this.serialize(async () => {
      try {
        await this.ensureConnection();
        const general = await this.client.readHoldingRegisters(C4_REGISTERS.START_STOP, 1);
        const ventilation = await this.client.readHoldingRegisters(C4_REGISTERS.VENTILATION_LEVEL, 17);
        const temps = await this.client.readHoldingRegisters(C4_REGISTERS.SUPPLY_AIR_TEMP, 2);

        return {
          active: general.data[0] === 1,
          mode2Speed: ventilation.data[4],           // reg 1104 — Mode 2 intake intensity
          supplyFanSpeed: ventilation.data[15],      // reg 1115
          exhaustFanSpeed: ventilation.data[16],     // reg 1116
          supplyAirTemp: temps.data[0] / 10,         // reg 1200, value is 10x
          setpointTemp: temps.data[1] / 10,          // reg 1201, value is 10x
        };
      } catch (error) {
        this.connected = false;
        this.closeExistingConnection();
        this.invalidateCache();
        this.log.error('Failed to read status:', error);
        throw error;
      }
    });

    return this.statusPromise;
  }

  async setPower(on: boolean): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.ensureConnection();
        await this.client.writeRegister(C4_REGISTERS.START_STOP, on ? 1 : 0);
        this.invalidateCache();
        this.log.info(`Power set to ${on ? 'ON' : 'OFF'}`);
      } catch (error) {
        this.connected = false;
        this.closeExistingConnection();
        this.invalidateCache();
        this.log.error('Failed to set power:', error);
        throw error;
      }
    });
  }

  async setMode2Speed(speed: number): Promise<void> {
    speed = Math.round(speed / 5) * 5;
    speed = Math.min(95, Math.max(5, speed));

    return this.serialize(async () => {
      try {
        await this.ensureConnection();
        await this.client.writeRegister(C4_REGISTERS.INTAKE_LEVEL_2, speed);
        await this.client.writeRegister(C4_REGISTERS.EXHAUST_LEVEL_2, speed);
        this.invalidateCache();
        this.log.info(`Mode 2 speed set to ${speed}% (intake + exhaust)`);
      } catch (error) {
        this.connected = false;
        this.closeExistingConnection();
        this.invalidateCache();
        this.log.error('Failed to set Mode 2 speed:', error);
        throw error;
      }
    });
  }

  async syncClock(): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.ensureConnection();
        const now = new Date();
        const time = (now.getHours() << 8) | now.getMinutes();
        const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay();
        const monthDay = ((now.getMonth() + 1) << 8) | now.getDate();
        const year = now.getFullYear();

        await this.client.writeRegister(C4_REGISTERS.TIME, time);
        await this.client.writeRegister(C4_REGISTERS.DAY_OF_WEEK, dayOfWeek);
        await this.client.writeRegister(C4_REGISTERS.MONTH_DAY, monthDay);
        await this.client.writeRegister(C4_REGISTERS.YEAR, year);
        this.log.info(`Clock synced to ${now.toLocaleString()}`);
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
