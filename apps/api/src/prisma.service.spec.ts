import { PrismaService } from './prisma/prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(() => {
    service = new PrismaService();
  });

  afterEach(async () => {
    try {
      await service.$disconnect();
    } catch {
      // Ignore disconnect errors in tests
    }
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should have healthCheck method', () => {
    expect(typeof service.healthCheck).toBe('function');
  });

  it('should have onModuleInit method', () => {
    expect(typeof service.onModuleInit).toBe('function');
  });

  it('should have onModuleDestroy method', () => {
    expect(typeof service.onModuleDestroy).toBe('function');
  });

  it('healthCheck should return boolean', async () => {
    // Mock $queryRaw for unit test (no DB needed)
    service.$queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]) as any;
    const result = await service.healthCheck();
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
  });

  it('healthCheck should return false when DB is down', async () => {
    service.$queryRaw = jest.fn().mockRejectedValue(new Error('Connection refused')) as any;
    const result = await service.healthCheck();
    expect(result).toBe(false);
  });

  it('onModuleInit should retry on connection failure', async () => {
    const connectMock = jest.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValueOnce(undefined);

    service.$connect = connectMock;

    // Speed up retries for test
    (service as any).retryDelayMs = 10;

    await service.onModuleInit();

    expect(connectMock).toHaveBeenCalledTimes(3);
  });

  it('onModuleInit should throw after max retries', async () => {
    const connectMock = jest.fn().mockRejectedValue(new Error('fail'));
    service.$connect = connectMock;
    (service as any).retryDelayMs = 10;
    (service as any).maxRetries = 2;

    await expect(service.onModuleInit()).rejects.toThrow('fail');
    expect(connectMock).toHaveBeenCalledTimes(2);
  });
});
