import { Module } from '@nestjs/common';
import { ClaudeController } from './claude.controller.js';
import { ClaudeService } from './claude.service.js';
import { BodySizeGuard, SupabaseAuthGuard } from './request-guards.js';
import { SupabaseService } from './supabase.service.js';

@Module({
  controllers: [ClaudeController],
  providers: [ClaudeService, SupabaseService, BodySizeGuard, SupabaseAuthGuard],
})
export class ClaudeModule {}
