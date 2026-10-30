// Parley's one Claude endpoint: POST /v1/claude, the same contract as the edge function's
// POST /functions/v1/claude, so the app switches by changing its base URL and nothing else.
// Chat, photos, documents and rewriting stream back as server-sent events; extraction, receipts
// and the agent return one JSON answer. Whatever a call spends is logged before the request ends,
// even when the app disconnects.
import {
  All,
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Anthropic } from '@anthropic-ai/sdk';
import type { Response } from 'express';
import { ENV, type Env } from '../config/env.js';
import { Meter, publicError, streamReply } from './anthropic.js';
import { type Admitted, ClaudeService, readOwnKey } from './claude.service.js';
import { isStreamingMode } from './config.js';
import { fail, PublicError } from './http-error.js';
import {
  BodySizeGuard,
  type SignedInRequest,
  SupabaseAuthGuard,
} from './request-guards.js';
import { readJsonBody } from './request-body.js';

@Controller('v1')
export class ClaudeController {
  private readonly logger = new Logger(ClaudeController.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly claude: ClaudeService,
  ) {}

  @Post('claude')
  @UseGuards(BodySizeGuard, SupabaseAuthGuard)
  async create(
    @Req() request: SignedInRequest,
    @Res() res: Response,
  ): Promise<void> {
    // Listening from the start: if the app leaves while the limits are checked, Claude is never
    // called; if it leaves mid-reply, the call (and its billing) stops.
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    let ownKey: string | null = null;
    try {
      const body = await readJsonBody(request, this.env.maxBodyBytes);
      ownKey = readOwnKey(body);
      const admitted = await this.claude.admit(
        request.userId,
        request.headers,
        body,
        ownKey,
      );
      if (abort.signal.aborted) return;
      await this.claude.checkDocumentSize(admitted, abort.signal);

      const meter = new Meter();
      if (isStreamingMode(admitted.req.mode)) {
        await this.stream(res, admitted, abort.signal, meter);
        return;
      }
      let result: unknown;
      try {
        result = await this.claude.answer(admitted, abort.signal, meter);
      } finally {
        // Logged before the answer is sent: on a serverless host the work after a finished
        // response may never run.
        await this.claude.logUsage(admitted, meter);
      }
      res.status(HttpStatus.OK).json(result);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logFailure('claude request failed', error, ownKey);
      const { message, status } = publicError(error, ownKey !== null);
      throw new PublicError(message, status);
    }
  }

  // The edge function answered other methods with 405; so does this.
  @All('claude')
  otherMethods(): never {
    fail(HttpStatus.METHOD_NOT_ALLOWED, 'Use POST.');
  }

  private async stream(
    res: Response,
    admitted: Admitted,
    signal: AbortSignal,
    meter: Meter,
  ): Promise<void> {
    res.status(HttpStatus.OK);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    const send = (event: unknown) =>
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    try {
      for await (const event of streamReply(
        admitted.anthropic,
        admitted.req,
        signal,
        meter,
      )) {
        send(event);
      }
    } catch (error) {
      // When the app left, the response is already closed and there is no one to tell.
      if (!signal.aborted) {
        this.logFailure('claude stream failed', error, admitted.ownKey);
        send({
          type: 'error',
          message: publicError(error, admitted.ownKey !== null).message,
        });
      }
    } finally {
      await this.claude.logUsage(admitted, meter);
    }
    res.end();
  }

  // Logs a failure with no trace of the user's key: only the error's kind, status and message, with
  // the key blanked out in case an upstream message ever echoes it.
  private logFailure(label: string, error: unknown, ownKey: string | null) {
    const status =
      error instanceof Anthropic.APIError ? ` ${error.status}` : '';
    const name = error instanceof Error ? error.name : 'Error';
    let message = error instanceof Error ? error.message : String(error);
    if (ownKey) message = message.replaceAll(ownKey, '[key]');
    this.logger.error(
      `${label}: ${name}${status} ${message}${ownKey ? ' (own key)' : ''}`,
    );
  }
}
