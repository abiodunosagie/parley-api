import { HttpException } from '@nestjs/common';

/**
 * An error whose message was written for the app and is safe to show as it is. The error filter
 * sends only these messages; any other exception reaches the app as a general message.
 */
export class PublicError extends HttpException {}

/** Stops the request with a status and words the app shows to the user. */
export function fail(status: number, message: string): never {
  throw new PublicError(message, status);
}
