'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { TokenStore } = require('../lib/token-store');

test('stores token metadata without breaking getToken()', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'alarmdotcom-token-store-'));
  const filePath = path.join(tempDirectory, 'alarmdotcom-auth.json');
  const store = new TokenStore(filePath);

  await store.saveToken({
    deviceName: 'Homebridge Test',
    source: 'manual',
    token: 'token-value',
    username: 'user@example.com'
  });

  const record = await store.getRecord('user@example.com');

  assert.equal(record.token, 'token-value');
  assert.equal(record.deviceName, 'Homebridge Test');
  assert.equal(record.source, 'manual');
  assert.ok(record.updatedAt);
  assert.equal(await store.getToken('user@example.com'), 'token-value');
});
