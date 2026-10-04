import { randomBytes } from 'crypto';

const plain = randomBytes(32);
const sent: string[] = [];
jest.mock('@aws-sdk/client-kms', () => ({
  KMSClient: class { async send(cmd: any) { sent.push(cmd.name); return cmd.name === 'gen' ? { CiphertextBlob: Buffer.from('wrapped'), Plaintext: plain } : { Plaintext: plain }; } },
  GenerateDataKeyCommand: class { name = 'gen'; constructor(public input: any) {} },
  DecryptCommand: class { name = 'dec'; constructor(public input: any) {} },
}));

import { decryptText, encryptText, initKeys, setKeys } from './field-crypto';

describe('KMS key setup', () => {
  afterAll(() => setKeys('off', []));

  it('creates the data key on first start, stores only the wrapped copy, and unlocks it on later starts', async () => {
    const rows: any[] = [];
    const store = { findMany: async () => rows.slice(), create: async ({ data }: any) => rows.push(data) };
    expect(await initKeys(store, { KMS_KEY_ID: 'alias/hr-scoring' })).toBe('kms');
    expect(rows).toEqual([{ version: 1, kmsKeyId: 'alias/hr-scoring', encryptedKey: Buffer.from('wrapped') }]);
    expect(sent).toEqual(['gen', 'dec']);
    const v = encryptText('Aisha');
    setKeys('off', []);
    await initKeys(store, { KMS_KEY_ID: 'alias/hr-scoring' });
    expect(sent).toEqual(['gen', 'dec', 'dec']);
    expect(rows).toHaveLength(1);
    expect(decryptText(v)).toBe('Aisha');
  });
});
