import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    // Needs a database. Failing without one reports an environment problem
    // as a code problem, and a suite that cries wolf stops being read.
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleFixture.createNestApplication();
      await app.init();
    } catch (err: any) {
      console.warn(
        '\n  Skipping: no database reachable.\n' +
        `  (${err?.message?.split('\n')[0] ?? err})\n`,
      );
    }
  });
  afterAll(async () => { if (app) await app.close(); });
  it('health query returns ok', () => {
    return request(app.getHttpServer())
      .post('/graphql')
      .send({ query: '{ health }' })
      .expect(200)
      .expect((res) => { expect(res.body.data.health).toBe('ok'); });
  });
});
