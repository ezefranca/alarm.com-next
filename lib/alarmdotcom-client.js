'use strict';

const https = require('node:https');
const os = require('node:os');
const { URL, URLSearchParams } = require('node:url');

const BASE_URL = 'https://www.alarm.com/';
const BASE_ORIGIN = new URL(BASE_URL).origin;
const API_BASE_URL = 'https://www.alarm.com/web/api/';
const LOGIN_PAGE_URL = `${BASE_URL}login`;
const LOGIN_SUBMIT_URL = `${BASE_URL}web/Default.aspx`;
const IDENTITIES_PATH = 'identities';
const DEVICE_LINK_REQUEST_PATH = 'engines/deviceLinkRequest';
const TWO_FACTOR_PATH = 'engines/twoFactorAuthentication/twoFactorAuthentications';

const OTP_METHODS = Object.freeze({
  app: { key: 'app', value: 1 },
  sms: { key: 'sms', value: 2 },
  email: { key: 'email', value: 4 }
});

const RESOURCE_COLLECTIONS = Object.freeze({
  'devices/partition': { bucket: 'partitions', path: 'devices/partitions' },
  'devices/sensor': { bucket: 'sensors', path: 'devices/sensors' },
  'devices/water-sensor': { bucket: 'waterSensors', path: 'devices/waterSensors' },
  'devices/light': { bucket: 'lights', path: 'devices/lights' },
  'devices/lock': { bucket: 'locks', path: 'devices/locks' },
  'devices/garage-door': { bucket: 'garageDoors', path: 'devices/garageDoors' },
  'devices/gate': { bucket: 'gates', path: 'devices/gates' },
  'devices/thermostat': { bucket: 'thermostats', path: 'devices/thermostats' }
});

class AlarmDotComError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, details);
  }
}

class AuthenticationError extends AlarmDotComError {}
class SessionExpiredError extends AlarmDotComError {}
class InvalidOtpError extends AlarmDotComError {}
class InvalidDeviceLinkCodeError extends AlarmDotComError {}
class PermissionError extends AlarmDotComError {}

class OtpRequiredError extends AlarmDotComError {
  constructor(details) {
    super('Alarm.com requires two-factor authentication for this device.', details);
  }
}

class AlarmDotComClient {
  constructor({
    username,
    password,
    authToken = null,
    trustedDeviceToken = null,
    sessionTtlMs = 10 * 60 * 1000,
    timeoutMs = 30 * 1000,
    userAgent = 'homebridge-alarm.com-next/0.4.5',
    logger = {}
  }) {
    this.username = username;
    this.password = password;
    this.authToken = authToken || trustedDeviceToken;
    this.sessionTtlMs = sessionTtlMs;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;
    this.logger = {
      debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : () => {},
      info: typeof logger.info === 'function' ? logger.info.bind(logger) : () => {},
      warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {},
      error: typeof logger.error === 'function' ? logger.error.bind(logger) : () => {}
    };

    this.cookieJar = new Map();
    this.ajaxKey = null;
    this.identity = null;
    this.systemIds = [];
    this.usesCelsius = false;
    this.sessionExpiresAt = 0;
    this.loginPromise = null;
  }

  get trustedDeviceToken() {
    return this.authToken;
  }

  set trustedDeviceToken(value) {
    this.authToken = value;
  }

  async ensureSession() {
    if (this._hasActiveSession()) {
      return;
    }

    await this.login();
  }

  async login() {
    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = this._performLogin().finally(() => {
      this.loginPromise = null;
    });

    return this.loginPromise;
  }

  async _performLogin() {
    if (!this.username || !this.password) {
      throw new AuthenticationError('Alarm.com username and password are required.');
    }

    this.logger.debug('Starting Alarm.com login flow.');
    this.cookieJar.clear();
    this.ajaxKey = null;
    this.identity = null;
    this.systemIds = [];
    this.sessionExpiresAt = 0;

    this.logger.debug('Fetching Alarm.com login page.');
    const loginPage = await this._requestHtml('GET', LOGIN_PAGE_URL, {
      includeSessionCookies: false
    });
    this.logger.debug('Fetched Alarm.com login page.');

    const hiddenFields = this._extractLoginFields(loginPage.text);
    const body = new URLSearchParams({
      __EVENTTARGET: '',
      __EVENTARGUMENT: '',
      __VIEWSTATEENCRYPTED: '',
      __EVENTVALIDATION: hiddenFields.__EVENTVALIDATION,
      __VIEWSTATE: hiddenFields.__VIEWSTATE,
      __VIEWSTATEGENERATOR: hiddenFields.__VIEWSTATEGENERATOR,
      __PREVIOUSPAGE: hiddenFields.__PREVIOUSPAGE,
      IsFromNewSite: '1',
      'ctl00$ContentPlaceHolder1$loginform$txtUserName': this.username,
      txtPassword: this.password
    }).toString();

    this.logger.debug('Submitting Alarm.com credentials.');
    const loginResponse = await this._requestRaw('POST', LOGIN_SUBMIT_URL, {
      extraCookies: this.authToken ? { twoFactorAuthenticationId: this.authToken } : undefined,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: BASE_ORIGIN,
        Referer: LOGIN_PAGE_URL
      },
      body
    });
    this.logger.debug('Alarm.com credential submission returned a response.');

    const location = Array.isArray(loginResponse.headers.location)
      ? loginResponse.headers.location[0]
      : loginResponse.headers.location;

    if (location && String(location).includes('m=login_fail')) {
      throw new AuthenticationError('Alarm.com rejected the supplied username or password.');
    }

    if (location && String(location).includes('m=LockedOut')) {
      throw new AuthenticationError('Alarm.com reports that the account is locked.');
    }

    if (!this.ajaxKey) {
      throw new AuthenticationError('Alarm.com login succeeded without returning an anti-forgery key.');
    }

    // The authenticated web session is usable for API calls immediately after the
    // credential POST succeeds, even before identity metadata has been loaded.
    this.sessionExpiresAt = Date.now() + this.sessionTtlMs;

    this.logger.debug('Loading Alarm.com identity.');
    await this._loadIdentity();

    this.logger.debug('Loading Alarm.com two-factor status.');
    const twoFactor = await this.getTwoFactorDetails();
    if (twoFactor.isEnabled && !twoFactor.isCurrentDeviceTrusted) {
      throw new OtpRequiredError(twoFactor);
    }

    this.logger.debug('Alarm.com login flow completed successfully.');
  }

  async _loadIdentity() {
    const identities = await this._apiRequest('GET', IDENTITIES_PATH, {
      allowSessionRepair: false
    });

    const identityList = Array.isArray(identities.data) ? identities.data : [];
    if (!identityList.length) {
      throw new AuthenticationError('Alarm.com did not return any identities for the account.');
    }

    this.identity = identityList[0];
    this.usesCelsius = Boolean(this.identity.attributes && this.identity.attributes.localizeTempUnitsToCelsius);

    const systemIds = new Set();
    for (const identity of identityList) {
      const systemId = identity &&
        identity.relationships &&
        identity.relationships.selectedSystem &&
        identity.relationships.selectedSystem.data &&
        identity.relationships.selectedSystem.data.id;

      if (systemId) {
        systemIds.add(systemId);
      }
    }

    this.systemIds = [...systemIds];
    this.logger.debug(`Loaded ${identityList.length} Alarm.com identity record(s) and ${this.systemIds.length} system id(s).`);
  }

  async getTwoFactorDetails() {
    if (!this.identity || !this.identity.id) {
      throw new AuthenticationError('Alarm.com identity is not available. Log in before requesting MFA details.');
    }

    const response = await this._apiRequest(
      'GET',
      `${TWO_FACTOR_PATH}/${this.identity.id}`,
      { allowSessionRepair: false }
    );

    const attributes = (response.data && response.data.attributes) || {};
    const enabledMask = Number(attributes.enabledTwoFactorTypes || 0);
    const permissionList = Array.isArray(attributes.valid2FAPermissions) ? attributes.valid2FAPermissions : [];
    const enabledMethods = [];

    for (const method of Object.values(OTP_METHODS)) {
      if ((enabledMask & method.value) === method.value) {
        enabledMethods.push(method.key);
      }
    }

    if (!enabledMethods.length) {
      for (const rawPermission of permissionList) {
        const numericPermission = Number(
          typeof rawPermission === 'object' && rawPermission !== null
            ? rawPermission.value || rawPermission.id
            : rawPermission
        );

        for (const method of Object.values(OTP_METHODS)) {
          if (method.value === numericPermission && !enabledMethods.includes(method.key)) {
            enabledMethods.push(method.key);
          }
        }
      }
    }

    return {
      enabledMethods,
      email: attributes.email || null,
      isCurrentDeviceTrusted: Boolean(attributes.isCurrentDeviceTrusted),
      isEnabled: enabledMask > 0,
      raw: attributes,
      smsCountryCode: attributes.smsMobileNumber ? attributes.smsMobileNumber.country || null : null,
      smsNumber: attributes.smsMobileNumber ? attributes.smsMobileNumber.mobileNumber || null : null
    };
  }

  async requestOtp(method) {
    const normalizedMethod = normalizeOtpMethod(method);

    if (normalizedMethod === OTP_METHODS.app.key) {
      return;
    }

    if (!this.identity || !this.identity.id) {
      throw new AuthenticationError('Alarm.com identity is not available. Log in before requesting an OTP.');
    }

    const action =
      normalizedMethod === OTP_METHODS.sms.key
        ? 'sendTwoFactorAuthenticationCodeViaSms'
        : 'sendTwoFactorAuthenticationCodeViaEmail';

    await this._apiRequest('POST', `${TWO_FACTOR_PATH}/${this.identity.id}/${action}`, {
      allowSessionRepair: false,
      body: {}
    });
  }

  async completeAuthTokenEnrollment({ method, code, deviceName }) {
    const normalizedMethod = normalizeOtpMethod(method);

    if (!code || !String(code).trim()) {
      throw new InvalidOtpError('A non-empty Alarm.com one-time code is required.');
    }

    if (!this.identity || !this.identity.id) {
      throw new AuthenticationError('Alarm.com identity is not available. Log in before submitting an OTP.');
    }

    await this._apiRequest('POST', `${TWO_FACTOR_PATH}/${this.identity.id}/verifyTwoFactorCode`, {
      allowSessionRepair: false,
      body: {
        code: String(code).trim(),
        typeOf2FA: OTP_METHODS[normalizedMethod].value
      }
    });

    await this._apiRequest('POST', `${TWO_FACTOR_PATH}/${this.identity.id}/trustTwoFactorDevice`, {
      allowSessionRepair: false,
      body: {
        deviceName: deviceName || `Homebridge (${os.hostname()})`
      }
    });

    if (!this.authToken) {
      throw new AuthenticationError('Alarm.com did not return an auth token after OTP verification.');
    }

    this.sessionExpiresAt = Date.now() + this.sessionTtlMs;
    return this.authToken;
  }

  async completeTrustedDeviceEnrollment(options) {
    return this.completeAuthTokenEnrollment(options);
  }

  async approveDeviceLinkRequest(verificationCode) {
    const normalizedCode = String(verificationCode || '').trim();

    if (!normalizedCode) {
      throw new InvalidDeviceLinkCodeError('A non-empty Alarm.com device-link activation code is required.');
    }

    const previousAuthToken = this.authToken;

    try {
      const response = await this._apiRequest('POST', `${DEVICE_LINK_REQUEST_PATH}/verifyCode`, {
        allowSessionRepair: false,
        body: {
          verificationCode: normalizedCode
        }
      });

      return {
        authToken: this.authToken && this.authToken !== previousAuthToken ? this.authToken : null,
        response
      };
    } catch (error) {
      if (error instanceof InvalidOtpError || error.status === 404) {
        throw new InvalidDeviceLinkCodeError(error.message, {
          cause: error,
          status: error.status
        });
      }

      throw error;
    }
  }

  async getSnapshot() {
    await this.ensureSession();

    const systems = await Promise.all(
      this.systemIds.map((systemId) => this._apiRequest('GET', `systems/systems/${systemId}`))
    );

    const snapshot = {
      garageDoors: [],
      gates: [],
      lights: [],
      locks: [],
      partitions: [],
      sensors: [],
      systems: systems.map((system) => system.data),
      thermostats: [],
      usesCelsius: this.usesCelsius,
      waterSensors: []
    };

    const fetchTasks = [];
    const seenResourceIds = new Map();

    for (const systemResponse of systems) {
      const idsByCollection = collectSystemResourceIds(systemResponse.data);

      for (const [bucket, ids] of Object.entries(idsByCollection)) {
        if (!ids.length) {
          continue;
        }

        if (!seenResourceIds.has(bucket)) {
          seenResourceIds.set(bucket, new Set());
        }

        const unseenIds = ids.filter((id) => {
          if (seenResourceIds.get(bucket).has(id)) {
            return false;
          }

          seenResourceIds.get(bucket).add(id);
          return true;
        });

        if (!unseenIds.length) {
          continue;
        }

        fetchTasks.push(
          this._fetchCollection(bucket, unseenIds).then((items) => {
            snapshot[bucket].push(...items);
          })
        );
      }
    }

    await Promise.all(fetchTasks);

    return snapshot;
  }

  async _fetchCollection(bucket, ids) {
    const collectionConfig = Object.values(RESOURCE_COLLECTIONS).find((entry) => entry.bucket === bucket);

    if (!collectionConfig) {
      return [];
    }

    const batches = chunk(ids, 50);
    const results = [];

    for (const batch of batches) {
      try {
        const response = await this._apiRequest('GET', collectionConfig.path, {
          query: buildIdsQuery(batch)
        });

        if (Array.isArray(response.data)) {
          results.push(...response.data);
        } else if (response.data) {
          results.push(response.data);
        }
      } catch (error) {
        if (error instanceof PermissionError || error.status === 404) {
          this.logger.debug(
            `Alarm.com denied access to ${bucket} or the endpoint is unavailable; continuing without those devices.`
          );
          return [];
        }

        throw error;
      }
    }

    return results;
  }

  async armPartition(partitionId, mode, options = {}) {
    const action = mode === 'away' ? 'armAway' : mode === 'night' ? 'armStay' : mode === 'stay' ? 'armStay' : null;

    if (!action) {
      throw new AlarmDotComError(`Unsupported Alarm.com arming mode: ${mode}`);
    }

    const body = {
      forceBypass: normalizeBoolean(options.forceBypass),
      noEntryDelay: normalizeBoolean(options.noEntryDelay),
      silentArming: normalizeBoolean(options.silentArming),
      statePollOnly: false
    };

    if (mode === 'night' || normalizeBoolean(options.nightArming)) {
      body.nightArming = true;
    }

    return this._apiRequest('POST', `devices/partitions/${partitionId}/${action}`, { body });
  }

  async disarmPartition(partitionId) {
    return this._apiRequest('POST', `devices/partitions/${partitionId}/disarm`, {
      body: {
        statePollOnly: false
      }
    });
  }

  async setLightState(lightId, { on, brightness = 100, isDimmer = false }) {
    const action = on ? 'turnOn' : 'turnOff';
    const body = {
      statePollOnly: false
    };

    if (isDimmer) {
      body.dimmerLevel = Math.max(0, Math.min(100, Math.round(Number(brightness) || 0)));
    }

    return this._apiRequest('POST', `devices/lights/${lightId}/${action}`, { body });
  }

  async setLockState(lockId, locked) {
    return this._apiRequest('POST', `devices/locks/${lockId}/${locked ? 'lock' : 'unlock'}`, {
      body: {
        statePollOnly: false
      }
    });
  }

  async setGarageState(deviceId, open, isGate = false) {
    const resourcePath = isGate ? 'devices/gates' : 'devices/garageDoors';

    return this._apiRequest('POST', `${resourcePath}/${deviceId}/${open ? 'open' : 'close'}`, {
      body: {
        statePollOnly: false
      }
    });
  }

  async setThermostatMode(deviceId, desiredState) {
    return this._apiRequest('POST', `devices/thermostats/${deviceId}/setState`, {
      body: {
        desiredState,
        statePollOnly: false
      }
    });
  }

  async setThermostatSetpoint(deviceId, fieldName, value) {
    return this._apiRequest('POST', `devices/thermostats/${deviceId}/setState`, {
      body: {
        [fieldName]: value,
        statePollOnly: false
      }
    });
  }

  async _apiRequest(method, path, { query, body, allowSessionRepair = true } = {}) {
    if (!this._hasActiveSession()) {
      await this.ensureSession();
    }

    const url = new URL(path, API_BASE_URL);
    if (query) {
      url.search = typeof query === 'string' ? query : new URLSearchParams(query).toString();
    }

    try {
      return await this._requestJson(method, url.toString(), {
        includeAjaxKey: true,
        body,
        jsonRequest: true
      });
    } catch (error) {
      if (allowSessionRepair && error instanceof SessionExpiredError) {
        this.logger.info('Alarm.com session expired; retrying after a fresh login.');
        this.sessionExpiresAt = 0;
        await this.login();
        return this._apiRequest(method, path, {
          allowSessionRepair: false,
          body,
          query
        });
      }

      throw error;
    }
  }

  async _requestJson(method, url, options = {}) {
    const response = await this._requestRaw(method, url, options);
    const text = response.text || '';
    const contentType = String(response.headers['content-type'] || '');
    let parsedBody = null;

    if (text) {
      try {
        parsedBody = JSON.parse(text);
      } catch (error) {
        if (contentType.includes('json')) {
          throw new AlarmDotComError(`Alarm.com returned invalid JSON for ${method} ${url}.`, {
            cause: error
          });
        }
      }
    }

    const errorCodes = extractErrorCodes(parsedBody);
    const statusCode = Number(response.statusCode);

    if (statusCode === 302 && String(response.headers.location || '').includes('/login')) {
      throw new SessionExpiredError('Alarm.com redirected the session back to login.', {
        location: response.headers.location,
        status: statusCode
      });
    }

    if (statusCode === 401 || statusCode === 403 || errorCodes.includes(401) || errorCodes.includes(403)) {
      throw new SessionExpiredError(extractErrorMessage(parsedBody, text, statusCode), {
        body: parsedBody,
        status: statusCode
      });
    }

    if (statusCode === 409 || errorCodes.includes(409)) {
      throw new OtpRequiredError({
        raw: parsedBody,
        status: statusCode
      });
    }

    if (statusCode === 422 || errorCodes.includes(422)) {
      throw new InvalidOtpError(extractErrorMessage(parsedBody, text, statusCode), {
        body: parsedBody,
        status: statusCode
      });
    }

    if (statusCode === 406 || statusCode === 423 || errorCodes.includes(406) || errorCodes.includes(423)) {
      throw new PermissionError(extractErrorMessage(parsedBody, text, statusCode), {
        body: parsedBody,
        status: statusCode
      });
    }

    if (statusCode >= 400) {
      throw new AlarmDotComError(extractErrorMessage(parsedBody, text, statusCode), {
        body: parsedBody,
        status: statusCode
      });
    }

    if (parsedBody && Array.isArray(parsedBody.errors) && parsedBody.errors.length) {
      throw new AlarmDotComError(extractErrorMessage(parsedBody, text, statusCode), {
        body: parsedBody,
        status: statusCode
      });
    }

    return parsedBody || {};
  }

  async _requestHtml(method, url, options = {}) {
    const response = await this._requestRaw(method, url, options);

    if (Number(response.statusCode) >= 400) {
      throw new AlarmDotComError(`Alarm.com returned HTTP ${response.statusCode} for ${method} ${url}.`, {
        status: response.statusCode
      });
    }

    return response;
  }

  async _requestRaw(method, urlString, options = {}) {
    const url = new URL(urlString);
    const headers = {
      Connection: 'keep-alive',
      Referer: `${BASE_URL}web/system/home`,
      'User-Agent': this.userAgent,
      ...(options.headers || {})
    };

    const body =
      options.body == null
        ? null
        : options.jsonRequest
          ? JSON.stringify(options.body)
          : String(options.body);

    if (options.jsonRequest) {
      headers.Accept = headers.Accept || 'application/vnd.api+json';
      headers['Content-Type'] = headers['Content-Type'] || 'application/json; charset=UTF-8';
    }

    if (options.includeAjaxKey && this.ajaxKey) {
      headers.ajaxrequestuniquekey = this.ajaxKey;
    }

    const cookieHeader = buildCookieHeader(this.cookieJar, this.authToken, options.extraCookies, options.includeSessionCookies !== false);
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    if (body) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    this.logger.debug(`HTTP ${method} ${url.origin}${url.pathname}${url.search}`);
    const response = await performHttpsRequest(method, url, headers, body, this.timeoutMs);
    this.logger.debug(`HTTP ${method} ${url.origin}${url.pathname}${url.search} -> ${response.statusCode}`);
    this._updateCookies(response.headers['set-cookie']);
    return response;
  }

  _updateCookies(setCookieHeader) {
    const cookieHeaders = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : [];

    for (const cookieHeader of cookieHeaders) {
      const cookiePair = String(cookieHeader).split(';', 1)[0];
      const separatorIndex = cookiePair.indexOf('=');
      if (separatorIndex < 1) {
        continue;
      }

      const name = cookiePair.slice(0, separatorIndex).trim();
      const value = cookiePair.slice(separatorIndex + 1).trim();
      this.cookieJar.set(name, value);

      if (name === 'afg') {
        this.ajaxKey = value;
      }

      if (name === 'twoFactorAuthenticationId') {
        this.authToken = value;
      }
    }
  }

  _extractLoginFields(html) {
    return {
      __EVENTVALIDATION: extractHiddenField(html, '__EVENTVALIDATION'),
      __PREVIOUSPAGE: extractHiddenField(html, '__PREVIOUSPAGE'),
      __VIEWSTATE: extractHiddenField(html, '__VIEWSTATE'),
      __VIEWSTATEGENERATOR: extractHiddenField(html, '__VIEWSTATEGENERATOR')
    };
  }

  _hasActiveSession() {
    return Boolean(this.ajaxKey && Date.now() < this.sessionExpiresAt);
  }
}

function collectSystemResourceIds(systemResource) {
  const idsByCollection = {};

  for (const collection of Object.values(RESOURCE_COLLECTIONS)) {
    idsByCollection[collection.bucket] = [];
  }

  const relationships = (systemResource && systemResource.relationships) || {};

  for (const relationship of Object.values(relationships)) {
    const data = relationship && relationship.data;
    const resources = Array.isArray(data) ? data : data ? [data] : [];

    for (const resource of resources) {
      const collection = resource && RESOURCE_COLLECTIONS[resource.type];
      if (!collection || !resource.id) {
        continue;
      }

      idsByCollection[collection.bucket].push(resource.id);
    }
  }

  for (const bucket of Object.keys(idsByCollection)) {
    idsByCollection[bucket] = [...new Set(idsByCollection[bucket])];
  }

  return idsByCollection;
}

function normalizeOtpMethod(method) {
  const normalized = String(method || '').trim().toLowerCase();

  if (!OTP_METHODS[normalized]) {
    throw new InvalidOtpError(`Unsupported Alarm.com two-factor method: ${method}`);
  }

  return normalized;
}

function buildIdsQuery(ids) {
  const params = new URLSearchParams();
  for (const id of ids) {
    params.append('ids[]', id);
  }
  return params.toString();
}

function chunk(values, size) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function extractHiddenField(html, fieldName) {
  const match = new RegExp(`name="${fieldName}"[^>]*value="([^"]*)"`, 'i').exec(html);
  if (!match) {
    throw new AuthenticationError(`Alarm.com login page did not contain the ${fieldName} field.`);
  }

  return match[1];
}

function buildCookieHeader(cookieJar, authToken, extraCookies, includeSessionCookies) {
  const cookies = new Map();

  if (includeSessionCookies) {
    for (const [key, value] of cookieJar.entries()) {
      cookies.set(key, value);
    }
  }

  if (authToken) {
    cookies.set('twoFactorAuthenticationId', authToken);
  }

  for (const [key, value] of Object.entries(extraCookies || {})) {
    if (value) {
      cookies.set(key, value);
    }
  }

  return [...cookies.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function performHttpsRequest(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const requestLabel = `${method} ${url.origin}${url.pathname}${url.search}`;
    const timeoutHandle = setTimeout(() => {
      request.destroy(new AlarmDotComError(`Alarm.com request timed out after ${timeoutMs}ms for ${requestLabel}.`));
    }, timeoutMs);
    const request = https.request(
      {
        hostname: url.hostname,
        method,
        path: `${url.pathname}${url.search}`,
        port: url.port || 443,
        protocol: url.protocol,
        timeout: timeoutMs
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        response.on('end', () => {
          clearTimeout(timeoutHandle);
          completed = true;
          resolve({
            headers: response.headers,
            statusCode: Number(response.statusCode || 0),
            text: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new AlarmDotComError(`Alarm.com request timed out after ${timeoutMs}ms for ${requestLabel}.`));
    });

    request.on('error', (error) => {
      if (!completed) {
        clearTimeout(timeoutHandle);
      }
      reject(error);
    });

    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null && value !== '') {
        request.setHeader(key, value);
      }
    }

    if (body) {
      request.write(body);
    }

    request.end();
  });
}

function extractErrorCodes(body) {
  if (!body || !Array.isArray(body.errors)) {
    return [];
  }

  return body.errors
    .map((error) => Number(error && error.code))
    .filter((value) => Number.isFinite(value));
}

function extractErrorMessage(body, rawText, statusCode) {
  if (body) {
    if (typeof body.message === 'string' && body.message) {
      return body.message;
    }

    if (typeof body.Message === 'string' && body.Message) {
      return body.Message;
    }

    if (Array.isArray(body.errors) && body.errors.length) {
      const detail = body.errors.find((error) => error && (error.detail || error.title));
      if (detail) {
        return detail.detail || detail.title;
      }
    }
  }

  if (rawText) {
    return rawText;
  }

  return `Alarm.com returned HTTP ${statusCode}.`;
}

module.exports = {
  AlarmDotComClient,
  AlarmDotComError,
  AuthenticationError,
  InvalidDeviceLinkCodeError,
  InvalidOtpError,
  OtpRequiredError,
  OTP_METHODS,
  PermissionError,
  SessionExpiredError
};
