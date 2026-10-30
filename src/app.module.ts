import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ClaudeModule } from './claude/claude.module.js';
import { ErrorFilter } from './common/error.filter.js';
import { EnvModule } from './config/env.module.js';
import { HealthController } from './health/health.controller.js';

@Module({
  imports: [EnvModule, ClaudeModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {}
