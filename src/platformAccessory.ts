import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { KomfoventPing2Platform } from './platform';
import type { Device } from './types';

import { ModbusClient } from './client';

const POLL_INTERVAL_MS = 30_000;
const CLOCK_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SPEED_DEBOUNCE_MS = 500;

export class KomfoventPing2Accessory {
  private readonly fanService: Service;
  private readonly temperatureService: Service;
  private readonly setpointService: Service;
  private readonly client: ModbusClient;
  private readonly device: Device;
  private readonly pollInterval: ReturnType<typeof setInterval>;
  private readonly clockSyncInterval: ReturnType<typeof setInterval>;
  private speedDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

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

    // Fan service — On/Off + RotationSpeed controlling Mode 2 intensity (5-95%, step 5)
    this.fanService = this.accessory.getService(this.platform.Service.Fan)
      || this.accessory.addService(this.platform.Service.Fan);

    this.fanService.setCharacteristic(this.platform.Characteristic.Name, this.device.name);

    this.fanService.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 5,
      })
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeed.bind(this));

    // Temperature sensor service — supply air temperature (read-only)
    this.temperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor)
      || this.accessory.addService(this.platform.Service.TemperatureSensor);

    this.temperatureService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${this.device.name} Supply Air`,
    );

    this.temperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getSupplyAirTemperature.bind(this));

    // Setpoint (target) temperature service — read-only, distinct subtype from the supply sensor
    this.setpointService = this.accessory.getServiceById(this.platform.Service.TemperatureSensor, 'setpoint')
      || this.accessory.addService(this.platform.Service.TemperatureSensor, `${this.device.name} Setpoint`, 'setpoint');

    this.setpointService.setCharacteristic(
      this.platform.Characteristic.Name,
      `${this.device.name} Setpoint`,
    );

    this.setpointService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.getSetpointTemperature.bind(this));

    // Poll periodically to push state updates
    this.pollInterval = setInterval(() => this.pollStatus(), POLL_INTERVAL_MS);

    // Sync PING2 clock from server time on startup and once per day
    this.syncClock();
    this.clockSyncInterval = setInterval(() => this.syncClock(), CLOCK_SYNC_INTERVAL_MS);
  }

  shutdown(): void {
    clearInterval(this.pollInterval);
    clearInterval(this.clockSyncInterval);
    if (this.speedDebounceTimer) {
      clearTimeout(this.speedDebounceTimer);
    }
    this.client.disconnect();
  }

  private async syncClock(): Promise<void> {
    try {
      await this.client.syncClock();
    } catch {
      this.platform.log.debug('Clock sync failed, will retry next interval');
    }
  }

  private async pollStatus(): Promise<void> {
    // Skip if a previous poll is still in flight (e.g. slow reads over a flaky link)
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const status = await this.client.getStatus();
      this.fanService.updateCharacteristic(this.platform.Characteristic.On, status.active);
      this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, status.mode2Speed);
      this.temperatureService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        status.supplyAirTemp,
      );
      this.setpointService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        status.setpointTemp,
      );
    } catch {
      this.platform.log.debug('Poll failed, will retry next interval');
      const hapError = new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
      this.fanService.getCharacteristic(this.platform.Characteristic.On).updateValue(hapError);
      this.fanService.getCharacteristic(this.platform.Characteristic.RotationSpeed).updateValue(hapError);
      this.temperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature).updateValue(hapError);
      this.setpointService.getCharacteristic(this.platform.Characteristic.CurrentTemperature).updateValue(hapError);
    } finally {
      this.polling = false;
    }
  }

  async getActive(): Promise<CharacteristicValue> {
    try {
      const status = await this.client.getStatus();
      this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, status.mode2Speed);
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
      return status.mode2Speed;
    } catch {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    if (this.speedDebounceTimer) {
      clearTimeout(this.speedDebounceTimer);
    }

    this.speedDebounceTimer = setTimeout(async () => {
      try {
        const speed = value as number;
        // Slider to 0 means "off" — Mode 2 intensity has a 5% floor, so route 0 to power-off
        if (speed === 0) {
          await this.client.setPower(false);
        } else {
          await this.client.setMode2Speed(speed);
        }
      } catch {
        this.platform.log.debug('Debounced speed write failed');
      }
    }, SPEED_DEBOUNCE_MS);
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

  async getSetpointTemperature(): Promise<CharacteristicValue> {
    try {
      const status = await this.client.getStatus();
      return status.setpointTemp;
    } catch {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}
