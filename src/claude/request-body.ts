import { HttpStatus } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { fail, PublicError } from './http-error.js';

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

// Refuses the moment the count passes the limit. The rest of the upload is let through into
// nothing (never buffered) so the socket is not reset under the 413.
function readLimited(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      request.off('data', onData);
      request.off('end', onEnd);
      request.resume();
      reject(
        new PublicError(
          'That request is too large.',
          HttpStatus.PAYLOAD_TOO_LARGE,
        ),
      );
    };
    const onEnd = () => resolve(Buffer.concat(chunks, size).toString('utf8'));
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', reject);
  });
}
