import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/agentdrop',
  AUTH_SECRET: 'x'.repeat(40),
};

describe('loadConfig', () => {
  it('accepts a minimal development config', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.STORAGE_PROVIDER).toBe('fs');
    expect(cfg.DEV_AUTH).toBe(false);
    // group file space (ADR 0029): 512 MiB unless configured
    expect(cfg.GROUP_STORAGE_QUOTA_BYTES).toBe(536_870_912);
    expect(loadConfig({ ...base, GROUP_STORAGE_QUOTA_BYTES: '1048576' }).GROUP_STORAGE_QUOTA_BYTES).toBe(
      1_048_576,
    );
  });

  it('refuses production with DEV_AUTH enabled', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        DEV_AUTH: 'true',
        STORAGE_PROVIDER: 's3',
        S3_BUCKET: 'b',
        S3_REGION: 'r',
        PUBLIC_BASE_URL: 'https://drop.example.com',
      }),
    ).toThrow(ConfigError);
  });

  it('refuses production with the filesystem storage provider', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://drop.example.com' }),
    ).toThrow(/s3 storage provider/);
  });

  it('refuses production with a short or placeholder secret and never echoes the value', () => {
    let message = '';
    try {
      loadConfig({
        ...base,
        AUTH_SECRET: 'GENERATE_SECURE_RANDOM_VALUE',
        NODE_ENV: 'production',
        STORAGE_PROVIDER: 's3',
        S3_BUCKET: 'b',
        S3_REGION: 'r',
        PUBLIC_BASE_URL: 'https://drop.example.com',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/AUTH_SECRET/);
    expect(message).not.toMatch(/GENERATE_SECURE_RANDOM_VALUE/);
  });

  const prodBase = {
    NODE_ENV: 'production',
    STORAGE_PROVIDER: 's3',
    S3_BUCKET: 'b',
    S3_REGION: 'r',
    PUBLIC_BASE_URL: 'https://drop.example.com',
  };

  it.each([
    'local-only-secret-change-me-0123456789abcdef',
    'please-changeme-please-changeme-please-changeme',
    'CHANGE_ME_CHANGE_ME_CHANGE_ME_CHANGE_ME_00',
    'REPLACE_WITH_A_LONG_RANDOM_VALUE_0123456789',
    'placeholder-placeholder-placeholder-placeholder',
  ])('refuses the placeholder secret %s in production and development, never echoing it', (secret) => {
    for (const env of [{ ...base, ...prodBase }, { ...base }, { ...base, NODE_ENV: 'development' }]) {
      let message = '';
      try {
        loadConfig({ ...env, AUTH_SECRET: secret });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/AUTH_SECRET: AUTH_SECRET still holds a placeholder value/);
      expect(message).not.toContain(secret);
    }
  });

  it('lets unit tests use a placeholder secret', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'test', AUTH_SECRET: 'local-only-secret-change-me' });
    expect(cfg.NODE_ENV).toBe('test');
  });

  it('keeps the length rule for production only', () => {
    expect(() => loadConfig({ ...base, ...prodBase, AUTH_SECRET: 'short-but-random-9f3a' })).toThrow(
      /at least 32 characters/,
    );
    expect(loadConfig({ ...base, AUTH_SECRET: 'short-but-random-9f3a' }).NODE_ENV).toBe('development');
  });

  it('accepts a complete production config', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'production',
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: 'b',
      S3_REGION: 'r',
      PUBLIC_BASE_URL: 'https://drop.example.com',
    });
    expect(cfg.NODE_ENV).toBe('production');
  });

  it('allows push to be disabled or configured with only the public browser key', () => {
    expect(loadConfig({ ...base }).WEB_PUSH_VAPID_PUBLIC_KEY).toBeUndefined();
    const cfg = loadConfig({ ...base, WEB_PUSH_VAPID_PUBLIC_KEY: 'public-key' });
    expect(cfg.WEB_PUSH_VAPID_PUBLIC_KEY).toBe('public-key');
    expect(cfg).not.toHaveProperty('WEB_PUSH_VAPID_PRIVATE_KEY');
    expect(cfg).not.toHaveProperty('WEB_PUSH_VAPID_SUBJECT');
  });
});
