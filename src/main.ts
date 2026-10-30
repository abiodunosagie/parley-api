import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // The body parser is off: the Claude route reads its own body, after the size and sign-in checks.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // The mobile app needs no CORS. It stays so a web build of the same app can call the API; auth is
  // a Bearer header, never a cookie, so * is safe.
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
  await app.listen(process.env.PORT ?? 3000);
}

// Not awaited at the top level: on Vercel the launcher takes over listen() and never resolves it,
// so a top-level await would stop the module from ever finishing loading.
void bootstrap();
