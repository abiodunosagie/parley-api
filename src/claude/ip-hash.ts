import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

// The network a request came from, hashed so no raw IP address is ever stored. Only the header the
// host itself sets is trusted (Vercel overwrites x-vercel-forwarded-for, so a caller cannot fake
// it); a plain X-Forwarded-For could be. Without that header the request shares one "unknown"
// bucket, so a missing header limits harder instead of not at all. The salt and the hash match the
// edge function exactly, so both backends count the same network in the same bucket.
export function ipHash(
  headers: IncomingHttpHeaders,
  trustedHeader: string,
  supabaseUrl: string,
): string {
  const raw = headers[trustedHeader];
  const ip = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
  if (!ip)
    console.warn(
      `request without ${trustedHeader}; using the shared unknown bucket`,
    );
  return createHash('sha256')
    .update(`${supabaseUrl}|${ip || 'unknown'}`)
    .digest()
    .subarray(0, 16)
    .toString('hex');
}
