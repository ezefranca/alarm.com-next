'use strict';

const path = require('node:path');
const { APIEvent } = require('homebridge');

const {
  AlarmDotComClient,
  AuthenticationError,
  OtpRequiredError
} = require('./alarmdotcom-client');
const {
  fromHomeKitTemperature,
  getGarageCurrentState,
  getGarageTargetState,
  getLightOn,
  getLockCurrentState,
  getLockTargetState,
  getPartitionHomeKitState,
  getSensorCharacteristicValue,
  getSensorProfile,
  getThermostatCurrentState,
  getThermostatSetpointField,
  getThermostatTargetState,
  getThermostatTargetTemperature,
  getThermostatTemperatureProps,
  isBatteryLow,
  isMalfunctioning,
  THERMOSTAT_STATES,
  toHomeKitTemperature
} = require('./mappers');
const { TokenStore, getDefaultTokenPath } = require('./token-store');

const PLUGIN_NAME = 'homebridge-alarmdotcom';
const PLATFORM_NAME = 'Alarmdotcom';
const LEGACY_PLUGIN_NAME = 'homebridge-alarmdotcom-trusted-device';
const LEGACY_PLATFORM_NAME = 'AlarmdotcomTrustedDevice';
const MANUFACTURER = 'Alarm.com';

const DEFAULT_CONFIG = Object.freeze({
  armingModes: {
    away: {
      forceBypass: false,
      nightArming: false,
      noEntryDelay: false,
      silentArming: false
    },
    night: {
      forceBypass: false,
      nightArming: true,
      noEntryDelay: false,
      silentArming: false
    },
    stay: {
      forceBypass: false,
      nightArming: false,
      noEntryDelay: false,
      silentArming: false
    }
  },
  authTimeoutMinutes: 10,
  ignoredDevices: [],
  logLevel: 'info',
  pollIntervalSeconds: 60
});

class AlarmDotComPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = normalizeConfig(config || {});
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.accessories = new Map();
    this.refreshPromise = null;
    this.pollTimer = null;
    this.refreshTimer = null;
    this.currentAuthToken = null;
    this.client = null;
    this.tokenStore = null;

    if (!this.api) {
      return;
    }

    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      void this.start();
    });
  }

  configureAccessory(accessory) {
    if (!accessory.context || !accessory.context.id) {
      this.log.warn(`Ignoring cached Alarm.com accessory without a device id: ${accessory.displayName}`);
      return;
    }

    this.accessories.set(accessory.context.id, accessory);
  }

  async start() {
    if (!this.config.username || !this.config.password) {
      this.log.error('Alarm.com plugin requires both "username" and "password" in the platform config.');
      return;
    }

    const tokenPath = this.config.tokenPath || getDefaultTokenPath(this.api.user.storagePath());
    this.tokenStore = new TokenStore(tokenPath);
    this.currentAuthToken = await this.tokenStore.getToken(this.config.username);

    this.client = new AlarmDotComClient({
      authToken: this.currentAuthToken,
      logger: this._clientLogger(),
      password: this.config.password,
      sessionTtlMs: this.config.authTimeoutMinutes * 60 * 1000,
      username: this.config.username
    });

    try {
      await this.client.login();
      await this.persistAuthToken();
      await this.refreshDevices();
      this.startPolling();
    } catch (error) {
      this.handleStartupError(error, tokenPath);
    }
  }

  async refreshDevices() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this._refreshDevices().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  async _refreshDevices() {
    const snapshot = await this.client.getSnapshot();
    await this.persistAuthToken();

    const seenIds = new Set();

    for (const partition of snapshot.partitions) {
      if (this.isIgnoredDevice(partition.id)) {
        continue;
      }

      this.upsertPartitionAccessory(partition);
      seenIds.add(partition.id);
    }

    for (const sensor of [...snapshot.sensors, ...snapshot.waterSensors]) {
      if (this.isIgnoredDevice(sensor.id)) {
        continue;
      }

      if (!this.upsertSensorAccessory(sensor)) {
        continue;
      }

      seenIds.add(sensor.id);
    }

    for (const light of snapshot.lights) {
      if (this.isIgnoredDevice(light.id)) {
        continue;
      }

      this.upsertLightAccessory(light);
      seenIds.add(light.id);
    }

    for (const lock of snapshot.locks) {
      if (this.isIgnoredDevice(lock.id)) {
        continue;
      }

      this.upsertLockAccessory(lock);
      seenIds.add(lock.id);
    }

    for (const garageDoor of snapshot.garageDoors) {
      if (this.isIgnoredDevice(garageDoor.id)) {
        continue;
      }

      this.upsertGarageAccessory(garageDoor, false);
      seenIds.add(garageDoor.id);
    }

    for (const gate of snapshot.gates) {
      if (this.isIgnoredDevice(gate.id)) {
        continue;
      }

      this.upsertGarageAccessory(gate, true);
      seenIds.add(gate.id);
    }

    for (const thermostat of snapshot.thermostats) {
      if (this.isIgnoredDevice(thermostat.id)) {
        continue;
      }

      this.upsertThermostatAccessory(thermostat);
      seenIds.add(thermostat.id);
    }

    this.removeMissingAccessories(seenIds);
  }

  upsertPartitionAccessory(partition) {
    const accessory = this.getOrCreateAccessory(partition.id, partition.attributes.description, 'partition');
    const service =
      accessory.getService(this.Service.SecuritySystem) || accessory.addService(this.Service.SecuritySystem);

    accessory.context.model = 'Security Panel';
    accessory.context.name = partition.attributes.description;
    accessory.context.partitionId = partition.id;

    this.configureAccessoryInformation(accessory, partition, 'Security Panel');

    service
      .getCharacteristic(this.Characteristic.SecuritySystemCurrentState)
      .onGet(() => accessory.context.currentState);

    service
      .getCharacteristic(this.Characteristic.SecuritySystemTargetState)
      .onGet(() => accessory.context.targetState)
      .onSet(async (value) => {
        await this.handlePartitionTargetState(accessory, Number(value));
      });

    service
      .getCharacteristic(this.Characteristic.StatusFault)
      .onGet(() => accessory.context.statusFault);

    accessory.context.currentState = getPartitionHomeKitState(this.Characteristic, partition.attributes.state);
    accessory.context.targetState = getPartitionHomeKitState(this.Characteristic, partition.attributes.desiredState);
    accessory.context.statusFault = partition.attributes.needsClearIssuesPrompt
      ? this.Characteristic.StatusFault.GENERAL_FAULT
      : this.Characteristic.StatusFault.NO_FAULT;

    service.updateCharacteristic(
      this.Characteristic.SecuritySystemCurrentState,
      accessory.context.currentState
    );
    service.updateCharacteristic(
      this.Characteristic.SecuritySystemTargetState,
      accessory.context.targetState
    );
    service.updateCharacteristic(this.Characteristic.StatusFault, accessory.context.statusFault);
  }

  upsertSensorAccessory(sensor) {
    const profile = getSensorProfile(sensor.attributes);
    if (!profile) {
      return false;
    }

    let accessory = this.accessories.get(sensor.id);
    if (accessory && accessory.context.serviceName !== profile.serviceName) {
      this.unregisterAccessory(accessory);
      accessory = null;
    }

    accessory = accessory || this.getOrCreateAccessory(sensor.id, sensor.attributes.description, 'sensor');
    const serviceType = this.Service[profile.serviceName];
    const service = accessory.getService(serviceType) || accessory.addService(serviceType);

    accessory.context.model = profile.model;
    accessory.context.name = sensor.attributes.description;
    accessory.context.sensorId = sensor.id;
    accessory.context.serviceName = profile.serviceName;
    accessory.context.characteristicName = profile.characteristicName;

    this.configureAccessoryInformation(accessory, sensor, profile.model);

    service
      .getCharacteristic(this.Characteristic[profile.characteristicName])
      .onGet(() => accessory.context.sensorValue);

    service
      .getCharacteristic(this.Characteristic.StatusLowBattery)
      .onGet(() => accessory.context.batteryLow);

    service
      .getCharacteristic(this.Characteristic.StatusFault)
      .onGet(() => accessory.context.statusFault);

    accessory.context.sensorValue = getSensorCharacteristicValue(this.Characteristic, profile, sensor.attributes);
    accessory.context.batteryLow = isBatteryLow(sensor.attributes)
      ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    accessory.context.statusFault = isMalfunctioning(sensor.attributes)
      ? this.Characteristic.StatusFault.GENERAL_FAULT
      : this.Characteristic.StatusFault.NO_FAULT;

    service.updateCharacteristic(this.Characteristic[profile.characteristicName], accessory.context.sensorValue);
    service.updateCharacteristic(this.Characteristic.StatusLowBattery, accessory.context.batteryLow);
    service.updateCharacteristic(this.Characteristic.StatusFault, accessory.context.statusFault);

    return true;
  }

  upsertLightAccessory(light) {
    const accessory = this.getOrCreateAccessory(light.id, light.attributes.description, 'light');
    const service = accessory.getService(this.Service.Lightbulb) || accessory.addService(this.Service.Lightbulb);

    accessory.context.isDimmer = Boolean(light.attributes.isDimmer);
    accessory.context.lightId = light.id;
    accessory.context.model = light.attributes.isDimmer ? 'Dimmer Light' : 'Light';
    accessory.context.name = light.attributes.description;

    this.configureAccessoryInformation(accessory, light, accessory.context.model);

    service
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => accessory.context.on)
      .onSet(async (value) => {
        await this.handleLightOn(accessory, Boolean(value));
      });

    if (accessory.context.isDimmer) {
      service
        .getCharacteristic(this.Characteristic.Brightness)
        .onGet(() => accessory.context.brightness)
        .onSet(async (value) => {
          await this.handleLightBrightness(accessory, Number(value));
        });
    }

    accessory.context.on = getLightOn(light.attributes);
    accessory.context.brightness = Number.isFinite(Number(light.attributes.lightLevel))
      ? Number(light.attributes.lightLevel)
      : 100;

    service.updateCharacteristic(this.Characteristic.On, accessory.context.on);
    if (accessory.context.isDimmer) {
      service.updateCharacteristic(this.Characteristic.Brightness, accessory.context.brightness);
    }
  }

  upsertLockAccessory(lock) {
    const accessory = this.getOrCreateAccessory(lock.id, lock.attributes.description, 'lock');
    const service = accessory.getService(this.Service.LockMechanism) || accessory.addService(this.Service.LockMechanism);

    accessory.context.lockId = lock.id;
    accessory.context.model = 'Lock';
    accessory.context.name = lock.attributes.description;

    this.configureAccessoryInformation(accessory, lock, accessory.context.model);

    service
      .getCharacteristic(this.Characteristic.LockCurrentState)
      .onGet(() => accessory.context.currentState);

    service
      .getCharacteristic(this.Characteristic.LockTargetState)
      .onGet(() => accessory.context.targetState)
      .onSet(async (value) => {
        await this.handleLockTargetState(accessory, Number(value));
      });

    service
      .getCharacteristic(this.Characteristic.StatusLowBattery)
      .onGet(() => accessory.context.batteryLow);

    service
      .getCharacteristic(this.Characteristic.StatusFault)
      .onGet(() => accessory.context.statusFault);

    accessory.context.currentState = getLockCurrentState(this.Characteristic, lock.attributes.state);
    accessory.context.targetState = getLockTargetState(this.Characteristic, lock.attributes.desiredState);
    accessory.context.batteryLow = isBatteryLow(lock.attributes)
      ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    accessory.context.statusFault = isMalfunctioning(lock.attributes)
      ? this.Characteristic.StatusFault.GENERAL_FAULT
      : this.Characteristic.StatusFault.NO_FAULT;

    service.updateCharacteristic(this.Characteristic.LockCurrentState, accessory.context.currentState);
    service.updateCharacteristic(this.Characteristic.LockTargetState, accessory.context.targetState);
    service.updateCharacteristic(this.Characteristic.StatusLowBattery, accessory.context.batteryLow);
    service.updateCharacteristic(this.Characteristic.StatusFault, accessory.context.statusFault);
  }

  upsertGarageAccessory(device, isGate) {
    const accessory = this.getOrCreateAccessory(device.id, device.attributes.description, isGate ? 'gate' : 'garage');
    const service =
      accessory.getService(this.Service.GarageDoorOpener) || accessory.addService(this.Service.GarageDoorOpener);

    accessory.context.deviceId = device.id;
    accessory.context.isGate = Boolean(isGate);
    accessory.context.model = isGate ? 'Gate' : 'Garage Door';
    accessory.context.name = device.attributes.description;

    this.configureAccessoryInformation(accessory, device, accessory.context.model);

    service
      .getCharacteristic(this.Characteristic.CurrentDoorState)
      .onGet(() => accessory.context.currentState);

    service
      .getCharacteristic(this.Characteristic.TargetDoorState)
      .onGet(() => accessory.context.targetState)
      .onSet(async (value) => {
        await this.handleGarageTargetState(accessory, Number(value));
      });

    service
      .getCharacteristic(this.Characteristic.ObstructionDetected)
      .onGet(() => false);

    accessory.context.currentState = getGarageCurrentState(this.Characteristic, device.attributes.state);
    accessory.context.targetState = getGarageTargetState(this.Characteristic, device.attributes.desiredState);

    service.updateCharacteristic(this.Characteristic.CurrentDoorState, accessory.context.currentState);
    service.updateCharacteristic(this.Characteristic.TargetDoorState, accessory.context.targetState);
    service.updateCharacteristic(this.Characteristic.ObstructionDetected, false);
  }

  upsertThermostatAccessory(thermostat) {
    const accessory = this.getOrCreateAccessory(thermostat.id, thermostat.attributes.description, 'thermostat');
    const service =
      accessory.getService(this.Service.Thermostat) || accessory.addService(this.Service.Thermostat);

    accessory.context.deviceId = thermostat.id;
    accessory.context.model = 'Thermostat';
    accessory.context.name = thermostat.attributes.description;
    accessory.context.rawThermostat = thermostat.attributes;

    this.configureAccessoryInformation(accessory, thermostat, accessory.context.model);

    service
      .getCharacteristic(this.Characteristic.CurrentHeatingCoolingState)
      .onGet(() => accessory.context.currentHeatingCoolingState);

    service
      .getCharacteristic(this.Characteristic.TargetHeatingCoolingState)
      .onGet(() => accessory.context.targetHeatingCoolingState)
      .onSet(async (value) => {
        await this.handleThermostatTargetState(accessory, Number(value));
      });

    service
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(() => accessory.context.currentTemperature);

    service
      .getCharacteristic(this.Characteristic.TargetTemperature)
      .setProps(getThermostatTemperatureProps(thermostat.attributes, this.client.usesCelsius))
      .onGet(() => accessory.context.targetTemperature)
      .onSet(async (value) => {
        await this.handleThermostatTargetTemperature(accessory, Number(value));
      });

    service
      .getCharacteristic(this.Characteristic.TemperatureDisplayUnits)
      .onGet(() => accessory.context.temperatureDisplayUnits);

    if (Number.isFinite(Number(thermostat.attributes.humidityLevel))) {
      if (!service.testCharacteristic(this.Characteristic.CurrentRelativeHumidity)) {
        service.addCharacteristic(this.Characteristic.CurrentRelativeHumidity);
      }

      service
        .getCharacteristic(this.Characteristic.CurrentRelativeHumidity)
        .onGet(() => accessory.context.currentHumidity);

      accessory.context.currentHumidity = Number(thermostat.attributes.humidityLevel);
      service.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, accessory.context.currentHumidity);
    }

    const currentTemperature =
      toHomeKitTemperature(thermostat.attributes.ambientTemp, this.client.usesCelsius) ??
      getThermostatTargetTemperature(thermostat.attributes, this.client.usesCelsius) ??
      20;

    accessory.context.currentHeatingCoolingState = getThermostatCurrentState(
      this.Characteristic,
      thermostat.attributes
    );
    accessory.context.targetHeatingCoolingState = getThermostatTargetState(
      this.Characteristic,
      thermostat.attributes
    );
    accessory.context.currentTemperature = currentTemperature;
    accessory.context.targetTemperature =
      getThermostatTargetTemperature(thermostat.attributes, this.client.usesCelsius) ?? currentTemperature;
    accessory.context.temperatureDisplayUnits = this.client.usesCelsius
      ? this.Characteristic.TemperatureDisplayUnits.CELSIUS
      : this.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;

    service.updateCharacteristic(
      this.Characteristic.CurrentHeatingCoolingState,
      accessory.context.currentHeatingCoolingState
    );
    service.updateCharacteristic(
      this.Characteristic.TargetHeatingCoolingState,
      accessory.context.targetHeatingCoolingState
    );
    service.updateCharacteristic(this.Characteristic.CurrentTemperature, accessory.context.currentTemperature);
    service.updateCharacteristic(this.Characteristic.TargetTemperature, accessory.context.targetTemperature);
    service.updateCharacteristic(
      this.Characteristic.TemperatureDisplayUnits,
      accessory.context.temperatureDisplayUnits
    );
  }

  async handlePartitionTargetState(accessory, homeKitTargetState) {
    const modes = this.config.armingModes;

    if (homeKitTargetState === this.Characteristic.SecuritySystemTargetState.DISARM) {
      await this.client.disarmPartition(accessory.context.partitionId);
      accessory.context.targetState = homeKitTargetState;
      this.scheduleRefresh(4000);
      return;
    }

    let mode = null;
    let options = null;

    if (homeKitTargetState === this.Characteristic.SecuritySystemTargetState.STAY_ARM) {
      mode = 'stay';
      options = modes.stay;
    } else if (homeKitTargetState === this.Characteristic.SecuritySystemTargetState.AWAY_ARM) {
      mode = 'away';
      options = modes.away;
    } else if (homeKitTargetState === this.Characteristic.SecuritySystemTargetState.NIGHT_ARM) {
      mode = 'night';
      options = modes.night;
    }

    if (!mode) {
      throw new Error(`Unsupported HomeKit partition target state: ${homeKitTargetState}`);
    }

    await this.client.armPartition(accessory.context.partitionId, mode, options);
    accessory.context.targetState = homeKitTargetState;
    this.scheduleRefresh(6000);
  }

  async handleLightOn(accessory, on) {
    const brightness = accessory.context.isDimmer ? accessory.context.brightness || 100 : 100;
    await this.client.setLightState(accessory.context.lightId, {
      brightness,
      isDimmer: accessory.context.isDimmer,
      on
    });
    accessory.context.on = on;
    this.scheduleRefresh(1500);
  }

  async handleLightBrightness(accessory, brightness) {
    const normalizedBrightness = Math.max(0, Math.min(100, Math.round(brightness)));
    await this.client.setLightState(accessory.context.lightId, {
      brightness: normalizedBrightness,
      isDimmer: true,
      on: normalizedBrightness > 0
    });
    accessory.context.brightness = normalizedBrightness;
    accessory.context.on = normalizedBrightness > 0;
    this.scheduleRefresh(1500);
  }

  async handleLockTargetState(accessory, homeKitTargetState) {
    const locked = homeKitTargetState === this.Characteristic.LockTargetState.SECURED;
    await this.client.setLockState(accessory.context.lockId, locked);
    accessory.context.targetState = homeKitTargetState;
    this.scheduleRefresh(1500);
  }

  async handleGarageTargetState(accessory, homeKitTargetState) {
    const open = homeKitTargetState === this.Characteristic.TargetDoorState.OPEN;
    await this.client.setGarageState(accessory.context.deviceId, open, accessory.context.isGate);
    accessory.context.targetState = homeKitTargetState;
    this.scheduleRefresh(2000);
  }

  async handleThermostatTargetState(accessory, homeKitTargetState) {
    let desiredState = THERMOSTAT_STATES.OFF;

    if (homeKitTargetState === this.Characteristic.TargetHeatingCoolingState.HEAT) {
      desiredState = THERMOSTAT_STATES.HEAT;
    } else if (homeKitTargetState === this.Characteristic.TargetHeatingCoolingState.COOL) {
      desiredState = THERMOSTAT_STATES.COOL;
    } else if (homeKitTargetState === this.Characteristic.TargetHeatingCoolingState.AUTO) {
      desiredState = THERMOSTAT_STATES.AUTO;
    }

    await this.client.setThermostatMode(accessory.context.deviceId, desiredState);
    accessory.context.targetHeatingCoolingState = homeKitTargetState;
    if (accessory.context.rawThermostat) {
      accessory.context.rawThermostat.desiredState = desiredState;
    }
    this.scheduleRefresh(2000);
  }

  async handleThermostatTargetTemperature(accessory, value) {
    const fieldName = getThermostatSetpointField(accessory.context.rawThermostat || {});
    const convertedValue = fromHomeKitTemperature(value, this.client.usesCelsius);

    await this.client.setThermostatSetpoint(accessory.context.deviceId, fieldName, convertedValue);
    accessory.context.targetTemperature = value;
    if (accessory.context.rawThermostat) {
      accessory.context.rawThermostat[fieldName] = convertedValue;
    }
    this.scheduleRefresh(2000);
  }

  getOrCreateAccessory(id, name, kind) {
    if (this.accessories.has(id)) {
      return this.accessories.get(id);
    }

    const uuid = this.api.hap.uuid.generate(`alarmdotcom:${id}`);
    const accessory = new this.api.platformAccessory(name, uuid);
    accessory.context.id = id;
    accessory.context.kind = kind;
    accessory.context.name = name;
    this.accessories.set(id, accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    return accessory;
  }

  unregisterAccessory(accessory) {
    this.accessories.delete(accessory.context.id);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  removeMissingAccessories(seenIds) {
    for (const [id, accessory] of this.accessories.entries()) {
      if (this.isIgnoredDevice(id)) {
        this.unregisterAccessory(accessory);
        continue;
      }

      if (!seenIds.has(id)) {
        this.unregisterAccessory(accessory);
      }
    }
  }

  configureAccessoryInformation(accessory, device, model) {
    const information =
      accessory.getService(this.Service.AccessoryInformation) ||
      accessory.addService(this.Service.AccessoryInformation);

    information
      .setCharacteristic(this.Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(this.Characteristic.Model, model)
      .setCharacteristic(this.Characteristic.SerialNumber, device.id);

    if (device.attributes && device.attributes.manufacturer) {
      information.setCharacteristic(this.Characteristic.Manufacturer, device.attributes.manufacturer);
    }
  }

  async persistAuthToken() {
    if (!this.tokenStore || !this.client || !this.client.authToken) {
      return;
    }

    if (this.client.authToken === this.currentAuthToken) {
      return;
    }

    await this.tokenStore.saveToken({
      deviceName: null,
      source: 'login',
      token: this.client.authToken,
      username: this.config.username
    });

    this.currentAuthToken = this.client.authToken;
  }

  startPolling() {
    const pollIntervalMs = this.config.pollIntervalSeconds * 1000;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      void this.refreshDevices().catch((error) => {
        this.log.error(`Alarm.com refresh failed: ${error.message}`);
      });
    }, pollIntervalMs);
  }

  scheduleRefresh(delayMs) {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshDevices().catch((error) => {
        this.log.error(`Alarm.com refresh after command failed: ${error.message}`);
      });
    }, delayMs);
  }

  handleStartupError(error, tokenPath) {
    if (error instanceof OtpRequiredError) {
      const methods = error.enabledMethods && error.enabledMethods.length
        ? error.enabledMethods.join(', ')
        : 'app, sms, email';
      this.log.error(
        `Alarm.com requires this Homebridge instance to be enrolled for long-lived auth.`
      );
      this.log.error(
        `Run "alarmdotcom-auth --username ${this.config.username} --token-file ${tokenPath}" and complete one of: ${methods}, or import an existing token with "--auth-token".`
      );
      return;
    }

    if (error instanceof AuthenticationError) {
      this.log.error(`Alarm.com authentication failed: ${error.message}`);
      return;
    }

    this.log.error(`Alarm.com startup failed: ${error.message}`);
  }

  isIgnoredDevice(id) {
    return this.config.ignoredDevices.includes(id);
  }

  _clientLogger() {
    return {
      debug: (message) => this.logDebug(message),
      error: (message) => this.log.error(message),
      info: (message) => this.logInfo(message),
      warn: (message) => this.log.warn(message)
    };
  }

  logDebug(message) {
    if (this.shouldLog('debug')) {
      this.log.debug(message);
    }
  }

  logInfo(message) {
    if (this.shouldLog('info')) {
      this.log.info(message);
    }
  }

  shouldLog(level) {
    const order = {
      debug: 3,
      error: 0,
      info: 2,
      warn: 1
    };

    return order[level] <= order[this.config.logLevel];
  }
}

function normalizeConfig(config) {
  return {
    armingModes: {
      away: {
        ...DEFAULT_CONFIG.armingModes.away,
        ...(config.armingModes && config.armingModes.away ? config.armingModes.away : {})
      },
      night: {
        ...DEFAULT_CONFIG.armingModes.night,
        ...(config.armingModes && config.armingModes.night ? config.armingModes.night : {})
      },
      stay: {
        ...DEFAULT_CONFIG.armingModes.stay,
        ...(config.armingModes && config.armingModes.stay ? config.armingModes.stay : {})
      }
    },
    authTimeoutMinutes: Number(config.authTimeoutMinutes) > 0
      ? Number(config.authTimeoutMinutes)
      : DEFAULT_CONFIG.authTimeoutMinutes,
    ignoredDevices: Array.isArray(config.ignoredDevices)
      ? config.ignoredDevices.map((value) => String(value))
      : DEFAULT_CONFIG.ignoredDevices,
    logLevel: ['debug', 'info', 'warn', 'error'].includes(String(config.logLevel).toLowerCase())
      ? String(config.logLevel).toLowerCase()
      : DEFAULT_CONFIG.logLevel,
    password: config.password,
    pollIntervalSeconds: Number(config.pollIntervalSeconds) >= 30
      ? Number(config.pollIntervalSeconds)
      : DEFAULT_CONFIG.pollIntervalSeconds,
    tokenPath: config.tokenPath ? path.resolve(config.tokenPath) : null,
    username: config.username
  };
}

module.exports = {
  AlarmDotComPlatform,
  LEGACY_PLATFORM_NAME,
  LEGACY_PLUGIN_NAME,
  PLATFORM_NAME,
  PLUGIN_NAME
};
