// The two checks every Claude request passes before its body is even read, in the edge function's
// order: the declared size first (cheap, and it refuses huge uploads without reading them), then
// a signed-in Supabase user.
import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ENV, type Env } from '../config/env.js';
import { fail } from './http-error.js';
import { SupabaseService } from './supabase.service.js';

export type SignedInRequest = Request & { userId: string };

@Injectable()
export class BodySizeGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    // An early refusal only: a missing or malformed Content-Length reads as 0 or NaN and passes
    // here, and the byte counter in request-body.ts still holds the real limit.
    const size = Number(request.headers['content-length'] ?? '0');
    if (size > this.env.maxBodyBytes) {
      // Let the upload drain into nothing, so the app reads the 413 instead of a reset socket.
      request.resume();
      fail(HttpStatus.PAYLOAD_TOO_LARGE, 'That request is too large.');
    }
    return true;
  }
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(private readonly supabase: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SignedInRequest>();
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) fail(HttpStatus.UNAUTHORIZED, 'Sign in first.');
    request.userId = await this.supabase.userIdFromToken(token);
    return true;
  }
}
