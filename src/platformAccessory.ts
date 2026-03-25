import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { KomfoventPing2Platform } from './platform';
import type { Device } from './types';

import { ModbusClient } from './client';

const POLL_INTERVAL_MS = 30_000;

export class KomfoventPing2Accessory {
  private readonly fanService: Service;
  private readonly temperatureService: Service;
  private readonly client: ModbusClient;
  private readonly device: Device;
  private readonly pollInterval: ReturnType<typeof setInterval>;

  constructor(
    private readonly platform: KomfoventPing2Platform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.device = accessory.context.device as Device;
    this.client = new ModbusClient(platform.log, this.device);

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Komfovent')
      .setCharacteristic(this.platform.Characteristic.Model, 'Domekt C4 / PING2')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.deviceId);

    // Fan service — On/Off + RotationSpeed mapped to ventilation level (1-3)
    this.fanService = this.accessory.getService(this.platform.Service.Fan)
      || this.accessory.addService(this.platform.Service.Fan);

    this.fanService.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.fanService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 33,
      });

    // Temperature sensor service — supply air temperature (read-only)
    this.temperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor)
      || this.accessory.addService(this.platform.Service.TemperatureSensor);

    this.temperatureService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${this.device.name} Supply Air`,
    );

    this.temperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getSupplyAirTemperature.bind(this));

    // Poll periodically to push state updates
    this.pollInterval = setInterval(() => this.pollStatus(), POLL_INTERVAL_MS);
  }

  shutdown(): void {
    clearInterval(this.pollInterval);
    this.client.disconnect();
  }

  // Maps ventilation level (1-3) to HomeKit RotationSpeed percentage
  private levelToPercent(level: number): number {
    return Math.round((level / 3) * 100);
  }

  // Maps HomeKit RotationSpeed percentage to ventilation level (1-3)
  private percentToLevel(percent: number): number {
    if (percent <= 0) {
      return 1;
    }
    return Math.min(3, Math.max(1, Math.round((percent / 100) * 3)));
  }

  private async pollStatus(): Promise<void> {
    try {
      const status = await this.client.getStatus();
      this.fanService.updateCharacteristic(this.platform.Characteristic.On, status.active);
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed,
        this.levelToPercent(status.ventilationLevel),
      );
      this.temperatureService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        status.supplyAirTemp,
      );
    } catch {
      this.platform.log.debug('Poll failed, will retry next interval');
    }
  }

  async getActive(): Promise<CharacteristicValue> {
    try {
      const status = await this.client.getStatus();
      this.fanService.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed,
        this.levelToPercent(status.ventilationLevel),
      );
      return status.active;
    } catch {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  async setActive(value: CharacteristicValue): Promise<void> {
    try {
      await this.client.setPower(value as boolean);
    } catch {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  async getRotationSpeed(): Promise<CharacteristicValue> {
    try {
      const status = await this.client.getStatus();
      return this.levelToPercent(status.ventilationLevel);
    } catch {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const level = this.percentToLevel(value as number);
    try {
      await this.client.setVentilationLevel(level);
    } catch {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  async getSupplyAirTemperature(): Promise<CharacteristicValue> {
    try {
      const status = await this.client.getStatus();
      return status.supplyAirTemp;
    } catch {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}
