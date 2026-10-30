// Every error leaves as `{ "error": "<words the app shows>" }`, the shape Parley's app already
// reads. Expected failures carry their own wording; anything unexpected is logged here and the
// app only hears a general message, never a stack trace or an internal detail.
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) {
      res.end();
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      // Nest's own errors (an unknown route) carry English that is fine to show as it is.
      res.status(status).json({
        error:
          status === HttpStatus.NOT_FOUND ? 'Not found.' : exception.message,
      });
      return;
    }
    console.error(
      'unhandled error',
      exception instanceof Error
        ? `${exception.name}: ${exception.message}`
        : String(exception),
    );
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: 'Something went wrong. Try again.' });
  }
}
