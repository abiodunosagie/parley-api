import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ClaudeModule } from './claude/claude.module.js';
import { ErrorFilter } from './common/error.filter.js';
import { ENV, loadEnv } from './config/env.js';
import { HealthController } from './health/health.controller.js';

// The environment is read once, at boot, and shared with every module.
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
class EnvModule {}

@Module({
  imports: [EnvModule, ClaudeModule],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {}
