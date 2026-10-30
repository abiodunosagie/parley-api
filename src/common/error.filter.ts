// Every error leaves as `{ "error": "<words the app shows>" }`, the shape Parley's app already
// reads. Only a PublicError carries its own words; anything else (a framework or library error,
// a bug) is logged here and the app hears a general message, never a stack trace or an internal
// detail.
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { PublicError } from '../claude/http-error.js';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) {
      res.end();
      return;
    }
    if (exception instanceof PublicError) {
      res.status(exception.getStatus()).json({ error: exception.message });
      return;
    }
    if (
      exception instanceof HttpException &&
      exception.getStatus() === HttpStatus.NOT_FOUND
    ) {
      res.status(HttpStatus.NOT_FOUND).json({ error: 'Not found.' });
      return;
    }
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    this.logger.error(
      exception instanceof Error
        ? `${exception.name}: ${exception.message}`
        : String(exception),
    );
    res.status(status).json({ error: 'Something went wrong. Try again.' });
  }
}
