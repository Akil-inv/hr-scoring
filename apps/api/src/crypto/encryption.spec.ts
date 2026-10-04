import { randomBytes } from 'crypto';
import {
  decryptBytes, decryptText, encryptBytes, encryptText, initKeys, isEncryptedBytes, setKeys,
} from './field-crypto';
import { EncryptionArgs, decryptDeep, fieldEncryption } from './encryption-middleware';

const key = randomBytes(32);

// Enough of the data model for the middleware to find relations.
const f = (name: string, kind = 'scalar', type = 'String', isList = false) => ({ name, kind, type, isList });
const DM = {
  models: {
    Team: { fields: [f('id'), f('eventId'), f('name'), f('teamLeadEmail'), f('members', 'object', 'TeamMember', true), f('decision', 'object', 'TeamDecision')] },
    TeamMember: { fields: [f('id'), f('name'), f('email')] },
    TeamDecision: { fields: [f('id'), f('feedback'), f('team', 'object', 'Team')] },
    Judge: { fields: [f('id'), f('eventId'), f('name'), f('email')] },
    Scorecard: { fields: [f('id'), f('totalScore', 'scalar', 'Float'), f('support', 'scalar', 'Boolean'), f('team', 'object', 'Team'), f('judge', 'object', 'Judge'), f('criterionScores', 'object', 'CriterionScore', true)] },
    CriterionScore: { fields: [f('id'), f('score', 'scalar', 'Float'), f('comment'), f('scorecard', 'object', 'Scorecard')] },
    AuditLog: { fields: [f('id'), f('newValues', 'scalar', 'Json'), f('reason')] },
  },
};

describe('field crypto', () => {
  beforeEach(() => setKeys('local', [{ version: 1, key }]));
  afterAll(() => setKeys('off', []));

  it('round-trips text with a fresh IV each time', () => {
    const a = encryptText('Aisha Tan');
    const b = encryptText('Aisha Tan');
    expect(a).toMatch(/^enc:v1:/);
    expect(a).not.toEqual(b);
    expect(decryptText(a)).toBe('Aisha Tan');
  });

  it('deterministic encryption is stable per field and differs across fields', () => {
    expect(encryptText('x', true, 'Team.name')).toBe(encryptText('x', true, 'Team.name'));
    expect(encryptText('x', true, 'Team.name')).not.toBe(encryptText('x', true, 'Judge.email'));
  });

  it('detects tampering', () => {
    const a = encryptText('5');
    const raw = Buffer.from(a.slice(7), 'base64url');
    raw[raw.length - 1] ^= 1;
    expect(() => decryptText('enc:v1:' + raw.toString('base64url'))).toThrow();
  });

  it('round-trips bytes', () => {
    const pdf = Buffer.from('%PDF-1.7 hello');
    const e = encryptBytes(pdf);
    expect(isEncryptedBytes(e)).toBe(true);
    expect(e.includes(Buffer.from('PDF'))).toBe(false);
    expect(decryptBytes(e).equals(pdf)).toBe(true);
  });

  it('reads old keys after rotation and writes with the newest', () => {
    const old = encryptText('kept');
    setKeys('local', [{ version: 1, key }, { version: 2, key: randomBytes(32) }]);
    expect(decryptText(old)).toBe('kept');
    expect(encryptText('new')).toMatch(/^enc:v2:/);
  });

  it('refuses to read without the key, and to start with encrypted data but no key', async () => {
    const a = encryptText('secret');
    setKeys('off', []);
    expect(() => decryptText(a)).toThrow(/no encryption key/);
    const store = { findMany: async () => [{ version: 1, kmsKeyId: 'k', encryptedKey: Buffer.alloc(1) }], create: async () => ({}) };
    await expect(initKeys(store, {})).rejects.toThrow(/KMS_KEY_ID is not set/);
  });

  it('off mode leaves values alone', () => {
    setKeys('off', []);
    expect(encryptText('plain')).toBe('plain');
  });
});

describe('encryption middleware', () => {
  const enc = new EncryptionArgs(DM as any);
  beforeEach(() => setKeys('local', [{ version: 1, key }]));
  afterAll(() => setKeys('off', []));

  it('encrypts nested writes and moves scores to their encrypted column', () => {
    const data = enc.data('Scorecard', {
      totalScore: 17.5,
      support: true,
      criterionScores: { create: [{ score: 3.75, comment: 'Clear goals' }], upsert: { where: { id: '1' }, create: { score: 4, comment: 'a' }, update: { score: { set: 2 } } } },
    });
    expect(data.totalScore).toBeNull();
    expect(decryptText(data.totalScoreEnc)).toBe('17.5');
    expect(decryptText(data.supportEnc)).toBe('true');
    const c = data.criterionScores.create[0];
    expect(c.score).toBeNull();
    expect(decryptText(c.scoreEnc)).toBe('3.75');
    expect(c.comment).toMatch(/^enc:/);
    expect(decryptText(data.criterionScores.upsert.update.scoreEnc)).toBe('2');
  });

  it('does not change the caller\'s object', () => {
    const input = { name: 'Aisha', teamLeadEmail: 'a@x.com' };
    enc.data('Team', input);
    expect(input).toEqual({ name: 'Aisha', teamLeadEmail: 'a@x.com' });
  });

  it('turns exact-match filters on deterministic fields into encrypted ones', () => {
    const w = enc.where('Judge', { eventId_email: { eventId: 'e', email: ' Ann@X.com ' } });
    expect(w.eventId_email.email).toBe(enc.data('Judge', { email: 'ann@x.com' }).email);
    const w2 = enc.where('Judge', { email: { equals: 'ANN@x.com', mode: 'insensitive' } });
    expect(w2.email).toEqual({ equals: w.eventId_email.email });
    const w3 = enc.where('Scorecard', { team: { name: { in: ['A', 'B'] } } });
    expect(w3.team.name.in[0]).toMatch(/^det:/);
  });

  it('refuses searches the database cannot do', () => {
    expect(() => enc.where('Team', { name: { contains: 'Ai' } })).toThrow(/encrypted/);
    expect(() => enc.where('TeamDecision', { feedback: 'x' })).toThrow(/encrypted/);
    expect(enc.where('TeamDecision', { feedback: { not: null } })).toEqual({ feedback: { not: null } });
  });

  it('asks for the encrypted score when the score is selected', () => {
    const sorts: any[] = [];
    const q = enc.query('Scorecard', { select: { totalScore: true, criterionScores: { select: { score: true } } } }, [], sorts);
    expect(q.select.totalScoreEnc).toBe(true);
    expect(q.select.criterionScores.select.scoreEnc).toBe(true);
  });

  it('decrypts results, however deep, and puts scores back', () => {
    const row = {
      id: '1', totalScore: null, totalScoreEnc: encryptText('12'), support: null, supportEnc: encryptText('false'), createdAt: new Date(0),
      team: { name: encryptText('Aisha', true, 'Team.name') },
      criterionScores: [{ score: null, scoreEnc: encryptText('3.25'), comment: encryptText('ok') }],
      log: { newValues: { __enc: encryptText(JSON.stringify({ a: [1, 2] })) } },
    };
    const out = decryptDeep(row);
    expect(out).toEqual({
      id: '1', totalScore: 12, support: false, createdAt: new Date(0), team: { name: 'Aisha' },
      criterionScores: [{ score: 3.25, comment: 'ok' }], log: { newValues: { a: [1, 2] } },
    });
  });

  it('sorts by encrypted fields after decrypting, including through a relation', async () => {
    const mw = fieldEncryption(DM as any);
    const rows = ['carol', 'Alice', 'bob'].map((n, i) => ({ id: String(i), name: encryptText(n, true, 'Team.name') }));
    let seen: any;
    const next = async (p: any) => { seen = p; return rows.map((r) => ({ ...r })); };
    const out = await mw({ model: 'Team', action: 'findMany', args: { orderBy: { name: 'asc' } } }, next);
    expect(seen.args.orderBy).toBeUndefined();
    expect(out.map((r: any) => r.name)).toEqual(['Alice', 'bob', 'carol']);

    const cards = [
      { id: 'a', team: { name: encryptText('Zed', true, 'Team.name') }, judge: { name: encryptText('B') } },
      { id: 'b', team: { name: encryptText('Amy', true, 'Team.name') }, judge: { name: encryptText('Z') } },
      { id: 'c', team: { name: encryptText('Amy', true, 'Team.name') }, judge: { name: encryptText('A') } },
    ];
    const out2 = await mw(
      { model: 'Scorecard', action: 'findMany', args: { include: { team: true, judge: true }, orderBy: [{ team: { name: 'asc' } }, { judge: { name: 'asc' } }] } },
      async () => cards.map((c) => JSON.parse(JSON.stringify(c))),
    );
    expect(out2.map((r: any) => r.id)).toEqual(['c', 'b', 'a']);

    const first = await mw({ model: 'Team', action: 'findFirst', args: { orderBy: { name: 'desc' } } }, async (p: any) => {
      expect(p.action).toBe('findMany');
      return rows.map((r) => ({ ...r }));
    });
    expect(first.name).toBe('carol');
  });

  it('passes everything through untouched when encryption is off', async () => {
    setKeys('off', []);
    const data = enc.data('CriterionScore', { score: 3, comment: 'x' });
    expect(data).toEqual({ score: 3, scoreEnc: null, comment: 'x' });
  });
});
