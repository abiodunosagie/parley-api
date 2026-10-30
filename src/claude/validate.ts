// Checks every request body before anything reaches Claude. The app is open source, so the
// server treats every field as untrusted: allowed models only, allowed block types per mode, hard
// size caps, and every block rebuilt from known fields so nothing extra rides along to the API.
// Pure functions, covered by validate.spec.ts.
import type Anthropic from '@anthropic-ai/sdk';
import { LIMITS, MODELS, MODES, type Mode, type ModelId } from './config.js';
import { AGENT_TOOLS } from './schemas.js';
import { parseCitation, parseSearchResult } from './validate-replay.js';
import { type Budget, Invalid, isObject, text } from './validate-shared.js';

type Message = Anthropic.Beta.BetaMessageParam;
type Block = Anthropic.Beta.BetaContentBlockParam;

export type RequestOptions = { webSearch: boolean };
export type ClaudeRequest = {
  mode: Mode;
  model: ModelId;
  messages: Message[];
  options: RequestOptions;
};
export type Validation =
  { ok: true; value: ClaudeRequest } | { ok: false; error: string };

const IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

// Claude's own reasoning, returned unchanged on later turns.
const THINKING = ['thinking', 'redacted_thinking'];

// Which content block types each mode may carry, per role. Assistant turns are Claude's earlier
// replies, sent back so the conversation continues; web search replies include the searches.
export const ALLOWED_BLOCKS: Record<
  Mode,
  { user: string[]; assistant: string[] }
> = {
  chat: {
    user: ['text'],
    assistant: [
      'text',
      ...THINKING,
      'server_tool_use',
      'web_search_tool_result',
    ],
  },
  vision: { user: ['text', 'image'], assistant: ['text', ...THINKING] },
  document: { user: ['text', 'document'], assistant: ['text', ...THINKING] },
  rewrite: { user: ['text'], assistant: ['text'] },
  extract: { user: ['text'], assistant: ['text'] },
  receipt: { user: ['text', 'image'], assistant: ['text'] },
  agent: {
    user: ['text', 'tool_result'],
    assistant: ['text', 'tool_use', ...THINKING],
  },
};

const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));

const isMode = (v: unknown): v is Mode =>
  typeof v === 'string' && (MODES as readonly string[]).includes(v);
const isModel = (v: unknown): v is ModelId =>
  typeof v === 'string' && Object.hasOwn(MODELS, v);

export function validateRequest(body: unknown): Validation {
  try {
    return { ok: true, value: parse(body) };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, error: e.message };
    throw e;
  }
}

function parse(body: unknown): ClaudeRequest {
  if (!isObject(body)) throw new Invalid('Body must be a JSON object.');
  const { mode, model, messages } = body;
  if (!isMode(mode)) throw new Invalid('Unknown mode.');
  if (!isModel(model)) throw new Invalid('Unknown model.');
  if (!Array.isArray(messages) || messages.length === 0)
    throw new Invalid('Messages are required.');
  if (messages.length > LIMITS.maxMessages)
    throw new Invalid('The conversation is too long. Start a new one.');
  const options = parseOptions(body.options, mode);

  const budget: Budget = {
    textChars: 0,
    opaqueChars: 0,
    images: 0,
    documents: 0,
    searchResults: 0,
    citations: 0,
  };
  const clean = messages.map((message, i) =>
    parseMessage(message, i, mode, budget),
  );

  if (budget.images > LIMITS.maxImagesPerRequest) {
    throw new Invalid(
      `Send at most ${LIMITS.maxImagesPerRequest} photos at a time.`,
    );
  }
  if (budget.documents > LIMITS.maxDocumentsPerRequest)
    throw new Invalid('Send one document at a time.');
  if (budget.textChars > LIMITS.maxTextChars)
    throw new Invalid('That is too much text for one request.');
  if (
    budget.opaqueChars > LIMITS.maxOpaqueChars ||
    budget.searchResults > LIMITS.maxSearchResults ||
    budget.citations > LIMITS.maxCitations
  ) {
    throw new Invalid('The conversation is too long. Start a new one.');
  }
  return { mode, model, messages: clean, options };
}

function parseOptions(value: unknown, mode: Mode): RequestOptions {
  if (value === undefined || value === null) return { webSearch: false };
  if (!isObject(value)) throw new Invalid('Options must be an object.');
  const webSearch = value.web_search === true;
  if (webSearch && mode !== 'chat')
    throw new Invalid('Web search is only available in chat.');
  return { webSearch };
}

function parseMessage(
  message: unknown,
  index: number,
  mode: Mode,
  budget: Budget,
): Message {
  if (!isObject(message)) throw new Invalid('Each message must be an object.');
  const { role, content } = message;
  if (role !== 'user' && role !== 'assistant')
    throw new Invalid('Message roles must be user or assistant.');
  if (index === 0 && role !== 'user')
    throw new Invalid('The first message must come from the user.');

  if (typeof content === 'string') {
    if (content.trim().length === 0)
      throw new Invalid('Messages cannot be empty.');
    budget.textChars += content.length;
    return { role, content };
  }
  if (!Array.isArray(content) || content.length === 0)
    throw new Invalid('Message content is missing.');

  const allowed = ALLOWED_BLOCKS[mode][role];
  const blocks = content.map((block) => {
    if (
      !isObject(block) ||
      typeof block.type !== 'string' ||
      !allowed.includes(block.type)
    ) {
      throw new Invalid('This message type is not allowed here.');
    }
    return parseBlock(block, role, budget);
  });
  return { role, content: blocks } as Message;
}

function parseBlock(
  block: Record<string, unknown>,
  role: 'user' | 'assistant',
  budget: Budget,
): Block {
  switch (block.type) {
    case 'text': {
      const value = text(block.text, budget);
      // Only Claude's replies carry citations; they go back so later turns keep their sources.
      if (
        role === 'assistant' &&
        Array.isArray(block.citations) &&
        block.citations.length > 0
      ) {
        budget.citations += block.citations.length;
        return {
          type: 'text',
          text: value,
          citations: block.citations.map((c) => parseCitation(c, budget)),
        };
      }
      return { type: 'text', text: value };
    }

    case 'image': {
      const source = block.source;
      if (
        !isObject(source) ||
        source.type !== 'base64' ||
        typeof source.data !== 'string' ||
        !IMAGE_TYPES.includes(source.media_type as ImageType)
      ) {
        throw new Invalid('Images must be base64 JPEG, PNG, WebP or GIF.');
      }
      if (source.data.length > LIMITS.maxImageBase64Chars)
        throw new Invalid('The photo is too large.');
      if (!matchesImage(source.data, source.media_type as ImageType)) {
        throw new Invalid('The photo data does not match its type.');
      }
      budget.images++;
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: source.media_type as ImageType,
          data: source.data,
        },
      };
    }

    case 'document': {
      const source = block.source;
      if (
        !isObject(source) ||
        source.type !== 'base64' ||
        source.media_type !== 'application/pdf' ||
        typeof source.data !== 'string'
      ) {
        throw new Invalid('Documents must be base64 PDF files.');
      }
      if (source.data.length > LIMITS.maxPdfBase64Chars)
        throw new Invalid('The document is too large.');
      if (!matchesPdf(source.data))
        throw new Invalid('The document data is not a PDF.');
      budget.documents++;
      const title =
        typeof block.title === 'string' ? block.title.slice(0, 200) : undefined;
      // Citations are always on: they are the point of this mode.
      return {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: source.data,
        },
        ...(title ? { title } : {}),
        citations: { enabled: true },
      };
    }

    case 'tool_result': {
      if (typeof block.tool_use_id !== 'string')
        throw new Invalid('Tool results need a tool_use_id.');
      // Results come from the phone's own tools, so plain text is all they need. Anything richer
      // (images, documents) would slip past the checks above.
      const content = block.content;
      const value =
        typeof content === 'string'
          ? text(content, budget)
          : Array.isArray(content) &&
              content.every((c) => isObject(c) && c.type === 'text')
            ? content.map((c) => ({
                type: 'text' as const,
                text: text((c as Record<string, unknown>).text, budget),
              }))
            : null;
      if (value === null) throw new Invalid('Tool results must be text.');
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: value,
        ...(block.is_error === true ? { is_error: true } : {}),
      };
    }

    case 'tool_use':
      // Only the phone's own tools: an edited app cannot write calls to tools that do not exist.
      if (
        typeof block.id !== 'string' ||
        typeof block.name !== 'string' ||
        !AGENT_TOOL_NAMES.has(block.name) ||
        !isObject(block.input)
      ) {
        throw new Invalid('Malformed tool call.');
      }
      budget.textChars += JSON.stringify(block.input).length;
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };

    case 'server_tool_use': {
      // Only the searches Claude ran in an earlier reply. The server decides whether search is on.
      const input = block.input;
      if (
        typeof block.id !== 'string' ||
        block.name !== 'web_search' ||
        !isObject(input) ||
        typeof input.query !== 'string'
      ) {
        throw new Invalid('Malformed search call.');
      }
      return {
        type: 'server_tool_use',
        id: block.id,
        name: 'web_search',
        input: { query: text(input.query, budget) },
      };
    }

    case 'web_search_tool_result':
      return parseSearchResult(block, budget);

    case 'thinking':
      // Claude's reasoning, returned unchanged. The API checks the signature, so it cannot be forged.
      if (
        typeof block.thinking !== 'string' ||
        typeof block.signature !== 'string'
      ) {
        throw new Invalid('Malformed thinking block.');
      }
      budget.textChars += block.thinking.length;
      budget.opaqueChars += block.signature.length;
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      };

    case 'redacted_thinking':
      if (typeof block.data !== 'string')
        throw new Invalid('Malformed thinking block.');
      budget.opaqueChars += block.data.length;
      return { type: 'redacted_thinking', data: block.data };

    default:
      throw new Invalid('This message type is not allowed here.');
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function head(data: string): Uint8Array | null {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return null;
  try {
    return Uint8Array.from(atob(data.slice(0, 16)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// A PDF starts with "%PDF-".
function matchesPdf(data: string): boolean {
  const bytes = head(data);
  return (
    bytes !== null &&
    [0x25, 0x50, 0x44, 0x46, 0x2d].every((b, i) => bytes[i] === b)
  );
}

// The first bytes of each format, checked on the decoded start of the data, so a file that only
// claims to be a JPEG is refused here rather than billed and refused by the API.
function matchesImage(data: string, type: ImageType): boolean {
  const bytes = head(data);
  if (bytes === null) return false;
  const starts = (sig: number[], offset = 0) =>
    sig.every((b, i) => bytes[offset + i] === b);
  switch (type) {
    case 'image/jpeg':
      return starts([0xff, 0xd8, 0xff]);
    case 'image/png':
      return starts([0x89, 0x50, 0x4e, 0x47]);
    case 'image/gif':
      return starts([0x47, 0x49, 0x46, 0x38]);
    case 'image/webp':
      return (
        starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)
      );
  }
}
