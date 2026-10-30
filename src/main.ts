import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ENV, type Env } from './config/env.js';

async function bootstrap() {
  // The body parser is off: the Claude route reads its own body, after the size and sign-in checks.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // Any origin may call the API: the only credential is the Bearer token in the Authorization
  // header, never a cookie, so a page on another site has nothing to borrow. The mobile app does
  // not need CORS at all; a web build of the same app does.
  app.enableCors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'apikey',
      'content-type',
      'x-client-info',
    ],
  });
  // On a long-running host, let open streams finish their usage logging before the process exits.
  app.enableShutdownHooks();
  await app.listen(app.get<Env>(ENV).port);
}

// Not awaited at the top level: on Vercel the launcher takes over listen() and never resolves it,
// so a top-level await would stop the module from ever finishing loading.
void bootstrap();
