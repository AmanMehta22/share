import { describe, it, expect } from 'vitest';
import { resolveConfig, DEFAULTS, ConfigError } from '../src/config/env.js';

/**
 * Config parsing tests for the values that gate scale:
 *   MAX_RECEIVERS (one-to-many capacity, now up to 100) and
 *   MAX_SIGNALS_PER_MINUTE (signaling headroom for 100 negotiations).
 */

const base = { loadFile: false };

describe('resolveConfig scale defaults', () => {
  it('defaults to 100 receivers per session and 3000 signals per minute', () => {
    const config = resolveConfig({}, base);
    expect(config.maxReceivers).toBe(100);
    expect(config.maxSignalsPerMinute).toBe(3000);
    expect(DEFAULTS.MAX_RECEIVERS).toBe('100');
    expect(DEFAULTS.MAX_SIGNALS_PER_MINUTE).toBe('3000');
  });

  it('accepts MAX_RECEIVERS up to 100 and rejects beyond', () => {
    expect(resolveConfig({ MAX_RECEIVERS: '100' }, base).maxReceivers).toBe(100);
    expect(resolveConfig({ MAX_RECEIVERS: '1' }, base).maxReceivers).toBe(1);
    expect(() => resolveConfig({ MAX_RECEIVERS: '101' }, base)).toThrow(ConfigError);
    expect(() => resolveConfig({ MAX_RECEIVERS: '0' }, base)).toThrow(ConfigError);
    expect(() => resolveConfig({ MAX_RECEIVERS: 'lots' }, base)).toThrow(ConfigError);
  });

  it('honours an overridden MAX_SIGNALS_PER_MINUTE within bounds', () => {
    expect(resolveConfig({ MAX_SIGNALS_PER_MINUTE: '600' }, base).maxSignalsPerMinute).toBe(600);
    expect(() => resolveConfig({ MAX_SIGNALS_PER_MINUTE: '5' }, base)).toThrow(ConfigError);
  });
});
