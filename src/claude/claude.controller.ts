// Parley's one Claude endpoint: POST /v1/claude, the same contract as the edge function's
// POST /functions/v1/claude, so the app switches by changing its base URL and nothing else.
// Chat, photos, documents and rewriting stream back as server-sent events; extraction, receipts
// and the agent return one JSON answer. Whatever a call spends is logged at the end, even when the
// app disconnects.
import {
  Controller,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Anthropic } from '@anthropic-ai/sdk';
import type { Response } from 'express';
import { ENV, type Env } from '../config/env.js';
import { Meter, publicError, streamReply } from './anthropic.js';
import { type Admitted, ClaudeService } from './claude.service.js';
import { STREAMING_MODES } from './config.js';
import {
  BodySizeGuard,
  type SignedInRequest,
  SupabaseAuthGuard,
} from './request-guards.js';
import { readJsonBody } from './request-body.js';

@Controller('v1')
export class ClaudeController {
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
    let ownKey: string | null = null;
    try {
      const body = await readJsonBody(request, this.env.maxBodyBytes);
      const admitted = await this.claude.admit(
        request.userId,
        request.headers,
        body,
        (key) => (ownKey = key),
      );

      // Stop the Claude call (and its billing) the moment the app goes away.
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });

      await this.claude.checkDocumentSize(admitted, abort.signal);
      const meter = new Meter();
      if ((STREAMING_MODES as readonly string[]).includes(admitted.req.mode)) {
        await this.stream(res, admitted, abort.signal, meter);
        return;
      }
      try {
        res
          .status(200)
          .json(await this.claude.answer(admitted, abort.signal, meter));
      } finally {
        await this.claude.logUsage(admitted, meter);
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      logFailure('claude request failed', error, ownKey);
      if (res.headersSent) return void res.end();
      const { message, status } = publicError(error, ownKey !== null);
      res.status(status).json({ error: message });
    }
  }

  private async stream(
    res: Response,
    admitted: Admitted,
    signal: AbortSignal,
    meter: Meter,
  ): Promise<void> {
    res.status(200);
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
      ))
        send(event);
    } catch (error) {
      // The app left; the response is already closed.
      if (!signal.aborted) {
        logFailure('claude stream failed', error, admitted.ownKey);
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
}

// Logs a failure with no trace of the user's key: only the error's kind, status and message, with
// the key blanked out in case an upstream message ever echoes it.
function logFailure(label: string, error: unknown, ownKey: string | null) {
  const status = error instanceof Anthropic.APIError ? ` ${error.status}` : '';
  const name = error instanceof Error ? error.name : 'Error';
  let message = error instanceof Error ? error.message : String(error);
  if (ownKey) message = message.replaceAll(ownKey, '[key]');
  console.error(
    `${label}: ${name}${status} ${message}${ownKey ? ' (own key)' : ''}`,
  );
}
