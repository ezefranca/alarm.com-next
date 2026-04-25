'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AlarmDotComClient } = require('../lib/alarmdotcom-client');

test('loads identity during login bootstrap without recursively re-entering login', async () => {
  const client = new AlarmDotComClient({
    password: 'secret',
    username: 'user@example.com'
  });

  client.ajaxKey = 'ajax-key';
  client.sessionExpiresAt = Date.now() + 60_000;

  client.login = async () => {
    throw new Error('login() should not be called while bootstrap API requests are already authenticated');
  };

  client._requestJson = async (method, url) => {
    assert.equal(method, 'GET');
    assert.equal(url, 'https://www.alarm.com/web/api/identities');

    return {
      data: [
        {
          attributes: {
            localizeTempUnitsToCelsius: false
          },
          id: 'identity-1',
          relationships: {
            selectedSystem: {
              data: {
                id: 'system-1'
              }
            }
          }
        }
      ]
    };
  };

  await client._loadIdentity();

  assert.equal(client.identity.id, 'identity-1');
  assert.deepEqual(client.systemIds, ['system-1']);
  assert.equal(client.usesCelsius, false);
});
