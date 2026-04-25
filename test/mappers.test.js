'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SENSOR_STATES,
  SENSOR_TYPES,
  getSensorProfile,
  toHomeKitTemperature,
  fromHomeKitTemperature
} = require('../lib/mappers');

test('maps contact sensors to HomeKit contact sensors', () => {
  const profile = getSensorProfile({
    deviceType: SENSOR_TYPES.CONTACT,
    state: SENSOR_STATES.CLOSED
  });

  assert.equal(profile.serviceName, 'ContactSensor');
  assert.equal(profile.characteristicName, 'ContactSensorState');
});

test('maps wet-dry sensors to HomeKit leak sensors', () => {
  const profile = getSensorProfile({
    deviceType: 999,
    state: SENSOR_STATES.WET
  });

  assert.equal(profile.serviceName, 'LeakSensor');
  assert.equal(profile.characteristicName, 'LeakDetected');
});

test('converts temperatures between Fahrenheit and Celsius', () => {
  const celsius = toHomeKitTemperature(68, false);
  assert.equal(Math.round(celsius), 20);

  const fahrenheit = fromHomeKitTemperature(20, false);
  assert.equal(Math.round(fahrenheit), 68);
});
