// Every database call the API makes, through the service-role client. The same Supabase project and
// the same `claude_requests` table as Parley's edge function, so both backends share one set of
// limits: a user cannot double their budget by switching between them.
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ENV, type Env } from '../config/env.js';
import type { Meter } from './anthropic.js';
import { LIMITS, MAX_TOKENS } from './config.js';
import { fail } from './http-error.js';
import { estimateInputTokens } from './usage.js';
import type { ClaudeRequest } from './validate.js';

const REFUSALS: Record<string, string> = {
  user_minute: 'Slow down a little. Try again in a minute.',
  user_day: "You reached today's limit. Come back tomorrow.",
  user_tokens: "You reached today's limit. Come back tomorrow.",
  ip_day: "This network reached today's limit. Try again tomorrow.",
  project_day: 'Parley reached its daily limit. Try again tomorrow.',
};

@Injectable()
export class SupabaseService {
  private readonly admin: SupabaseClient;

  constructor(@Inject(ENV) env: Env) {
    this.admin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  /** The signed-in user's id for a Supabase access token, or a 401 with words the app shows. */
  async userIdFromToken(token: string): Promise<string> {
    const { data, error } = await this.admin.auth.getUser(token);
    if (error || !data.user)
      fail(HttpStatus.UNAUTHORIZED, 'Your session ended. Sign in again.');
    return data.user.id;
  }

  // Checks every limit and records the request in one locked database step, so a burst of
  // parallel requests cannot slip past a count. Fails closed: no slot, no Claude call.
  // On the user's own key only the per-minute limit and a generous daily count of own-key requests
  // apply, and the row is marked so it never counts against the shared daily budgets.
  async claimSlot(
    userId: string,
    ipHash: string,
    req: ClaudeRequest,
    ownKey: boolean,
  ): Promise<number> {
    const { data, error } = await this.admin.rpc('claim_claude_request', {
      p_user: userId,
      p_ip_hash: ipHash,
      p_mode: req.mode,
      p_model: req.model,
      p_user_per_minute: LIMITS.perUserPerMinute,
      p_user_per_day: ownKey
        ? LIMITS.ownKeyPerUserPerDay
        : LIMITS.perUserPerDay,
      p_ip_per_day: LIMITS.perIpPerDay,
      p_project_per_day: LIMITS.projectPerDay,
      p_user_tokens_per_day: LIMITS.userTokensPerDay,
      p_project_tokens_per_day: LIMITS.projectTokensPerDay,
      p_own_key: ownKey,
    });
    if (error) {
      console.error('rate limit check failed', error.message);
      fail(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Parley is busy. Try again in a moment.',
      );
    }
    const row = (
      data as { request_id: number | null; refusal: string | null }[] | null
    )?.[0];
    if (!row?.request_id)
      fail(
        HttpStatus.TOO_MANY_REQUESTS,
        REFUSALS[row?.refusal ?? ''] ?? REFUSALS.project_day,
      );
    return row.request_id;
  }

  // Searches are billed apart from tokens, so each user has a daily number of them.
  async checkSearchBudget(userId: string): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await this.admin
      .from('claude_requests')
      .select('web_searches')
      .eq('user_id', userId)
      .eq('own_key', false)
      .gt('web_searches', 0)
      .gt('created_at', since);
    if (error) {
      console.error('search budget check failed', error.message);
      fail(
        HttpStatus.SERVICE_UNAVAILABLE,
        'Parley is busy. Try again in a moment.',
      );
    }
    const used = (data ?? []).reduce(
      (sum, row) => sum + (row.web_searches as number),
      0,
    );
    if (used >= LIMITS.webSearchesPerUserPerDay) {
      fail(
        HttpStatus.TOO_MANY_REQUESTS,
        "You reached today's web search limit. Turn web search off or come back tomorrow.",
      );
    }
  }

  // Logs what the request spent. When the API never reported a figure (the call failed or the app
  // left early) a cautious estimate stands in, so aborting a request never makes it free.
  async logUsage(
    logId: number,
    meter: Meter,
    req: ClaudeRequest,
  ): Promise<void> {
    const { error } = await this.admin
      .from('claude_requests')
      .update({
        input_tokens: meter.input ?? estimateInputTokens(req),
        output_tokens:
          meter.input === null ? MAX_TOKENS[req.mode] : meter.output,
        web_searches: meter.searches,
      })
      .eq('id', logId);
    if (error) console.error('usage update failed', error.message);
  }
}
