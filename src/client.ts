/* eslint-disable @typescript-eslint/no-explicit-any */
import {HomebridgeKomfoventPing2} from './platform';
import axios from 'axios';
import { PlatformConfig } from 'homebridge';
import { Device } from './types';

export class Ping2JsonClient {

  constructor(private readonly platform: HomebridgeKomfoventPing2,
              private readonly device: Device,
              private readonly config: PlatformConfig) {
  }

  async getStatus(): Promise<{ active: string ; speed: number }> {
    this.platform.log.info('Get status');
    return axios.get(this.device.url, {
      headers:{
        'Accept': 'application/json',
      },
    }).then((response)=>{
      this.platform.log.info(`Reply from Python JSON API: ${response.data}`);
      return response.data;
    })
      .catch((error) => {
        this.platform.log.error('Error with getRequest:', error);
        return Promise.resolve();
      });
  }

  async setPower(value: string) {
    this.platform.log.info('Turn on/off ->', value.toString());
    return this.putRequest(this.device.deviceId, { 'active': value }, 'setPower', 'Error updating power:');
  }

  async setSpeed(value: number) {
    this.platform.log.info('Change speed ->', value);
    return this.putRequest(this.device.deviceId, { 'speed': value }, 'setSpeed', 'Error updating speed:');
  }

  private putRequest(deviceId: string, requestData: any, caller: string, errorHeader: string): Promise<boolean>{
    this.platform.log.info(`${caller}-> requestData: ${JSON.stringify(requestData)}`);
    return axios.put(this.device.url,
      requestData, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      })
      .then(res => {
        this.platform.log.info(`${caller}-> device: ${deviceId}; response:${JSON.stringify(res.data)}`);
        return true;
      })
      .catch((error) => {
        this.platform.log.error(errorHeader, error);
        return false;
      },
      );
  }
}
