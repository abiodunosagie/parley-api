import type { ClaudeRequest } from './validate.js';

// About four characters per token for text, and Claude's documented ~1,600 tokens for a phone
// photo at 1568 px. PDFs: ~1,000 tokens per 10 KB of file, on the high side.
export function estimateInputTokens(req: ClaudeRequest): number {
  let tokens = 0;
  for (const message of req.messages) {
    if (typeof message.content === 'string') {
      tokens += message.content.length / 4;
      continue;
    }
    for (const block of message.content ?? []) {
      if (block.type === 'image') tokens += 1600;
      else if (block.type === 'document' && block.source.type === 'base64')
        tokens += (block.source.data.length * 0.75) / 10;
      else tokens += JSON.stringify(block).length / 4;
    }
  }
  return Math.ceil(tokens);
}
