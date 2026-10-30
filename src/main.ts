import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}

// Not awaited at the top level: on Vercel the launcher takes over listen() and never resolves it,
// so a top-level await would stop the module from ever finishing loading.
void bootstrap();
