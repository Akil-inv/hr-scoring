import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private readonly maxRetries = 5;
  private readonly retryDelayMs = 2000;

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });

    // Log database errors
    (this as any).$on('error', (e: any) => {
      this.logger.error(`Database error: ${e.message}`);
    });

    (this as any).$on('warn', (e: any) => {
      this.logger.warn(`Database warning: ${e.message}`);
    });
  }

  async onModuleInit() {
    let retries = 0;
    while (retries < this.maxRetries) {
      try {
        await this.$connect();
        this.logger.log('Database connected');
        return;
      } catch (error: any) {
        retries++;
        this.logger.warn(
          `Database connection attempt ${retries}/${this.maxRetries} failed: ${error.message}`,
        );
        if (retries === this.maxRetries) {
          this.logger.error('Failed to connect to database after all retries');
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * retries));
      }
    }
  }

  async onModuleDestroy() {
    this.logger.log('Disconnecting from database');
    await this.$disconnect();
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
