import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KomfoventPing2Accessory } from './platformAccessory';

// Timing constants mirror the (non-exported) values in platformAccessory.ts
const POLL_INTERVAL_MS = 30_000;
const SPEED_DEBOUNCE_MS = 500;

const mockClient = {
  getStatus: vi.fn(),
  setPower: vi.fn().mockResolvedValue(undefined),
  setMode2Speed: vi.fn().mockResolvedValue(undefined),
  syncClock: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
};

vi.mock('./client', () => ({
  ModbusClient: vi.fn(function (this: Record<string, unknown>) {
    Object.assign(this, mockClient);
  }),
  C4_REGISTERS: {},
}));

// Stable identity keys standing in for HAP Characteristic / Service constructors
const Characteristic = {
  On: 'On',
  RotationSpeed: 'RotationSpeed',
  CurrentTemperature: 'CurrentTemperature',
  Name: 'Name',
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
};

const Service = {
  Fan: 'Fan',
  TemperatureSensor: 'TemperatureSensor',
  AccessoryInformation: 'AccessoryInformation',
};

interface MockChar {
  onSet: ReturnType<typeof vi.fn>;
  onGet: ReturnType<typeof vi.fn>;
  setProps: ReturnType<typeof vi.fn>;
  updateValue: ReturnType<typeof vi.fn>;
}

function createCharacteristic(): MockChar {
  const char = {} as MockChar;
  char.onSet = vi.fn(() => char);
  char.onGet = vi.fn(() => char);
  char.setProps = vi.fn(() => char);
  char.updateValue = vi.fn(() => char);
  return char;
}

function createService() {
  const chars = new Map<string, MockChar>();
  const svc = {
    setCharacteristic: vi.fn(() => svc),
    updateCharacteristic: vi.fn(() => svc),
    getCharacteristic: vi.fn((c: string) => {
      if (!chars.has(c)) {
        chars.set(c, createCharacteristic());
      }
      return chars.get(c)!;
    }),
  };
  return svc;
}

function createPlatform() {
  return {
    Service,
    Characteristic,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    api: {
      hap: {
        HapStatusError: vi.fn(),
        HAPStatus: { SERVICE_COMMUNICATION_FAILURE: 1 },
      },
    },
  };
}

function createAccessory() {
  const services = new Map<string, ReturnType<typeof createService>>();
  // AccessoryInformation always exists on a real accessory
  services.set(Service.AccessoryInformation, createService());

  const accessory = {
    context: {
      device: {
        name: 'Test Vent',
        host: '192.168.88.5',
        deviceId: 'abcdef1234567890',
        port: 502,
        slaveId: 1,
      },
    },
    getService: vi.fn((type: string) => services.get(type)),
    getServiceById: vi.fn((type: string, sub: string) => services.get(`${type}:${sub}`)),
    addService: vi.fn((type: string, _name?: string, sub?: string) => {
      const key = sub ? `${type}:${sub}` : type;
      const svc = createService();
      services.set(key, svc);
      return svc;
    }),
  };

  return { accessory, services };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function newAccessory(accessory: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new KomfoventPing2Accessory(createPlatform() as any, accessory as any);
}

describe('KomfoventPing2Accessory', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockClient.getStatus.mockReset();
    mockClient.setPower.mockReset().mockResolvedValue(undefined);
    mockClient.setMode2Speed.mockReset().mockResolvedValue(undefined);
    mockClient.syncClock.mockReset().mockResolvedValue(undefined);
    mockClient.disconnect.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('setRotationSpeed', () => {
    it('powers the unit off when speed is set to 0', async () => {
      const { accessory } = createAccessory();
      const inst = newAccessory(accessory);

      await inst.setRotationSpeed(0);
      await vi.advanceTimersByTimeAsync(SPEED_DEBOUNCE_MS);

      expect(mockClient.setPower).toHaveBeenCalledWith(false);
      expect(mockClient.setMode2Speed).not.toHaveBeenCalled();

      inst.shutdown();
    });

    it('writes Mode 2 speed for non-zero values', async () => {
      const { accessory } = createAccessory();
      const inst = newAccessory(accessory);

      await inst.setRotationSpeed(45);
      await vi.advanceTimersByTimeAsync(SPEED_DEBOUNCE_MS);

      expect(mockClient.setMode2Speed).toHaveBeenCalledWith(45);
      expect(mockClient.setPower).not.toHaveBeenCalled();

      inst.shutdown();
    });

    it('debounces rapid changes to a single write', async () => {
      const { accessory } = createAccessory();
      const inst = newAccessory(accessory);

      await inst.setRotationSpeed(20);
      await inst.setRotationSpeed(40);
      await inst.setRotationSpeed(60);
      await vi.advanceTimersByTimeAsync(SPEED_DEBOUNCE_MS);

      expect(mockClient.setMode2Speed).toHaveBeenCalledTimes(1);
      expect(mockClient.setMode2Speed).toHaveBeenCalledWith(60);

      inst.shutdown();
    });
  });

  describe('pollStatus', () => {
    it('skips overlapping polls while a read is in flight', async () => {
      const { accessory } = createAccessory();
      // getStatus never settles → the first poll stays in flight
      mockClient.getStatus.mockReturnValue(new Promise(() => { /* pending */ }));
      const inst = newAccessory(accessory);

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // poll #1 starts, stays pending
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); // poll #2 should be skipped

      expect(mockClient.getStatus).toHaveBeenCalledTimes(1);

      inst.shutdown();
    });
  });

  describe('setpoint sensor', () => {
    it('registers a distinct setpoint temperature service', () => {
      const { accessory, services } = createAccessory();
      const inst = newAccessory(accessory);

      expect(services.has(`${Service.TemperatureSensor}:setpoint`)).toBe(true);

      inst.shutdown();
    });

    it('reports the setpoint temperature from unit status', async () => {
      const { accessory } = createAccessory();
      mockClient.getStatus.mockResolvedValue({
        active: true,
        mode2Speed: 50,
        supplyAirTemp: 18.8,
        setpointTemp: 18.0,
      });
      const inst = newAccessory(accessory);

      await expect(inst.getSetpointTemperature()).resolves.toBe(18.0);

      inst.shutdown();
    });
  });
});
