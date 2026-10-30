import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

const logger = new Logger('IpHash');
let warned = false;

// The network a request came from, hashed so no raw IP address is ever stored. Only the header the
// host itself sets is trusted (Vercel overwrites x-vercel-forwarded-for, so a caller cannot fake
// it); on any other host, TRUSTED_IP_HEADER must name a header that host's proxy overwrites.
// Without the header the request shares one "unknown" bucket, so a missing header limits harder
// instead of not at all. The salt and the hash match the edge function exactly, so both backends
// count the same network in the same bucket.
export function ipHash(
  headers: IncomingHttpHeaders,
  trustedHeader: string,
  supabaseUrl: string,
): string {
  const raw = headers[trustedHeader];
  const ip = (Array.isArray(raw) ? raw[0] : raw)?.split(',')[0]?.trim();
  if (!ip && !warned) {
    warned = true;
    logger.warn(
      `requests arrive without ${trustedHeader}; they share the "unknown" network bucket`,
    );
  }
  return createHash('sha256')
    .update(`${supabaseUrl}|${ip || 'unknown'}`)
    .digest()
    .subarray(0, 16)
    .toString('hex');
}
