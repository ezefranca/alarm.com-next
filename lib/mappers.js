'use strict';

const PARTITION_STATES = Object.freeze({
  UNKNOWN: 0,
  DISARMED: 1,
  ARMED_STAY: 2,
  ARMED_AWAY: 3,
  ARMED_NIGHT: 4
});

const SENSOR_STATES = Object.freeze({
  UNKNOWN: 0,
  CLOSED: 1,
  OPEN: 2,
  IDLE: 3,
  ACTIVE: 4,
  DRY: 5,
  WET: 6,
  FULL: 7,
  LOW: 8,
  OPENED_CLOSED: 9,
  ISSUE: 10,
  OK: 11
});

const SENSOR_TYPES = Object.freeze({
  CONTACT: 1,
  MOTION: 2,
  SMOKE: 5,
  CO: 6,
  FREEZE: 8,
  PANIC: 9,
  FIXED_PANIC: 10,
  GLASS_BREAK: 19,
  CONTACT_SHOCK: 52,
  MOBILE_PHONE: 69,
  PANEL_IMAGE: 68,
  PANEL_GLASS_BREAK: 83,
  PANEL_MOTION: 89
});

const LIGHT_STATES = Object.freeze({
  ON: 2,
  OFF: 3
});

const LOCK_STATES = Object.freeze({
  LOCKED: 1,
  UNLOCKED: 2
});

const GARAGE_STATES = Object.freeze({
  OPEN: 1,
  CLOSED: 2
});

const THERMOSTAT_STATES = Object.freeze({
  UNKNOWN: 0,
  OFF: 1,
  HEAT: 2,
  COOL: 3,
  AUTO: 4,
  AUX_HEAT: 5
});

function normalizeBoolean(value) {
  return Boolean(value);
}

function isTriggeredBinaryState(state) {
  return Number.isFinite(state) && state !== SENSOR_STATES.UNKNOWN && state % 2 === 0;
}

function isBatteryLow(attributes) {
  return Boolean(
    attributes.lowBattery ||
      attributes.criticalBattery ||
      attributes.batteryLevelClassification === 0 ||
      attributes.batteryLevelClassification === 1
  );
}

function isMalfunctioning(attributes) {
  return Boolean(attributes.isInMalfunctionState || attributes.isMalfunctioning || attributes.hasRtsIssue);
}

function getPartitionHomeKitState(Characteristic, state) {
  switch (Number(state)) {
    case PARTITION_STATES.ARMED_STAY:
      return Characteristic.SecuritySystemCurrentState.STAY_ARM;
    case PARTITION_STATES.ARMED_AWAY:
      return Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    case PARTITION_STATES.ARMED_NIGHT:
      return Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
    case PARTITION_STATES.DISARMED:
    case PARTITION_STATES.UNKNOWN:
    default:
      return Characteristic.SecuritySystemCurrentState.DISARMED;
  }
}

function getSensorProfile(attributes) {
  const deviceType = Number(attributes.deviceType);
  const state = Number(attributes.state);

  if (deviceType === SENSOR_TYPES.CONTACT) {
    return {
      serviceName: 'ContactSensor',
      characteristicName: 'ContactSensorState',
      model: 'Contact Sensor'
    };
  }

  if (deviceType === SENSOR_TYPES.MOTION || deviceType === SENSOR_TYPES.PANEL_MOTION) {
    return {
      serviceName: 'MotionSensor',
      characteristicName: 'MotionDetected',
      model: 'Motion Sensor'
    };
  }

  if (deviceType === SENSOR_TYPES.SMOKE) {
    return {
      serviceName: 'SmokeSensor',
      characteristicName: 'SmokeDetected',
      model: 'Smoke Sensor'
    };
  }

  if (deviceType === SENSOR_TYPES.CO) {
    return {
      serviceName: 'CarbonMonoxideSensor',
      characteristicName: 'CarbonMonoxideDetected',
      model: 'Carbon Monoxide Sensor'
    };
  }

  if (
    deviceType === SENSOR_TYPES.GLASS_BREAK ||
    deviceType === SENSOR_TYPES.PANEL_GLASS_BREAK ||
    deviceType === SENSOR_TYPES.CONTACT_SHOCK
  ) {
    return {
      serviceName: 'ContactSensor',
      characteristicName: 'ContactSensorState',
      model: 'Glass Break Sensor'
    };
  }

  if (state === SENSOR_STATES.WET || state === SENSOR_STATES.DRY || state === SENSOR_STATES.FULL || state === SENSOR_STATES.LOW) {
    return {
      serviceName: 'LeakSensor',
      characteristicName: 'LeakDetected',
      model: 'Water Sensor'
    };
  }

  if (state === SENSOR_STATES.ACTIVE || state === SENSOR_STATES.IDLE) {
    return {
      serviceName: 'MotionSensor',
      characteristicName: 'MotionDetected',
      model: 'Motion Sensor'
    };
  }

  if (
    state === SENSOR_STATES.OPEN ||
    state === SENSOR_STATES.CLOSED ||
    state === SENSOR_STATES.OPENED_CLOSED
  ) {
    return {
      serviceName: 'ContactSensor',
      characteristicName: 'ContactSensorState',
      model: 'Contact Sensor'
    };
  }

  return null;
}

function getSensorCharacteristicValue(Characteristic, profile, attributes) {
  const isOn = isTriggeredBinaryState(Number(attributes.state));

  switch (profile.characteristicName) {
    case 'MotionDetected':
      return isOn;
    case 'SmokeDetected':
      return isOn ? Characteristic.SmokeDetected.SMOKE_DETECTED : Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
    case 'CarbonMonoxideDetected':
      return isOn
        ? Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
        : Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL;
    case 'LeakDetected':
      return isOn ? Characteristic.LeakDetected.LEAK_DETECTED : Characteristic.LeakDetected.LEAK_NOT_DETECTED;
    case 'ContactSensorState':
    default:
      return isOn
        ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : Characteristic.ContactSensorState.CONTACT_DETECTED;
  }
}

function getLightOn(attributes) {
  return Number(attributes.state) === LIGHT_STATES.ON;
}

function getLockCurrentState(Characteristic, state) {
  switch (Number(state)) {
    case LOCK_STATES.LOCKED:
      return Characteristic.LockCurrentState.SECURED;
    case LOCK_STATES.UNLOCKED:
      return Characteristic.LockCurrentState.UNSECURED;
    default:
      return Characteristic.LockCurrentState.UNKNOWN;
  }
}

function getLockTargetState(Characteristic, state) {
  switch (Number(state)) {
    case LOCK_STATES.UNLOCKED:
      return Characteristic.LockTargetState.UNSECURED;
    case LOCK_STATES.LOCKED:
    default:
      return Characteristic.LockTargetState.SECURED;
  }
}

function getGarageCurrentState(Characteristic, state) {
  switch (Number(state)) {
    case GARAGE_STATES.OPEN:
      return Characteristic.CurrentDoorState.OPEN;
    case GARAGE_STATES.CLOSED:
      return Characteristic.CurrentDoorState.CLOSED;
    default:
      return Characteristic.CurrentDoorState.STOPPED;
  }
}

function getGarageTargetState(Characteristic, state) {
  return Number(state) === GARAGE_STATES.OPEN
    ? Characteristic.TargetDoorState.OPEN
    : Characteristic.TargetDoorState.CLOSED;
}

function toHomeKitTemperature(rawValue, usesCelsius) {
  const numericValue = Number(rawValue);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return usesCelsius ? numericValue : ((numericValue - 32) * 5) / 9;
}

function fromHomeKitTemperature(rawValue, usesCelsius) {
  const numericValue = Number(rawValue);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return usesCelsius ? numericValue : (numericValue * 9) / 5 + 32;
}

function roundTemperature(value, step) {
  return Math.round(value / step) * step;
}

function coerceThermostatMode(value) {
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();

    if (lowered.includes('heat')) {
      return THERMOSTAT_STATES.HEAT;
    }

    if (lowered.includes('cool')) {
      return THERMOSTAT_STATES.COOL;
    }

    if (lowered.includes('off')) {
      return THERMOSTAT_STATES.OFF;
    }

    if (lowered.includes('auto')) {
      return THERMOSTAT_STATES.AUTO;
    }
  }

  return Number(value);
}

function getThermostatCurrentState(Characteristic, attributes) {
  const effectiveState = coerceThermostatMode(attributes.state) || coerceThermostatMode(attributes.inferredState);

  switch (effectiveState) {
    case THERMOSTAT_STATES.HEAT:
    case THERMOSTAT_STATES.AUX_HEAT:
      return Characteristic.CurrentHeatingCoolingState.HEAT;
    case THERMOSTAT_STATES.COOL:
      return Characteristic.CurrentHeatingCoolingState.COOL;
    default:
      return Characteristic.CurrentHeatingCoolingState.OFF;
  }
}

function getThermostatTargetState(Characteristic, attributes) {
  switch (coerceThermostatMode(attributes.desiredState)) {
    case THERMOSTAT_STATES.HEAT:
    case THERMOSTAT_STATES.AUX_HEAT:
      return Characteristic.TargetHeatingCoolingState.HEAT;
    case THERMOSTAT_STATES.COOL:
      return Characteristic.TargetHeatingCoolingState.COOL;
    case THERMOSTAT_STATES.AUTO:
      return Characteristic.TargetHeatingCoolingState.AUTO;
    default:
      return Characteristic.TargetHeatingCoolingState.OFF;
  }
}

function getThermostatTargetTemperature(attributes, usesCelsius) {
  const desiredState = coerceThermostatMode(attributes.desiredState);
  let sourceValue = null;

  if (desiredState === THERMOSTAT_STATES.HEAT || desiredState === THERMOSTAT_STATES.AUX_HEAT) {
    sourceValue = attributes.desiredHeatSetpoint ?? attributes.heatSetpoint;
  } else if (desiredState === THERMOSTAT_STATES.COOL) {
    sourceValue = attributes.desiredCoolSetpoint ?? attributes.coolSetpoint;
  } else if (coerceThermostatMode(attributes.inferredState) === THERMOSTAT_STATES.HEAT) {
    sourceValue = attributes.desiredHeatSetpoint ?? attributes.heatSetpoint;
  } else if (coerceThermostatMode(attributes.inferredState) === THERMOSTAT_STATES.COOL) {
    sourceValue = attributes.desiredCoolSetpoint ?? attributes.coolSetpoint;
  } else if (
    Number.isFinite(attributes.desiredHeatSetpoint) &&
    Number.isFinite(attributes.desiredCoolSetpoint)
  ) {
    sourceValue = (Number(attributes.desiredHeatSetpoint) + Number(attributes.desiredCoolSetpoint)) / 2;
  } else {
    sourceValue = attributes.heatSetpoint ?? attributes.coolSetpoint ?? attributes.ambientTemp;
  }

  return toHomeKitTemperature(sourceValue, usesCelsius);
}

function getThermostatTemperatureProps(attributes, usesCelsius) {
  const minSource = Number.isFinite(Number(attributes.minHeatSetpoint))
    ? Number(attributes.minHeatSetpoint)
    : Number(attributes.minCoolSetpoint);
  const maxSource = Number.isFinite(Number(attributes.maxCoolSetpoint))
    ? Number(attributes.maxCoolSetpoint)
    : Number(attributes.maxHeatSetpoint);

  const minValue = toHomeKitTemperature(minSource, usesCelsius);
  const maxValue = toHomeKitTemperature(maxSource, usesCelsius);
  const minStep = usesCelsius ? 0.5 : 0.5;

  return {
    minValue: Number.isFinite(minValue) ? roundTemperature(minValue, minStep) : 7,
    maxValue: Number.isFinite(maxValue) ? roundTemperature(maxValue, minStep) : 35,
    minStep
  };
}

function getThermostatSetpointField(attributes) {
  const desiredState = coerceThermostatMode(attributes.desiredState);

  if (desiredState === THERMOSTAT_STATES.COOL) {
    return 'desiredCoolSetpoint';
  }

  if (desiredState === THERMOSTAT_STATES.HEAT || desiredState === THERMOSTAT_STATES.AUX_HEAT) {
    return 'desiredHeatSetpoint';
  }

  if (coerceThermostatMode(attributes.inferredState) === THERMOSTAT_STATES.COOL) {
    return 'desiredCoolSetpoint';
  }

  return 'desiredHeatSetpoint';
}

module.exports = {
  GARAGE_STATES,
  LIGHT_STATES,
  LOCK_STATES,
  PARTITION_STATES,
  SENSOR_STATES,
  SENSOR_TYPES,
  THERMOSTAT_STATES,
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
  normalizeBoolean,
  roundTemperature,
  toHomeKitTemperature
};
