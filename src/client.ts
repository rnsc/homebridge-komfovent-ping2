/* eslint-disable @typescript-eslint/no-explicit-any */
import {HomebridgeKomfoventPing2Platform} from './platform';
import axios from 'axios';
import { PlatformConfig } from 'homebridge';
import { Device } from './types';

export class Ping2JsonClient {

  constructor(private readonly platform: HomebridgeKomfoventPing2Platform,
              private readonly device: Device,
              private readonly config: PlatformConfig) {
  }

  async getStatus(): Promise<{ active: string ; speed: number }> {
    this.platform.log.info('Get status');
    return axios.get(this.config.url, {
      headers:{
        'Accept': 'application/json',
      },
    }).then((response)=>response.data)
      .catch((error) => {
        this.platform.log.error('Error with getRequest:', error);
        return Promise.resolve();
      });
  }

  async setPower(value: string) {
    this.platform.log.info('Turn on/off ->', value.toString());
    return this.putRequest(this.device.deviceId, { 'power': value }, 'setPower', 'Error updating power:');
  }

  async setSpeed(value: number) {
    this.platform.log.info('Change speed ->', value);
    return this.putRequest(this.device.deviceId, { 'speed': value }, 'setSpeed', 'Error updating speed:');
  }

  private putRequest(deviceId: string, requestData: any, caller: string, errorHeader: string): Promise<boolean>{
    this.platform.log.debug(`${caller}-> requestData: ${JSON.stringify(requestData)}`);
    return axios.put(this.config.url,
      requestData, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      })
      .then(res => {
        this.platform.log.debug(`${caller}-> device: ${deviceId}; response:${JSON.stringify(res.data)}`);
        return true;
      })
      .catch((error) => {
        this.platform.log.error(errorHeader, error);
        return false;
      },
      );
  }
}
