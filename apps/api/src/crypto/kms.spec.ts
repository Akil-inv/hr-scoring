import { randomBytes } from 'crypto';

const plain = randomBytes(32);
const sent: string[] = [];
jest.mock('@aws-sdk/client-kms', () => ({
  KMSClient: class { async send(cmd: any) { sent.push(cmd.name); return cmd.name === 'gen' ? { CiphertextBlob: Buffer.from('wrapped'), Plaintext: plain } : { Plaintext: plain }; } },
  GenerateDataKeyCommand: class { name = 'gen'; constructor(public input: any) {} },
  DecryptCommand: class { name = 'dec'; constructor(public input: any) {} },
  EncryptCommand: class { name = 'enc'; constructor(public input: any) {} },
}));

import { checkValue, decryptText, encryptText, formatRecoveryKey, initKeys, parseKeys, setKeys } from './field-crypto';

describe('KMS key setup and recovery', () => {
  afterAll(() => setKeys('off', []));
  const rows: any[] = [];
  const store = {
    findMany: async () => rows.map((r) => ({ ...r })),
    create: async ({ data }: any) => rows.push({ ...data }),
    update: async ({ where, data }: any) => Object.assign(rows.find((r) => r.version === where.version), data),
  };

  it('creates the data key on first start, stores only the wrapped copy and a fingerprint, and unlocks it later', async () => {
    expect(await initKeys(store, { KMS_KEY_ID: 'alias/hr-scoring' })).toBe('kms');
    expect(rows).toEqual([{ version: 1, kmsKeyId: 'alias/hr-scoring', encryptedKey: Buffer.from('wrapped'), checkValue: checkValue(plain) }]);
    expect(sent).toEqual(['gen', 'dec']);
    const v = encryptText('Aisha');
    setKeys('off', []);
    await initKeys(store, { KMS_KEY_ID: 'alias/hr-scoring' });
    expect(rows).toHaveLength(1);
    expect(decryptText(v)).toBe('Aisha');
  });

  it('the recovery key round-trips through its printed form', () => {
    const printed = formatRecoveryKey(1, plain);
    expect(printed).toMatch(/^HRK-v1-([0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    expect(parseKeys(` ${printed} `)).toEqual([{ version: 1, key: plain }]);
    expect(() => parseKeys('HRK-v1-1234')).toThrow(/not a valid recovery key/);
  });

  it('break glass: the recovery key opens KMS-protected data', async () => {
    setKeys('off', []);
    expect(await initKeys(store, { FIELD_ENCRYPTION_KEY: formatRecoveryKey(1, plain) })).toBe('recovery');
    await expect(initKeys(store, { FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') })).rejects.toThrow(/not the key/);
  });
});
