import type { API } from 'homebridge';

import { PLATFORM_NAME } from './settings';
import { KomfoventPing2Platform } from './platform';

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, KomfoventPing2Platform);
};
