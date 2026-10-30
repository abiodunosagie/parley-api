// The steps between a signed-in request and the Claude call: a server key to fall back on, a valid
// body, the search budget, the rate limits, then the document cap. Nothing here writes to the HTTP
// response; the controller does that.
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { ENV, type Env } from '../config/env.js';
import {
  agentTurn,
  type AnthropicClient,
  clientFor,
  countInputTokens,
  type Meter,
  structured,
} from './anthropic.js';
import { LIMITS, OWN_KEY_PATTERN } from './config.js';
import { fail } from './http-error.js';
import { ipHash } from './ip-hash.js';
import { JOB_POST_SCHEMA, RECEIPT_SCHEMA } from './schemas.js';
import { SupabaseService } from './supabase.service.js';
import { type ClaudeRequest, validateRequest } from './validate.js';

/** A request that passed every check and holds a logged slot. */
export type Admitted = {
  req: ClaudeRequest;
  // The user's own key for this one request, or null on the project's key. Never stored or logged.
  ownKey: string | null;
  logId: number;
  anthropic: AnthropicClient;
};

@Injectable()
export class ClaudeService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly supabase: SupabaseService,
  ) {}

  /** Runs every check that comes before Claude is called, and claims a slot. */
  async admit(
    userId: string,
    headers: IncomingHttpHeaders,
    body: unknown,
    ownKey: string | null,
  ): Promise<Admitted> {
    if (!ownKey && !this.env.anthropicApiKey) {
      fail(HttpStatus.SERVICE_UNAVAILABLE, 'The server is not set up yet.');
    }
    const checked = validateRequest(body);
    if (!checked.ok) fail(HttpStatus.BAD_REQUEST, checked.error);
    const req = checked.value;

    // Checked before the slot is claimed, so a refused search does not use up a request.
    if (req.options.webSearch && !ownKey)
      await this.supabase.checkSearchBudget(userId);
    const network = ipHash(
      headers,
      this.env.trustedIpHeader,
      this.env.supabaseUrl,
    );
    const logId = await this.supabase.claimSlot(
      userId,
      network,
      req,
      ownKey !== null,
    );
    return {
      req,
      ownKey,
      logId,
      anthropic: clientFor(ownKey, this.env.anthropicApiKey),
    };
  }

  /**
   * The document cap protects the shared budget; on the user's own key the API's own limits apply.
   * Runs after the slot is claimed so token counting cannot be used for free; a refused document
   * keeps its row with no tokens, which counts as a request and costs nothing.
   */
  async checkDocumentSize(
    { req, ownKey, anthropic }: Admitted,
    signal: AbortSignal,
  ): Promise<void> {
    if (req.mode !== 'document' || ownKey) return;
    const tokens = await countInputTokens(anthropic, req, signal);
    if (tokens > LIMITS.maxDocumentInputTokens) {
      fail(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'That document is too long for Parley. Try a shorter PDF, about 25 pages.',
      );
    }
  }

  /** One finished JSON answer: extraction, receipts and the agent's next turn. */
  answer({ req, anthropic }: Admitted, signal: AbortSignal, meter: Meter) {
    if (req.mode === 'extract')
      return structured(anthropic, req, JOB_POST_SCHEMA, signal, meter);
    if (req.mode === 'receipt')
      return structured(anthropic, req, RECEIPT_SCHEMA, signal, meter);
    return agentTurn(anthropic, req, signal, meter);
  }

  logUsage({ logId, req }: Admitted, meter: Meter): Promise<void> {
    return this.supabase.logUsage(logId, meter, req);
  }
}

/**
 * The user's own key from the body, or null when the request uses the project's key. A key that is
 * present but not shaped like an Anthropic key is refused rather than ignored, so a typo never
 * quietly spends the shared budget. validateRequest never copies api_key into the request it
 * builds, so the key cannot reach Claude or the logs by that path.
 */
export function readOwnKey(body: unknown): string | null {
  const value = (body as { api_key?: unknown } | null)?.api_key;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !OWN_KEY_PATTERN.test(value)) {
    fail(
      HttpStatus.BAD_REQUEST,
      'That API key does not look like a Claude key. Check it under Account.',
    );
  }
  return value;
}
