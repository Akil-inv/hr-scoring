import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from './prisma/prisma.service';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('check()', () => {
    it('should return ok when database is connected', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);
      const result = await controller.check();
      expect(result.status).toBe('ok');
      expect(result.database.status).toBe('connected');
      expect(result.database.latencyMs).toBeDefined();
      expect(result.memory).toBeDefined();
      expect(result.memory.healthy).toBe(true);
      expect(result.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should return degraded when database is disconnected', async () => {
      (prisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('Connection refused'));
      const result = await controller.check();
      expect(result.status).toBe('degraded');
      expect(result.database.status).toBe('disconnected');
      expect(result.database.error).toContain('Connection refused');
    });

    it('should include timestamp in ISO format', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);
      const result = await controller.check();
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });

    it('should include memory stats', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);
      const result = await controller.check();
      expect(result.memory.heapUsedMB).toBeGreaterThan(0);
      expect(result.memory.heapTotalMB).toBeGreaterThan(0);
      expect(result.memory.rssMB).toBeGreaterThan(0);
    });
  });

  describe('readiness()', () => {
    it('should return ready true when DB is available', async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([{ '?column?': 1 }]);
      const result = await controller.readiness();
      expect(result.ready).toBe(true);
    });

    it('should return ready false when DB is down', async () => {
      (prisma.$queryRaw as jest.Mock).mockRejectedValue(new Error('fail'));
      const result = await controller.readiness();
      expect(result.ready).toBe(false);
    });
  });

  describe('liveness()', () => {
    it('should always return alive', async () => {
      const result = await controller.liveness();
      expect(result.alive).toBe(true);
      expect(result.uptime).toBeGreaterThanOrEqual(0);
    });
  });
});
