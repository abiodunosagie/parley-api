// Every limit and model choice the server enforces lives here, so the app can never ask for
// more than the server allows. Change a number here, redeploy, and every client follows.

// serverFallback: Opus and Sonnet support server-side refusal fallbacks; Haiku does not.
export const MODELS = {
  'claude-haiku-5-5': { serverFallback: false },
  'claude-sonnet-5-5': { serverFallback: true },
  'claude-opus-5-5': { serverFallback: true },
} as const;

export type ModelId = keyof typeof MODELS;

// Streaming modes send text as it is written; the others return one finished JSON answer.
export const MODES = [
  'chat',
  'vision',
  'document',
  'rewrite',
  'extract',
  'receipt',
  'agent',
] as const;
export const STREAMING_MODES = [
  'chat',
  'vision',
  'document',
  'rewrite',
] as const;
export type Mode = (typeof MODES)[number];

export const isStreamingMode = (mode: Mode): boolean =>
  (STREAMING_MODES as readonly Mode[]).includes(mode);

// Output ceilings per mode. Thinking tokens count toward these, so they are generous for the task
// but still cap what one request can cost.
export const MAX_TOKENS: Record<Mode, number> = {
  chat: 8000,
  vision: 6000,
  document: 8000,
  rewrite: 4000,
  extract: 4000,
  receipt: 4000,
  agent: 6000,
};

// Effort trades depth for speed and spend. Chat, rewriting and extraction are routine; photos,
// receipts, documents and tool planning get one level more.
export const EFFORT: Record<Mode, 'low' | 'medium'> = {
  chat: 'low',
  vision: 'medium',
  document: 'medium',
  rewrite: 'low',
  extract: 'low',
  receipt: 'medium',
  agent: 'medium',
};

// Modes whose replies show Claude's summarized reasoning in the app. Rewriting and the two
// structured modes only show the result.
export const SHOW_THINKING: readonly Mode[] = [
  'chat',
  'vision',
  'document',
  'agent',
];

// Web search is a server tool: Anthropic runs the searches inside the same request. Each search
// is billed ($10 per 1,000), so one reply may search at most this many times, resumed rounds
// included.
export const WEB_SEARCH_MAX_USES = 3;

export const LIMITS = {
  perUserPerMinute: 20,
  perUserPerDay: 200,
  // Anyone can create an account, so one network (hashed IP) has its own ceiling, and the
  // whole project has a final one.
  perIpPerDay: 400,
  projectPerDay: 2000,
  // Request counts alone would let someone send only the most expensive calls, so input plus
  // output tokens are capped per day as well.
  userTokensPerDay: 150_000,
  // About $20 a day at worst on Opus (all output), a fifth of the $100 starter credit.
  projectTokensPerDay: 1_000_000,
  maxMessages: 60,
  maxTextChars: 120_000,
  // Base64 characters for one image, about 2.6 MB of image bytes. The app resizes to 1568 px
  // JPEG first, which is usually well under 1 MB.
  maxImageBase64Chars: 3_500_000,
  maxImagesPerRequest: 4,
  // One PDF, about 6 MB of file bytes. Every follow-up question sends it again, and each page
  // costs 1,500 to 3,000 input tokens, so the daily token cap stops very long documents.
  maxPdfBase64Chars: 8_000_000,
  maxDocumentsPerRequest: 1,
  // Input tokens one document request may carry, counted before Claude is called. About 25 dense
  // pages; keeps one PDF from eating a whole day's token budget.
  maxDocumentInputTokens: 60_000,
  // Searches are billed apart from tokens: about $0.30 a day per user at most.
  webSearchesPerUserPerDay: 30,
  // Requests on the user's own key cost Parley nothing, but each one is still a row and a function
  // run, so a script with a fake key is held to a generous daily count of its own.
  ownKeyPerUserPerDay: 2000,
  // Opaque data Claude hands back for replay (encrypted search results, thinking signatures,
  // cited quotes). Counted apart from your own text because it is large and the API checks it;
  // a few search turns carry a few hundred KB each.
  maxOpaqueChars: 6_000_000,
  // Earlier search results and citations sent back for replay.
  maxSearchResults: 60,
  maxCitations: 200,
  // Checked from Content-Length before the body is parsed.
  maxBodyBytes: 16_000_000,
};

// A user's own Anthropic key arrives as `api_key` in the JSON body, one request at a time. It is in
// the body, not a header, because the platform's request logs record headers and never bodies.
// Checked against the shape of a real key before it is used, so nothing else can ride in on it.
export const OWN_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,250}$/;

export const SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
