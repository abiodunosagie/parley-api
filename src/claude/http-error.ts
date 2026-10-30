import { HttpException } from '@nestjs/common';

/**
 * Stops the request with a status and words the app shows to the user as they are, so the message
 * never carries internal details. The error filter turns it into `{ "error": message }`.
 */
export function fail(status: number, message: string): never {
  throw new HttpException(message, status);
}
