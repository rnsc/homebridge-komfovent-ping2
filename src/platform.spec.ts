import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KomfoventPing2Platform } from './platform';
import { KomfoventPing2Accessory } from './platformAccessory';
import type { API, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

// Mock platformAccessory to avoid Modbus connections during tests
vi.mock('./platformAccessory', () => ({
  KomfoventPing2Accessory: vi.fn(function (this: Record<string, unknown>) {
    this.shutdown = vi.fn();
  }),
}));

const MockedAccessory = vi.mocked(KomfoventPing2Accessory);

function createMockLog(): Logging {
  const log = vi.fn() as unknown as Logging;
  log.info = vi.fn();
  log.warn = vi.fn();
  log.error = vi.fn();
  log.debug = vi.fn();
  return log;
}

function createMockAPI(): API {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    hap: {
      uuid: {
        generate: vi.fn((id: string) => `uuid-${id}`),
      },
      Service: {},
      Characteristic: {},
      HapStatusError: vi.fn(),
      HAPStatus: {},
    },
    platformAccessory: vi.fn(function (this: Record<string, unknown>, name: string, uuid: string) {
      this.displayName = name;
      this.UUID = uuid;
      this.context = {};
      this.getService = vi.fn();
    }) as unknown,
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    _handlers: handlers,
  } as unknown as API & { _handlers: Record<string, (...args: unknown[]) => void> };
}

function createConfig(devices: unknown[]): PlatformConfig {
  return {
    platform: 'KomfoventPing2',
    devices,
  } as PlatformConfig;
}

describe('KomfoventPing2Platform', () => {
  let log: Logging;
  let api: API & { _handlers: Record<string, (...args: unknown[]) => void> };

  beforeEach(() => {
    vi.clearAllMocks();
    log = createMockLog();
    api = createMockAPI();
  });

  describe('discoverDevices', () => {
    it('applies default port 502 and slaveId 1', () => {
      const config = createConfig([
        { name: 'Vent', host: '192.168.88.5', deviceId: 'abcdef1234567890' },
      ]);

      new KomfoventPing2Platform(log, config, api);
      api._handlers['didFinishLaunching']();

      const device = config.devices[0];
      expect(device.port).toBe(502);
      expect(device.slaveId).toBe(1);
    });

    it('preserves user-specified port and slaveId', () => {
      const config = createConfig([
        { name: 'Vent', host: '192.168.88.5', port: 5020, slaveId: 20, deviceId: 'abcdef1234567890' },
      ]);

      new KomfoventPing2Platform(log, config, api);
      api._handlers['didFinishLaunching']();

      const device = config.devices[0];
      expect(device.port).toBe(5020);
      expect(device.slaveId).toBe(20);
    });

    it('skips devices missing required fields', () => {
      const config = createConfig([
        { name: 'No Host', deviceId: 'abcdef1234567890' },
        { host: '192.168.88.5', deviceId: 'abcdef1234567890' },
        { name: 'No ID', host: '192.168.88.5' },
        { name: 'Valid', host: '192.168.88.5', deviceId: '1234567890abcdef' },
      ]);

      new KomfoventPing2Platform(log, config, api);
      api._handlers['didFinishLaunching']();

      expect(log.warn).toHaveBeenCalledTimes(3);
      expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1);
    });

    it('handles empty devices array', () => {
      const config = createConfig([]);

      new KomfoventPing2Platform(log, config, api);
      api._handlers['didFinishLaunching']();

      expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    });

    it('handles missing devices key', () => {
      const config = { platform: 'KomfoventPing2' } as PlatformConfig;

      new KomfoventPing2Platform(log, config, api);
      api._handlers['didFinishLaunching']();

      expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
    });

    it('removes stale cached accessories not in config', () => {
      const config = createConfig([
        { name: 'Vent', host: '192.168.88.5', deviceId: 'abcdef1234567890' },
      ]);

      const platform = new KomfoventPing2Platform(log, config, api);

      // Simulate a cached accessory that's no longer in config
      const staleAccessory = {
        UUID: 'uuid-stale_device_id_',
        displayName: 'Old Device',
        context: {},
      } as unknown as PlatformAccessory;
      platform.configureAccessory(staleAccessory);

      api._handlers['didFinishLaunching']();

      expect(api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith('Removing stale accessory from cache:', 'Old Device');
    });

    it('restores existing cached accessory by UUID', () => {
      const config = createConfig([
        { name: 'Vent', host: '192.168.88.5', deviceId: 'abcdef1234567890' },
      ]);

      const platform = new KomfoventPing2Platform(log, config, api);

      const cachedAccessory = {
        UUID: 'uuid-abcdef1234567890',
        displayName: 'Vent',
        context: {},
        getService: vi.fn(),
      } as unknown as PlatformAccessory;
      platform.configureAccessory(cachedAccessory);

      api._handlers['didFinishLaunching']();

      // Should restore, not register new
      expect(api.registerPlatformAccessories).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith('Restoring existing accessory from cache:', 'Vent');
    });
  });

  describe('shutdown', () => {
    it('calls shutdown on all active accessories', () => {
      const config = createConfig([
        { name: 'Vent', host: '192.168.88.5', deviceId: 'abcdef1234567890' },
      ]);

      new KomfoventPing2Platform(log, config, api);
      api._handlers['didFinishLaunching']();
      api._handlers['shutdown']();

      const instance = MockedAccessory.mock.instances[0] as unknown as { shutdown: ReturnType<typeof vi.fn> };
      expect(instance.shutdown).toHaveBeenCalled();
    });
  });
});
