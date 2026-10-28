import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Configuration for the CodeShare signaling server.
 *
 * Values are validated at startup so misconfiguration fails fast with a clear
 * message. No secrets are stored here and none are ever echoed back.
 */

export const DEFAULTS = Object.freeze({
  PORT: '4000',
  CLIENT_ORIGIN: 'http://localhost:5173',
  NODE_ENV: 'development',
  SESSION_TTL_MINUTES: '15',
  MAX_JOIN_ATTEMPTS: '5',
  MAX_SESSIONS_PER_IP: '10',
  MAX_SIGNALS_PER_MINUTE: '600',
  TRUST_PROXY: '0',
  SERVE_CLIENT: '1',
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Minimal .env parser (key=value, # comments, optional quotes). No dependency needed. */
export function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function parseInt10(raw, name, { min, max }) {
  const value = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(
      `${name} must be an integer between ${min} and ${max} (received "${String(raw).slice(0, 32)}").`
    );
  }
  return value;
}

function parseBool(raw, name) {
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(value)) return false;
  throw new ConfigError(`${name} must be 0 or 1 (received "${String(raw).slice(0, 32)}").`);
}

function parseOrigins(raw) {
  const list = String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (list.length === 0) {
    throw new ConfigError('CLIENT_ORIGIN must contain at least one origin, e.g. http://localhost:5173');
  }
  for (const origin of list) {
    if (origin === '*') continue;
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new ConfigError(`CLIENT_ORIGIN contains an invalid origin: "${origin}".`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConfigError(`CLIENT_ORIGIN entry must be http(s): "${origin}".`);
    }
  }
  return list;
}

/**
 * Build a validated, frozen config object from an environment map.
 * Pure function so tests can pass plain objects.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ cwd?: string, loadFile?: boolean }} [options]
 */
export function resolveConfig(env = process.env, options = {}) {
  const { cwd = process.cwd(), loadFile = true } = options;
  const fileEnv = loadFile ? loadEnvFile(join(cwd, '.env')) : {};

  const pick = (key) => {
    const fromProcess = env[key];
    if (fromProcess !== undefined && fromProcess !== '') return String(fromProcess);
    const fromFile = fileEnv[key];
    if (fromFile !== undefined && fromFile !== '') return fromFile;
    return DEFAULTS[key];
  };

  const nodeEnv = pick('NODE_ENV').trim() || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new ConfigError('NODE_ENV must be one of: development, test, production.');
  }

  const config = {
    port: parseInt10(pick('PORT'), 'PORT', { min: 1, max: 65535 }),
    nodeEnv,
    clientOrigins: parseOrigins(pick('CLIENT_ORIGIN')),
    sessionTtlMs: parseInt10(pick('SESSION_TTL_MINUTES'), 'SESSION_TTL_MINUTES', { min: 1, max: 1440 }) * 60_000,
    maxJoinAttempts: parseInt10(pick('MAX_JOIN_ATTEMPTS'), 'MAX_JOIN_ATTEMPTS', { min: 1, max: 1000 }),
    maxSessionsPerIp: parseInt10(pick('MAX_SESSIONS_PER_IP'), 'MAX_SESSIONS_PER_IP', { min: 1, max: 1000 }),
    maxSignalsPerMinute: parseInt10(pick('MAX_SIGNALS_PER_MINUTE'), 'MAX_SIGNALS_PER_MINUTE', {
      min: 10,
      max: 100_000,
    }),
    trustProxy: parseBool(pick('TRUST_PROXY'), 'TRUST_PROXY'),
    serveClient: parseBool(pick('SERVE_CLIENT'), 'SERVE_CLIENT'),
    isProduction: nodeEnv === 'production',
  };

  return Object.freeze(config);
}
