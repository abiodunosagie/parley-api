import { loadEnv } from './env.js';

const base = {
  SUPABASE_URL: 'https://abcd.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test',
};

describe('loadEnv', () => {
  it('reads a minimal environment with safe defaults', () => {
    expect(loadEnv(base)).toEqual({
      port: 3000,
      supabaseUrl: 'https://abcd.supabase.co',
      supabaseServiceRoleKey: 'service-role-test',
      anthropicApiKey: undefined,
      trustedIpHeader: 'x-vercel-forwarded-for',
      maxBodyBytes: 16_000_000,
    });
  });

  it('stays under the Vercel body cap when running on Vercel', () => {
    expect(loadEnv({ ...base, VERCEL: '1' }).maxBodyBytes).toBe(4_400_000);
    expect(
      loadEnv({ ...base, VERCEL: '1', MAX_BODY_BYTES: '1000' }).maxBodyBytes,
    ).toBe(1000);
  });

  it('refuses a missing secret at boot', () => {
    expect(() => loadEnv({ SUPABASE_URL: base.SUPABASE_URL })).toThrow(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
  });

  it('accepts only a Supabase URL or a local one, nothing that merely starts like it', () => {
    expect(
      loadEnv({ ...base, SUPABASE_URL: 'http://127.0.0.1:54321' }).supabaseUrl,
    ).toBe('http://127.0.0.1:54321');
    for (const url of [
      'https://abcd.supabase.co/',
      'http://127.0.0.1.evil.com',
      'https://evil.com',
    ]) {
      expect(() => loadEnv({ ...base, SUPABASE_URL: url }), url).toThrow(
        'SUPABASE_URL',
      );
    }
  });

  it('refuses body limits outside the allowed range', () => {
    for (const value of ['0', '-1', '1.5', 'abc', '16000001']) {
      expect(() => loadEnv({ ...base, MAX_BODY_BYTES: value }), value).toThrow(
        'MAX_BODY_BYTES',
      );
    }
  });
});
