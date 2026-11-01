import { Controller, Get, Header, Inject } from '@nestjs/common';
import { StatsService } from './stats.service.js';

// Public totals for the website's homepage. Counts only, never any customer data.
@Controller('stats')
export class StatsController {
  constructor(@Inject(StatsService) private readonly stats: StatsService) {}

  @Get('public')
  @Header('Cache-Control', 'public, max-age=60')
  publicStats() {
    return this.stats.publicStats();
  }
}
