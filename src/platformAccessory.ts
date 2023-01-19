import { Service, PlatformAccessory, CharacteristicValue, PlatformConfig } from 'homebridge';

import { KomfoventPing2Platform } from './platform';

import { Device } from './types';

import { Ping2JsonClient } from './client';

export class KomfoventPing2Accessory {
  private service: Service;
  private client: Ping2JsonClient;
  private lastSpeedChangeTime = 0;

  constructor(
    private readonly platform: KomfoventPing2Platform,
    private readonly accessory: PlatformAccessory,
    private readonly device: Device,
    private readonly config: PlatformConfig,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Komfovent')
      .setCharacteristic(this.platform.Characteristic.Model, 'Ping2')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'DomektC4Ping2');

    this.service = this.accessory.getService(this.platform.Service.Fan) || this.accessory.addService(this.platform.Service.Fan);

    this.service.setCharacteristic(this.platform.Characteristic.Name, device.name);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActive.bind(this));

    // register handlers for the Brightness Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onSet(this.setRotationSpeed.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 5,
      });

    this.client = new Ping2JsonClient(platform, this.device, this.config);

    setInterval(() => {
      this.platform.log.warn('setInterval');
    }, 10000);
  }

  async getActive(): Promise<CharacteristicValue> {
    this.platform.log.info('getting state');
    return this.client.getStatus()
      .then(status => {
        this.service.updateCharacteristic(this.platform.Characteristic.RotationSpeed, status.speed);
        return status.active;
      });
  }

  async setActive(value: CharacteristicValue) {
    this.platform.log.info('setting active state');
    this.client.setPower(<string>value);
  }

  async setRotationSpeed(value: CharacteristicValue) {
    value = this.checkAndRoundValue(<number>value);
    if (<number>value < 20 || <number>value > 80 || <number>value % 5 !== 0) {
      this.platform.log.warn('Invalid speed setting. Speed must be between 20 and 80.');
    } else {
      this.platform.log.info('setting speed');
      this.lastSpeedChangeTime = Date.now();
      await this.client.setSpeed(<number>value);
    }
  }

  checkAndRoundValue(value: number) {
    // Ensure the value is between 20 and 80
    if (value < 20) {
      value = 20;
    } else if (value > 80) {
      value = 80;
    }
    // Round the value to the nearest multiple of 5
    value = Math.round(value / 5) * 5;
    return value;
  }

}
