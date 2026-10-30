// Everything the server reads from its environment, checked once at boot. A missing secret stops
// the app from starting instead of failing on the first request.
import { LIMITS } from '../claude/config.js';

export type Env = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  // Optional: without it only requests that bring the user's own key are served.
  anthropicApiKey: string | undefined;
  // The header the host sets with the caller's IP and does not let the caller fake.
  trustedIpHeader: string;
  // Largest request body accepted. Hosts with a smaller platform cap (Vercel: 4.5 MB) set this
  // lower so the app gets Parley's own message instead of the host's error page.
  maxBodyBytes: number;
};

export const ENV = Symbol('ENV');

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const required = (name: string): string => {
    const value = source[name]?.trim();
    if (!value) throw new Error(`Missing environment variable ${name}`);
    return value;
  };

  const maxBodyBytes = source.MAX_BODY_BYTES
    ? Number(source.MAX_BODY_BYTES)
    : LIMITS.maxBodyBytes;
  if (
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes <= 0 ||
    maxBodyBytes > LIMITS.maxBodyBytes
  ) {
    throw new Error(
      `MAX_BODY_BYTES must be a whole number from 1 to ${LIMITS.maxBodyBytes}`,
    );
  }

  const supabaseUrl = required('SUPABASE_URL');
  if (
    !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl) &&
    !supabaseUrl.startsWith('http://127.0.0.1')
  ) {
    throw new Error('SUPABASE_URL must look like https://<ref>.supabase.co');
  }

  return Object.freeze({
    supabaseUrl,
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    anthropicApiKey: source.ANTHROPIC_API_KEY?.trim() || undefined,
    trustedIpHeader: (
      source.TRUSTED_IP_HEADER?.trim() || 'x-vercel-forwarded-for'
    ).toLowerCase(),
    maxBodyBytes,
  });
}
