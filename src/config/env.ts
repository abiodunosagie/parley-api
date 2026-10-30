// Everything the server reads from its environment, checked once at boot. A missing secret stops
// the app from starting instead of failing on the first request.
// LIMITS lives with the Claude feature because the edge function keeps it there too; this file
// only reads its body-size ceiling.
import { LIMITS } from '../claude/config.js';

export type Env = {
  port: number;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  // Optional: without it only requests that bring the user's own key are served.
  anthropicApiKey: string | undefined;
  // The header the host sets with the caller's IP and does not let the caller fake.
  trustedIpHeader: string;
  // Largest request body accepted.
  maxBodyBytes: number;
};

export const ENV = Symbol('ENV');

// Vercel refuses bodies over 4.5 MB before the app sees them; staying just under means the app
// gets Parley's own "too large" message instead of the host's error page.
const VERCEL_MAX_BODY_BYTES = 4_400_000;

const SUPABASE_URL = /^https:\/\/[a-z0-9-]+\.supabase\.co$/;
const LOCAL_SUPABASE_URL = /^http:\/\/127\.0\.0\.1(:\d+)?$/;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const required = (name: string): string => {
    const value = source[name]?.trim();
    if (!value) throw new Error(`Missing environment variable ${name}`);
    return value;
  };

  const defaultBody = source.VERCEL
    ? VERCEL_MAX_BODY_BYTES
    : LIMITS.maxBodyBytes;
  const maxBodyBytes = source.MAX_BODY_BYTES?.trim()
    ? Number(source.MAX_BODY_BYTES)
    : defaultBody;
  if (
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes <= 0 ||
    maxBodyBytes > LIMITS.maxBodyBytes
  ) {
    throw new Error(
      `MAX_BODY_BYTES must be a whole number from 1 to ${LIMITS.maxBodyBytes}`,
    );
  }

  const port = source.PORT?.trim() ? Number(source.PORT) : 3000;
  if (!Number.isInteger(port) || port <= 0 || port > 65535)
    throw new Error('PORT must be a port number');

  const supabaseUrl = required('SUPABASE_URL');
  if (
    !SUPABASE_URL.test(supabaseUrl) &&
    !LOCAL_SUPABASE_URL.test(supabaseUrl)
  ) {
    throw new Error('SUPABASE_URL must look like https://<ref>.supabase.co');
  }

  return Object.freeze({
    port,
    supabaseUrl,
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    anthropicApiKey: source.ANTHROPIC_API_KEY?.trim() || undefined,
    trustedIpHeader: (
      source.TRUSTED_IP_HEADER?.trim() || 'x-vercel-forwarded-for'
    ).toLowerCase(),
    maxBodyBytes,
  });
}
