import { Controller, Get } from '@nestjs/common';

// Uptime checks and keep-warm pings hit this. It touches nothing else, so it stays cheap.
@Controller('health')
export class HealthController {
  @Get()
  check(): { ok: true } {
    return { ok: true };
  }
}
