import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { Public } from './auth/public.decorator';

@Public()
@Controller()
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Get('health')
  async check() {
    const checks: Record<string, any> = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
    };

    // Database check
    try {
      const start = Date.now();
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'connected', latencyMs: Date.now() - start };
    } catch (e: any) {
      checks.database = { status: 'disconnected', error: e.message?.substring(0, 100) };
      checks.status = 'degraded';
    }

    // Scheduler check
    try {
      const schedulerUrl = process.env.SCHEDULER_URL || 'http://scheduler:8001';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const start = Date.now();
      const res = await fetch(`${schedulerUrl}/docs`, { signal: controller.signal });
      clearTimeout(timeout);
      checks.scheduler = { status: res.ok ? 'connected' : 'error', latencyMs: Date.now() - start };
    } catch (e: any) {
      checks.scheduler = { status: 'unreachable', error: e.message?.substring(0, 100) };
      // Scheduler being down doesn't degrade the whole system
    }

    // Memory check
    const mem = process.memoryUsage();
    checks.memory = {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      healthy: mem.heapUsed / mem.heapTotal < 0.9,
    };
    if (!checks.memory.healthy) checks.status = 'degraded';

    return checks;
  }

  @Get('health/ready')
  async readiness() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ready: true };
    } catch {
      return { ready: false };
    }
  }

  @Get('health/live')
  async liveness() {
    return { alive: true, uptime: Math.round(process.uptime()) };
  }
}
