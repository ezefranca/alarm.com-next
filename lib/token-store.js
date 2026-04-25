'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TOKEN_FILENAME = 'alarmdotcom-auth.json';

function expandHomePath(filePath) {
  if (!filePath) {
    return filePath;
  }

  if (filePath === '~') {
    return os.homedir();
  }

  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}

function getDefaultTokenPath(storageRoot) {
  const root = storageRoot || path.join(os.homedir(), '.homebridge');
  return path.join(root, DEFAULT_TOKEN_FILENAME);
}

class TokenStore {
  constructor(filePath) {
    this.filePath = expandHomePath(filePath || getDefaultTokenPath());
  }

  async readAll() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Token store at ${this.filePath} does not contain an object.`);
      }

      return parsed;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {};
      }

      throw error;
    }
  }

  async getRecord(username) {
    const allTokens = await this.readAll();
    return allTokens[username] || null;
  }

  async getToken(username) {
    const record = await this.getRecord(username);
    return record && typeof record.token === 'string' ? record.token : null;
  }

  async saveToken({ username, token, deviceName, source = null }) {
    const allTokens = await this.readAll();

    allTokens[username] = {
      token,
      deviceName: deviceName || null,
      source,
      updatedAt: new Date().toISOString()
    };

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(allTokens, null, 2)}\n`, 'utf8');
  }

  async deleteToken(username) {
    const allTokens = await this.readAll();

    if (!(username in allTokens)) {
      return;
    }

    delete allTokens[username];

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(allTokens, null, 2)}\n`, 'utf8');
  }
}

module.exports = {
  DEFAULT_TOKEN_FILENAME,
  TokenStore,
  expandHomePath,
  getDefaultTokenPath
};
