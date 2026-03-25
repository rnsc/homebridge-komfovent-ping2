import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import type { Device } from './types';

import { KomfoventPing2Accessory } from './platformAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export class KomfoventPing2Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  private readonly activeAccessories: KomfoventPing2Accessory[] = [];

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      log.debug('Shutting down — cleaning up accessories');
      for (const acc of this.activeAccessories) {
        acc.shutdown();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  discoverDevices() {
    const devices: Device[] = this.config.devices ?? [];
    const discoveredUUIDs = new Set<string>();

    for (const device of devices) {
      if (!device.name || !device.host || !device.deviceId) {
        this.log.warn('Skipping device with missing required fields (name, host, deviceId):', JSON.stringify(device));
        continue;
      }

      device.port = device.port ?? 502;
      device.slaveId = device.slaveId ?? 1;

      const uuid = this.api.hap.uuid.generate(device.deviceId);
      discoveredUUIDs.add(uuid);

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context.device = device;
        this.activeAccessories.push(new KomfoventPing2Accessory(this, existingAccessory));
      } else {
        this.log.info('Adding new accessory:', device.name);
        const accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        this.accessories.set(uuid, accessory);
        this.activeAccessories.push(new KomfoventPing2Accessory(this, accessory));
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!discoveredUUIDs.has(uuid)) {
        this.log.info('Removing stale accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }
}
