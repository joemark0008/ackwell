import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';

const base = { DATABASE_URL: 'postgres://x', BETTER_AUTH_SECRET: 's'.repeat(32) };

describe('env', () => {
  it('treats empty seed variables as unset (compose passes "" when the Coolify var is removed)', () => {
    const env = loadEnv({ ...base, SEED_ADMIN_EMAIL: '', SEED_ADMIN_PASSWORD: '' });
    expect(env.SEED_ADMIN_EMAIL).toBeUndefined();
    expect(env.SEED_ADMIN_PASSWORD).toBeUndefined();
  });

  it('still validates seed variables when set', () => {
    expect(() => loadEnv({ ...base, SEED_ADMIN_EMAIL: 'nope', SEED_ADMIN_PASSWORD: 'short' })).toThrow(/SEED_ADMIN/);
    expect(loadEnv({ ...base, SEED_ADMIN_EMAIL: 'a@b.co', SEED_ADMIN_PASSWORD: 'long-enough-pass' }).SEED_ADMIN_EMAIL).toBe('a@b.co');
  });
});
