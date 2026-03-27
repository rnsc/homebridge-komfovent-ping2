import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModbusClient, C4_REGISTERS } from './client';
import type { Logging } from 'homebridge';
import type { Device } from './types';

// Real register data captured from a PING2 module at 192.168.88.5, slave ID 20
// modbus-serial uses 0-based addresses; doc register numbers shown for reference
const REAL_GENERAL_REGISTERS = {
  // readHoldingRegisters(999, 1) → doc register 1000
  data: [1],  // start/stop = 1 (running)
};

const REAL_VENTILATION_REGISTERS = {
  // readHoldingRegisters(1099, 17) → doc registers 1100-1116
  data: [
    2,   // doc 1100: ventilation level (manual) = 2
    2,   // doc 1101: ventilation level (current) = 2
    0,   // doc 1102: mode = 0 (manual)
    20,  // doc 1103: intake level 1 = 20%
    50,  // doc 1104: intake level 2 = 50%  <-- Mode 2 intake (what we read)
    60,  // doc 1105: intake level 3 = 60%
    20,  // doc 1106: intake level 4 = 20%
    20,  // doc 1107: exhaust level 1 = 20%
    50,  // doc 1108: exhaust level 2 = 50%  <-- Mode 2 exhaust (what we write)
    60,  // doc 1109: exhaust level 3 = 60%
    20,  // doc 1110: exhaust level 4 = 20%
    0,   // doc 1111: OVR enable = 0
    30,  // doc 1112: OVR time = 30 min
    0,   // doc 1113: OVR time current = 0
    1,   // doc 1114: fan status = 1 (operating)
    50,  // doc 1115: supply fan speed = 50%
    50,  // doc 1116: exhaust fan speed = 50%
  ],
};

const REAL_TEMP_REGISTERS = {
  // readHoldingRegisters(1199, 2) → doc registers 1200-1201
  data: [
    188,  // doc 1200: supply air temp = 18.8°C (value is 10x)
    180,  // doc 1201: setpoint temp = 18.0°C (value is 10x)
  ],
};

const UNIT_OFF_GENERAL = { data: [0] };

function createMockLog(): Logging {
  const log = vi.fn() as unknown as Logging;
  log.info = vi.fn();
  log.warn = vi.fn();
  log.error = vi.fn();
  log.debug = vi.fn();
  return log;
}

function createDevice(overrides?: Partial<Device>): Device {
  return {
    name: 'Test Ventilation',
    host: '192.168.88.5',
    port: 502,
    slaveId: 20,
    deviceId: 'abcdef1234567890',
    ...overrides,
  };
}

// Mock modbus-serial — returns a constructor that produces mock client instances
const mockModbusClient = {
  connectTCP: vi.fn().mockResolvedValue(undefined),
  setID: vi.fn(),
  setTimeout: vi.fn(),
  readHoldingRegisters: vi.fn(),
  writeRegister: vi.fn().mockResolvedValue(undefined),
  close: vi.fn(),
  isOpen: true,
};

vi.mock('modbus-serial', () => {
  return {
    default: vi.fn(function (this: Record<string, unknown>) {
      Object.assign(this, mockModbusClient);
    }),
  };
});

describe('ModbusClient', () => {
  let client: ModbusClient;
  let log: Logging;

  beforeEach(() => {
    vi.clearAllMocks();
    mockModbusClient.readHoldingRegisters.mockReset();
    mockModbusClient.writeRegister.mockReset().mockResolvedValue(undefined);
    mockModbusClient.connectTCP.mockReset().mockResolvedValue(undefined);
    mockModbusClient.isOpen = true;
    log = createMockLog();
    client = new ModbusClient(log, createDevice());
  });

  describe('getStatus', () => {
    it('parses real PING2 register data correctly', async () => {
      mockModbusClient.readHoldingRegisters
        .mockResolvedValueOnce(REAL_GENERAL_REGISTERS)
        .mockResolvedValueOnce(REAL_VENTILATION_REGISTERS)
        .mockResolvedValueOnce(REAL_TEMP_REGISTERS);

      const status = await client.getStatus();

      expect(status).toEqual({
        active: true,
        mode2Speed: 50,
        supplyFanSpeed: 50,
        exhaustFanSpeed: 50,
        supplyAirTemp: 18.8,
        setpointTemp: 18.0,
      });
    });

    it('reports inactive when unit is off', async () => {
      mockModbusClient.readHoldingRegisters
        .mockResolvedValueOnce(UNIT_OFF_GENERAL)
        .mockResolvedValueOnce(REAL_VENTILATION_REGISTERS)
        .mockResolvedValueOnce(REAL_TEMP_REGISTERS);

      const status = await client.getStatus();
      expect(status.active).toBe(false);
    });

    it('reads correct register addresses', async () => {
      mockModbusClient.readHoldingRegisters
        .mockResolvedValueOnce(REAL_GENERAL_REGISTERS)
        .mockResolvedValueOnce(REAL_VENTILATION_REGISTERS)
        .mockResolvedValueOnce(REAL_TEMP_REGISTERS);

      await client.getStatus();

      expect(mockModbusClient.readHoldingRegisters).toHaveBeenCalledWith(C4_REGISTERS.START_STOP, 1);
      expect(mockModbusClient.readHoldingRegisters).toHaveBeenCalledWith(C4_REGISTERS.VENTILATION_LEVEL, 17);
      expect(mockModbusClient.readHoldingRegisters).toHaveBeenCalledWith(C4_REGISTERS.SUPPLY_AIR_TEMP, 2);
    });

    it('returns cached result within TTL', async () => {
      mockModbusClient.readHoldingRegisters
        .mockResolvedValueOnce(REAL_GENERAL_REGISTERS)
        .mockResolvedValueOnce(REAL_VENTILATION_REGISTERS)
        .mockResolvedValueOnce(REAL_TEMP_REGISTERS);

      const status1 = await client.getStatus();
      const status2 = await client.getStatus();

      expect(status1).toBe(status2);
      expect(mockModbusClient.readHoldingRegisters).toHaveBeenCalledTimes(3);
    });

    it('fetches fresh data after TTL expires', async () => {
      mockModbusClient.readHoldingRegisters
        .mockResolvedValueOnce(REAL_GENERAL_REGISTERS)
        .mockResolvedValueOnce(REAL_VENTILATION_REGISTERS)
        .mockResolvedValueOnce(REAL_TEMP_REGISTERS)
        .mockResolvedValueOnce(UNIT_OFF_GENERAL)
        .mockResolvedValueOnce(REAL_VENTILATION_REGISTERS)
        .mockResolvedValueOnce(REAL_TEMP_REGISTERS);

      await client.getStatus();

      // Advance time past TTL
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000);

      const status2 = await client.getStatus();
      expect(status2.active).toBe(false);
      expect(mockModbusClient.readHoldingRegisters).toHaveBeenCalledTimes(6);

      vi.restoreAllMocks();
    });

    it('invalidates cache on read failure', async () => {
      mockModbusClient.readHoldingRegisters
        .mockRejectedValueOnce(new Error('Modbus timeout'));

      await expect(client.getStatus()).rejects.toThrow('Modbus timeout');
      expect(log.error).toHaveBeenCalled();

      // Next call should attempt fresh read, not return cached rejection
      mockModbusClient.readHoldingRegisters
        .mockResolvedValueOnce(REAL_GENERAL_REGISTERS)
        .mockResolvedValueOnce(REAL_VENTILATION_REGISTERS)
        .mockResolvedValueOnce(REAL_TEMP_REGISTERS);

      const status = await client.getStatus();
      expect(status.active).toBe(true);
    });
  });

  describe('setPower', () => {
    it('writes 1 to START_STOP register for ON', async () => {
      await client.setPower(true);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.START_STOP, 1);
    });

    it('writes 0 to START_STOP register for OFF', async () => {
      await client.setPower(false);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.START_STOP, 0);
    });

    it('invalidates status cache after write', async () => {
      // Prime the cache
      mockModbusClient.readHoldingRegisters
        .mockResolvedValueOnce(REAL_GENERAL_REGISTERS)
        .mockResolvedValueOnce(REAL_VENTILATION_REGISTERS)
        .mockResolvedValueOnce(REAL_TEMP_REGISTERS);
      await client.getStatus();

      await client.setPower(false);

      // Next getStatus should do a fresh read (cache invalidated)
      mockModbusClient.readHoldingRegisters
        .mockResolvedValueOnce(UNIT_OFF_GENERAL)
        .mockResolvedValueOnce(REAL_VENTILATION_REGISTERS)
        .mockResolvedValueOnce(REAL_TEMP_REGISTERS);
      const status = await client.getStatus();
      expect(status.active).toBe(false);
      // 3 initial + 3 after invalidation = 6
      expect(mockModbusClient.readHoldingRegisters).toHaveBeenCalledTimes(6);
    });
  });

  describe('setMode2Speed', () => {
    it('writes to both intake and exhaust Mode 2 registers', async () => {
      await client.setMode2Speed(50);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.INTAKE_LEVEL_2, 50);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.EXHAUST_LEVEL_2, 50);
    });

    it('rounds speed to nearest 5%', async () => {
      await client.setMode2Speed(22);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.INTAKE_LEVEL_2, 20);

      vi.clearAllMocks();
      await client.setMode2Speed(23);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.INTAKE_LEVEL_2, 25);

      vi.clearAllMocks();
      await client.setMode2Speed(47);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.INTAKE_LEVEL_2, 45);
    });

    it('clamps speed to 5-95% range', async () => {
      await client.setMode2Speed(0);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.INTAKE_LEVEL_2, 5);

      vi.clearAllMocks();
      await client.setMode2Speed(2);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.INTAKE_LEVEL_2, 5);

      vi.clearAllMocks();
      await client.setMode2Speed(100);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.INTAKE_LEVEL_2, 95);

      vi.clearAllMocks();
      await client.setMode2Speed(98);
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.INTAKE_LEVEL_2, 95);
    });
  });

  describe('syncClock', () => {
    it('writes correct register values for a known date', async () => {
      // Mock Date to 2026-03-25 18:22 (Wednesday)
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 2, 25, 18, 22, 0));

      await client.syncClock();

      // Time: 18:22 = (18 << 8) | 22 = 0x1216 = 4630
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.TIME, (18 << 8) | 22);
      // Wednesday = 3
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.DAY_OF_WEEK, 3);
      // March 25 = (3 << 8) | 25 = 0x0319 = 793
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.MONTH_DAY, (3 << 8) | 25);
      // Year
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.YEAR, 2026);

      vi.useRealTimers();
    });

    it('maps Sunday from JS day 0 to PING2 day 7', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 2, 29, 10, 0, 0)); // Sunday

      await client.syncClock();

      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.DAY_OF_WEEK, 7);

      vi.useRealTimers();
    });

    it('encodes midnight correctly', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 0, 1, 0, 0, 0)); // Jan 1 00:00

      await client.syncClock();

      // Time: 00:00 = (0 << 8) | 0 = 0
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.TIME, 0);
      // Jan 1 = (1 << 8) | 1 = 257
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.MONTH_DAY, (1 << 8) | 1);

      vi.useRealTimers();
    });

    it('encodes 23:59 on Dec 31 correctly', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 0));

      await client.syncClock();

      // Time: 23:59 = (23 << 8) | 59 = 0x173B = 5947
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.TIME, (23 << 8) | 59);
      // Dec 31 = (12 << 8) | 31 = 0x0C1F = 3103
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.MONTH_DAY, (12 << 8) | 31);

      vi.useRealTimers();
    });

    it('uses configured timezone for clock sync', async () => {
      const tzClient = new ModbusClient(log, createDevice({ timezone: 'Asia/Tokyo' }));

      vi.useFakeTimers();
      // Set system time to 2026-03-25 10:00 UTC — Tokyo is UTC+9 = 19:00
      vi.setSystemTime(new Date('2026-03-25T10:00:00Z'));

      await tzClient.syncClock();

      // Tokyo time: 19:00 = (19 << 8) | 0
      expect(mockModbusClient.writeRegister).toHaveBeenCalledWith(C4_REGISTERS.TIME, (19 << 8) | 0);

      vi.useRealTimers();
    });
  });

  describe('connection management', () => {
    it('connects with correct host, port, and slave ID', async () => {
      mockModbusClient.readHoldingRegisters
        .mockResolvedValueOnce(REAL_GENERAL_REGISTERS)
        .mockResolvedValueOnce(REAL_VENTILATION_REGISTERS)
        .mockResolvedValueOnce(REAL_TEMP_REGISTERS);

      await client.getStatus();

      expect(mockModbusClient.connectTCP).toHaveBeenCalledWith('192.168.88.5', { port: 502 });
      expect(mockModbusClient.setID).toHaveBeenCalledWith(20);
      expect(mockModbusClient.setTimeout).toHaveBeenCalledWith(10000);
    });

    it('throws and logs on connection failure', async () => {
      mockModbusClient.connectTCP.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.getStatus()).rejects.toThrow('ECONNREFUSED');
      expect(log.error).toHaveBeenCalled();
    });
  });

  describe('serialization', () => {
    it('serializes concurrent operations', async () => {
      const callOrder: string[] = [];

      mockModbusClient.writeRegister.mockImplementation(async (reg: number) => {
        callOrder.push(`write-${reg}`);
        await new Promise(r => setTimeout(r, 10));
      });

      // Fire two writes concurrently
      const p1 = client.setPower(true);
      const p2 = client.setPower(false);

      await Promise.all([p1, p2]);

      // Both should have written to START_STOP, and the second should wait for the first
      expect(callOrder[0]).toBe(`write-${C4_REGISTERS.START_STOP}`);
      expect(callOrder[1]).toBe(`write-${C4_REGISTERS.START_STOP}`);
    });
  });
});
