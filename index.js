'use strict';

const {
  AlarmDotComPlatform,
  LEGACY_PLATFORM_NAME,
  LEGACY_PLUGIN_NAME,
  PLATFORM_NAME,
  PLUGIN_NAME
} = require('./lib/platform');

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AlarmDotComPlatform);

  if (LEGACY_PLUGIN_NAME !== PLUGIN_NAME || LEGACY_PLATFORM_NAME !== PLATFORM_NAME) {
    api.registerPlatform(LEGACY_PLUGIN_NAME, LEGACY_PLATFORM_NAME, AlarmDotComPlatform);
  }
};
