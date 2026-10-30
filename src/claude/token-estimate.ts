import type { ClaudeRequest } from './validate.js';

// Cautious stand-ins for when the API never reported a figure (the call failed or the app left).
const CHARS_PER_TOKEN = 4;
// Claude's documented cost of a phone photo resized to 1568 px.
const TOKENS_PER_PHOTO = 1600;
// About 1,000 tokens per 10 KB of PDF, on the high side; base64 is 4 characters per 3 bytes.
const PDF_BYTES_PER_BASE64_CHAR = 0.75;
const PDF_BYTES_PER_TOKEN = 10;

/** Input tokens [req] would cost, estimated without calling the API. */
export function estimateInputTokens(req: ClaudeRequest): number {
  let tokens = 0;
  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      tokens += message.content.length / CHARS_PER_TOKEN;
      continue;
    }
    for (const block of message.content ?? []) {
      if (block.type === 'image') tokens += TOKENS_PER_PHOTO;
      else if (block.type === 'document' && block.source.type === 'base64') {
        tokens +=
          (block.source.data.length * PDF_BYTES_PER_BASE64_CHAR) /
          PDF_BYTES_PER_TOKEN;
      } else tokens += JSON.stringify(block).length / CHARS_PER_TOKEN;
    }
  }
  return Math.ceil(tokens);
}
