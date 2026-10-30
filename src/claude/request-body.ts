import { HttpException, HttpStatus } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { fail } from './http-error.js';

// The JSON body, read while counting bytes, so a request without (or lying about) Content-Length
// still cannot be larger than the limit. Nest's own body parser is off: the body is only read
// after the size check and the sign-in check have passed.
export async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const text = await readLimited(request, maxBytes);
  try {
    return JSON.parse(text);
  } catch {
    fail(HttpStatus.BAD_REQUEST, 'Body must be JSON.');
  }
}

// Stops collecting at the limit but keeps draining the rest of the upload, so the socket stays
// usable and the 413 below still reaches the app.
function readLimited(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) tooLarge = true;
      if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge)
        reject(
          new HttpException(
            'That request is too large.',
            HttpStatus.PAYLOAD_TOO_LARGE,
          ),
        );
      else resolve(Buffer.concat(chunks, size).toString('utf8'));
    });
    request.on('error', reject);
  });
}
