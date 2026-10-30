import { Global, Module } from '@nestjs/common';
import { ENV, loadEnv } from './env.js';

/** The environment, read once at boot and shared with every module. */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class EnvModule {}
