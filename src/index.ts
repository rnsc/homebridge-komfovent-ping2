import type { API } from 'homebridge';

import { PLATFORM_NAME } from './settings.js';
import { KomfoventPing2Platform } from './platform.js';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, KomfoventPing2Platform);
};
