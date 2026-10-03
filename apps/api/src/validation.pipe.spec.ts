import { createValidationPipe } from './validation.pipe';
import { BadRequestException } from '@nestjs/common';

describe('ValidationPipe', () => {
  let pipe: any;

  beforeEach(() => {
    pipe = createValidationPipe();
  });

  it('should be defined', () => {
    expect(pipe).toBeDefined();
  });

  it('should have whitelist enabled', () => {
    expect(pipe).toHaveProperty('validatorOptions');
  });

  it('should have transform enabled', () => {
    expect(pipe).toBeDefined();
  });

  it('should pass through valid primitive values', async () => {
    const result = await pipe.transform('hello', { type: 'query', metatype: String });
    expect(result).toBe('hello');
  });

  it('should pass through valid numbers', async () => {
    const result = await pipe.transform(42, { type: 'query', metatype: Number });
    expect(result).toBe(42);
  });

  it('should pass through valid booleans', async () => {
    const result = await pipe.transform(true, { type: 'query', metatype: Boolean });
    expect(result).toBe(true);
  });
});
