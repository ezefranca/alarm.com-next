#!/usr/bin/env node
'use strict';

const os = require('node:os');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const {
  AlarmDotComClient,
  AuthenticationError,
  InvalidDeviceLinkCodeError,
  OtpRequiredError,
  OTP_METHODS
} = require('../lib/alarmdotcom-client');
const { TokenStore, getDefaultTokenPath } = require('../lib/token-store');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tokenPath = args['token-file'] || getDefaultTokenPath();
  const store = new TokenStore(tokenPath);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const logger = createCliLogger({ verbose: Boolean(args.debug || args.verbose) });

  try {
    const username = args.username || await ask(rl, 'Alarm.com username');
    const password = args.password || await ask(rl, 'Alarm.com password');
    const deviceLinkCode = normalizeOptionalValue(args['device-link-code']);
    const importedAuthToken = normalizeOptionalValue(args['auth-token']);
    const deviceName = args['device-name'] || `Homebridge (${os.hostname()})`;
    const storedToken = await store.getToken(username);
    const client = new AlarmDotComClient({
      authToken: importedAuthToken || storedToken,
      logger,
      password,
      username
    });
    let usedOtpEnrollment = false;

    stdout.write(`${describePrimaryAction({ deviceLinkCode, importedAuthToken })}...\n`);

    try {
      await client.login();
    } catch (error) {
      if (importedAuthToken) {
        throw error;
      }

      if (!(error instanceof OtpRequiredError)) {
        throw error;
      }

      usedOtpEnrollment = true;
      stdout.write('Alarm.com requires two-factor verification for this Homebridge instance.\n');

      const method = normalizeMethod(
        args.method ||
          (await promptForMethod(rl, error.enabledMethods && error.enabledMethods.length ? error.enabledMethods : Object.keys(OTP_METHODS)))
      );

      if (method !== 'app') {
        stdout.write(`Requesting a one-time code via ${method}...\n`);
        await client.requestOtp(method);
        stdout.write(`Alarm.com sent a one-time code via ${method}.\n`);
      } else {
        stdout.write('Using the authenticator-app code flow.\n');
      }

      const code = args.code || await ask(rl, 'One-time code');
      stdout.write('Verifying the one-time code and enrolling a reusable auth token...\n');
      await client.completeAuthTokenEnrollment({
        code,
        deviceName,
        method
      });
    }

    if (deviceLinkCode) {
      stdout.write('Approving the linked-device activation code...\n');
      const result = await client.approveDeviceLinkRequest(deviceLinkCode);

      if (result.authToken) {
        await persistClientToken(store, {
          client,
          deviceName,
          source: 'device-link',
          username
        });
        stdout.write(`Alarm.com approved the linked-device request and returned a reusable auth token.\nSaved token at ${tokenPath}\n`);
        return;
      }

      if (usedOtpEnrollment || importedAuthToken || client.authToken) {
        await persistClientToken(store, {
          client,
          deviceName,
          source: usedOtpEnrollment ? 'two-factor' : importedAuthToken ? 'manual' : 'login',
          username
        });
      }

      stdout.write('Alarm.com approved the linked-device request.\n');
      stdout.write('No new Homebridge auth token was returned to this session.\n');

      if (hasPrintableResponse(result.response)) {
        stdout.write(`${JSON.stringify(result.response, null, 2)}\n`);
      }

      return;
    }

    if (client.authToken) {
      await persistClientToken(store, {
        client,
        deviceName,
        source: usedOtpEnrollment ? 'two-factor' : importedAuthToken ? 'manual' : 'login',
        username
      });

      if (usedOtpEnrollment) {
        stdout.write(`Alarm.com auth-token enrollment complete.\nSaved token at ${tokenPath}\n`);
      } else if (importedAuthToken) {
        stdout.write(`Alarm.com auth token is valid.\nSaved at ${tokenPath}\n`);
      } else {
        stdout.write(`Alarm.com auth token is already valid.\nSaved at ${tokenPath}\n`);
      }

      return;
    }

    stdout.write('Alarm.com login succeeded and this account did not require a stored auth token.\n');
  } finally {
    rl.close();
  }
}

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (!current.startsWith('--')) {
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

async function ask(rl, label) {
  const value = await rl.question(`${label}: `);
  if (!String(value).trim()) {
    throw new Error(`${label} is required.`);
  }
  return String(value).trim();
}

async function promptForMethod(rl, methods) {
  stdout.write(`Available Alarm.com two-factor methods: ${methods.join(', ')}\n`);
  return ask(rl, 'Method');
}

function normalizeMethod(value) {
  const normalized = String(value || '').trim().toLowerCase();

  if (!(normalized in OTP_METHODS)) {
    throw new Error(`Unsupported two-factor method: ${value}`);
  }

  return normalized;
}

function normalizeOptionalValue(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

async function persistClientToken(store, { client, username, deviceName, source }) {
  if (!client || !client.authToken) {
    return;
  }

  await store.saveToken({
    deviceName,
    source,
    token: client.authToken,
    username
  });
}

function hasPrintableResponse(response) {
  return Boolean(response && typeof response === 'object' && Object.keys(response).length);
}

main().catch((error) => {
  if (isNetworkError(error)) {
    stderrWrite(`Network request to Alarm.com failed: ${error.message}\n`);
    process.exitCode = 4;
    return;
  }

  if (error instanceof AuthenticationError) {
    stderrWrite(`Authentication failed: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (error instanceof InvalidDeviceLinkCodeError) {
    stderrWrite(`Device-link approval failed: ${error.message}\n`);
    process.exitCode = 3;
    return;
  }

  stderrWrite(`${error.message}\n`);
  process.exitCode = 1;
});

function stderrWrite(message) {
  process.stderr.write(message);
}

function createCliLogger({ verbose }) {
  if (!verbose) {
    return {};
  }

  return {
    debug(message) {
      stderrWrite(`[debug] ${message}\n`);
    },
    info(message) {
      stderrWrite(`[info] ${message}\n`);
    },
    warn(message) {
      stderrWrite(`[warn] ${message}\n`);
    },
    error(message) {
      stderrWrite(`[error] ${message}\n`);
    }
  };
}

function describePrimaryAction({ deviceLinkCode, importedAuthToken }) {
  if (deviceLinkCode) {
    return 'Logging in to Alarm.com before approving the linked-device code';
  }

  if (importedAuthToken) {
    return 'Validating the supplied Alarm.com auth token';
  }

  return 'Logging in to Alarm.com';
}

function isNetworkError(error) {
  const code = String(error && error.code ? error.code : '');
  return (
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    /timed out/i.test(String(error && error.message ? error.message : ''))
  );
}
