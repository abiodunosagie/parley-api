// The only file that talks to the Anthropic API. Chat, photos, documents and rewriting stream back
// as they are written; extraction, receipts and the agent return one finished response.
import { Anthropic } from '@anthropic-ai/sdk';
import {
  EFFORT,
  MAX_TOKENS,
  type Mode,
  MODELS,
  SERVER_FALLBACK_BETA,
  SHOW_THINKING,
  WEB_SEARCH_MAX_USES,
} from './config.js';
import { SYSTEM_PROMPTS, WEB_SEARCH_PROMPT } from './prompts.js';
import { AGENT_TOOLS } from './schemas.js';
import { ALLOWED_BLOCKS, type ClaudeRequest } from './validate.js';

// The client on the project's key is made once, on first use. A request that carries the user's
// own key gets a client of its own, used for that one request and then dropped; that key is never
// stored or logged.
let projectClient: Anthropic | null = null;

export function clientFor(
  ownKey: string | null,
  projectKey: string | undefined,
): Anthropic {
  if (ownKey) return new Anthropic({ apiKey: ownKey });
  return (projectClient ??= new Anthropic({ apiKey: projectKey }));
}

type ContentBlock = Anthropic.Beta.BetaContentBlock;
/**
 * What one request has spent so far, filled in as the API reports it. the controller logs it even when
 * the app disconnects or the call fails, so an aborted request still counts against the limits.
 * `input` stays null until the API has reported any input.
 */
export class Meter {
  input: number | null = null;
  output = 0;
  searches = 0;

  add(usage: Anthropic.Beta.BetaUsage) {
    this.input = (this.input ?? 0) + usage.input_tokens;
    this.output += usage.output_tokens;
    this.searches += usage.server_tool_use?.web_search_requests ?? 0;
  }
}

// A long search turn can pause; it resumes by sending the paused reply back. Capped so one
// request cannot loop.
const MAX_RESUMES = 2;

// Earlier search blocks replay fine without the tool, so turning search off really stops it.
const usesWebSearch = (req: ClaudeRequest) =>
  req.mode === 'chat' && req.options.webSearch;

// Opus and Sonnet can decline a request through safety classifiers. With server-side fallbacks
// the API re-runs a declined request on Anthropic's recommended model inside the same call.
// Haiku has no server-side fallback, so its refusals reach the app as stop_reason "refusal".
function baseParams(req: ClaudeRequest, searchesLeft = WEB_SEARCH_MAX_USES) {
  const search = usesWebSearch(req) && searchesLeft > 0;
  return {
    model: req.model,
    max_tokens: MAX_TOKENS[req.mode],
    system: SYSTEM_PROMPTS[req.mode] + (search ? WEB_SEARCH_PROMPT : ''),
    messages: req.messages,
    // Summarized reasoning is free to read: billing is the same as when it is hidden.
    ...(SHOW_THINKING.includes(req.mode)
      ? {
          thinking: {
            type: 'adaptive' as const,
            display: 'summarized' as const,
          },
        }
      : {}),
    ...(search
      ? {
          tools: [
            {
              type: 'web_search_20250305' as const,
              name: 'web_search' as const,
              max_uses: searchesLeft,
            },
          ],
        }
      : {}),
    ...(MODELS[req.model].serverFallback
      ? { betas: [SERVER_FALLBACK_BETA], fallbacks: 'default' as const }
      : {}),
  };
}

// Claude's turn as the app stores it for the next request: only the block types this mode
// accepts back, so a stored conversation always passes validation when it continues.
function replayable(mode: Mode, content: ContentBlock[]): ContentBlock[] {
  return content.filter((b) => ALLOWED_BLOCKS[mode].assistant.includes(b.type));
}

/** A source Claude cited, shaped for the app: a web page, or pages of the PDF. */
export type Source =
  | { kind: 'web'; url: string; title: string; cited_text: string }
  | {
      kind: 'page';
      title: string;
      cited_text: string;
      start_page: number;
      end_page: number;
    };

// Server-sent events the app reads line by line. The last one is "done", carrying Claude's whole
// turn (thinking and search results included) so the app can send it back on the next turn.
export type StreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'search'; query: string }
  | { type: 'source'; source: Source }
  | { type: 'done'; stop_reason: string | null; content: ContentBlock[] };

function sourceOf(citation: Anthropic.Beta.BetaTextCitation): Source | null {
  switch (citation.type) {
    case 'web_search_result_location':
      return {
        kind: 'web',
        url: citation.url,
        title: citation.title ?? citation.url,
        cited_text: citation.cited_text,
      };
    case 'page_location':
      return {
        kind: 'page',
        title: citation.document_title ?? 'Document',
        cited_text: citation.cited_text,
        start_page: citation.start_page_number,
        // end_page_number is exclusive in the API; the app shows the last page included.
        end_page: Math.max(
          citation.start_page_number,
          citation.end_page_number - 1,
        ),
      };
    default:
      return null;
  }
}

export async function* streamReply(
  anthropic: Anthropic,
  req: ClaudeRequest,
  signal: AbortSignal,
  meter: Meter,
): AsyncGenerator<StreamEvent> {
  let messages = req.messages;
  const content: ContentBlock[] = [];
  let wroteText = false;

  for (let round = 0; ; round++) {
    const stream = anthropic.beta.messages.stream(
      {
        ...baseParams(
          { ...req, messages },
          WEB_SEARCH_MAX_USES - meter.searches,
        ),
        output_config: { effort: EFFORT[req.mode] },
      },
      { signal },
    );
    // Live figures for this round, so a disconnect mid-reply still has a cost to log.
    const before = {
      input: meter.input ?? 0,
      output: meter.output,
      searches: meter.searches,
    };
    const searchInput = new Map<number, string>();
    let lastType = '';
    // Output is only reported at the end of a round; until then, estimate it from what streamed
    // (about three characters per token), so an abandoned reply still costs something.
    let streamedChars = 0;
    const countStreamed = (chars: number) => {
      streamedChars += chars;
      meter.output = Math.max(
        meter.output,
        before.output + Math.ceil(streamedChars / 3),
      );
    };
    for await (const event of stream) {
      if (event.type === 'message_start') {
        meter.input = before.input + event.message.usage.input_tokens;
      } else if (event.type === 'message_delta') {
        meter.output = before.output + event.usage.output_tokens;
      } else if (event.type === 'content_block_start') {
        const type = event.content_block.type;
        // Text after a search starts a new paragraph; text split by citations runs on.
        if (type === 'text' && wroteText && lastType !== 'text')
          yield { type: 'text', text: '\n\n' };
        if (type === 'server_tool_use') {
          searchInput.set(event.index, '');
          meter.searches++;
        }
        lastType = type;
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          wroteText = true;
          countStreamed(delta.text.length);
          yield { type: 'text', text: delta.text };
        } else if (delta.type === 'thinking_delta') {
          countStreamed(delta.thinking.length);
          yield { type: 'thinking', text: delta.thinking };
        } else if (delta.type === 'citations_delta') {
          const source = sourceOf(delta.citation);
          if (source) yield { type: 'source', source };
        } else if (
          delta.type === 'input_json_delta' &&
          searchInput.has(event.index)
        ) {
          searchInput.set(
            event.index,
            searchInput.get(event.index)! + delta.partial_json,
          );
        }
      } else if (
        event.type === 'content_block_stop' &&
        searchInput.has(event.index)
      ) {
        const query = queryOf(searchInput.get(event.index)!);
        if (query) yield { type: 'search', query };
      }
    }
    const final = await stream.finalMessage();
    // The finished message has the exact figures: replace this round's live ones with them.
    meter.input = before.input;
    meter.output = before.output;
    meter.searches = before.searches;
    meter.add(final.usage);
    content.push(...final.content);
    const searchesLeft = WEB_SEARCH_MAX_USES - meter.searches;
    if (
      final.stop_reason !== 'pause_turn' ||
      round >= MAX_RESUMES ||
      (usesWebSearch(req) && searchesLeft <= 0)
    ) {
      yield {
        type: 'done',
        stop_reason: final.stop_reason,
        content: replayable(req.mode, content),
      };
      return;
    }
    // Resume: send the paused turn back unchanged and let the API continue it.
    messages = [
      ...req.messages,
      {
        role: 'assistant',
        content: content as Anthropic.Beta.BetaContentBlockParam[],
      },
    ];
  }
}

function queryOf(json: string): string | null {
  try {
    const input = JSON.parse(json);
    return typeof input?.query === 'string' ? input.query : null;
  } catch {
    return null;
  }
}

export type StructuredResult = {
  fields: Record<string, unknown> | null;
  stop_reason: string | null;
};

/** One JSON answer in exactly [schema]'s shape. Used by extraction and receipts. */
export async function structured(
  anthropic: Anthropic,
  req: ClaudeRequest,
  schema: Record<string, unknown>,
  signal: AbortSignal,
  meter: Meter,
): Promise<StructuredResult> {
  const response = await anthropic.beta.messages.create(
    {
      ...baseParams(req),
      output_config: {
        effort: EFFORT[req.mode],
        format: { type: 'json_schema', schema },
      },
    },
    { signal },
  );
  meter.add(response.usage);
  const text = response.content.find((b) => b.type === 'text');
  if (response.stop_reason !== 'end_turn' || text?.type !== 'text') {
    return { fields: null, stop_reason: response.stop_reason };
  }
  try {
    return { fields: JSON.parse(text.text), stop_reason: response.stop_reason };
  } catch {
    // Structured output should never produce bad JSON; treat it like a reply with no fields.
    return { fields: null, stop_reason: response.stop_reason };
  }
}

export type AgentResult = {
  // Claude's whole turn, thinking blocks included. The app appends it to the conversation
  // unchanged, runs any tool_use blocks, and sends the results back as the next user turn.
  content: ContentBlock[];
  stop_reason: string | null;
};

export async function agentTurn(
  anthropic: Anthropic,
  req: ClaudeRequest,
  signal: AbortSignal,
  meter: Meter,
): Promise<AgentResult> {
  const response = await anthropic.beta.messages.create(
    {
      ...baseParams(req),
      tools: AGENT_TOOLS,
      output_config: { effort: EFFORT[req.mode] },
    },
    { signal },
  );
  meter.add(response.usage);
  return {
    content: replayable(req.mode, response.content),
    stop_reason: response.stop_reason,
  };
}

/** Input tokens [req] would cost, from the free token-counting endpoint. */
export async function countInputTokens(
  anthropic: Anthropic,
  req: ClaudeRequest,
  signal: AbortSignal,
): Promise<number> {
  const { model, system, messages } = baseParams(req);
  const counted = await anthropic.beta.messages.countTokens(
    { model, system, messages },
    { signal },
  );
  return counted.input_tokens;
}

// The app shows these words as they are, so they never carry internal details. With the user's
// own key, a rejected key or an empty balance is theirs to fix, so it says so. 403 rather than 401:
// the app answers a 401 by refreshing the session and sending again, which would only call Claude
// twice with the same bad key.
export function publicError(
  error: unknown,
  ownKey = false,
): { message: string; status: number } {
  if (
    ownKey &&
    (error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError)
  ) {
    return {
      message: 'Claude did not accept your API key. Check it under Account.',
      status: 403,
    };
  }
  // Matches the wording of Anthropic's low-balance error (pinned in own_key_test.ts). If the wording
  // changes, the user gets the general message below instead.
  if (
    ownKey &&
    error instanceof Anthropic.BadRequestError &&
    /credit balance/i.test(error.message)
  ) {
    return {
      message:
        'Your Claude account is out of credit. Top it up, or remove your key under Account.',
      status: 402,
    };
  }
  if (error instanceof Anthropic.RateLimitError)
    return {
      message: 'Claude is busy right now. Try again in a moment.',
      status: 503,
    };
  if (error instanceof Anthropic.BadRequestError)
    return { message: 'Claude could not take that request.', status: 400 };
  if (error instanceof Anthropic.AuthenticationError)
    return { message: 'The server is not set up yet.', status: 503 };
  if (error instanceof Anthropic.APIConnectionError)
    return { message: 'Could not reach Claude. Try again.', status: 502 };
  return { message: 'Something went wrong. Try again.', status: 502 };
}
