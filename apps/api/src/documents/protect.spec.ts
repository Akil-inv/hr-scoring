import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import PDFDocument = require('pdfkit');
import * as XLSX from 'xlsx';
import { protectPdf, protectXlsx } from './protect';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const officeCrypto = require('officecrypto-tool');

function samplePdf(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const parts: Buffer[] = [];
    doc.on('data', (c) => parts.push(c));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.text('Candidate: Priya Menon — Recommended');
    doc.end();
  });
}

/** Run qpdf on a buffer; returns stdout, or throws with stderr. */
function qpdf(args: string[], input: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'qpdf-test-'));
  try {
    writeFileSync(join(dir, 'f.pdf'), input);
    return execFileSync('qpdf', [...args, join(dir, 'f.pdf')], { stdio: 'pipe' }).toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const shm = () => (existsSync('/dev/shm') ? readdirSync('/dev/shm').filter((f) => f.startsWith('hr-protect-')) : []);

describe('protectPdf', () => {
  const password = 'doc-pass-for-priya-42';

  it('cannot be opened without the password, and opens with it', async () => {
    const locked = await protectPdf(await samplePdf(), password);
    expect(locked.subarray(0, 4).toString()).toBe('%PDF');
    expect(() => qpdf(['--check'], locked)).toThrow(/invalid password/i);
    expect(() => qpdf(['--check', '--password=wrong-password'], locked)).toThrow(/invalid password/i);
    expect(qpdf(['--check', `--password=${password}`], locked)).toMatch(/No syntax or stream encoding errors/);
  });

  it('uses AES-256, allows printing, blocks copying and editing', async () => {
    const locked = await protectPdf(await samplePdf(), password);
    const info = qpdf(['--show-encryption', `--password=${password}`], locked);
    expect(info).toMatch(/R = 6/);                          // AES-256 (PDF 2.0)
    expect(info).toMatch(/print high resolution: allowed/);
    expect(info).toMatch(/extract for any purpose: not allowed/);
    expect(info).toMatch(/modify anything: not allowed/);
    expect(info).toMatch(/modify annotations: not allowed/);
    expect(info).toMatch(/User password = doc-pass-for-priya-42|Supplied password is user password/);
  });

  it('gives every file its own owner password, and leaves no files behind', async () => {
    const before = shm().length;
    const a = await protectPdf(await samplePdf(), password);
    const b = await protectPdf(await samplePdf(), password);
    expect(a.equals(b)).toBe(false);
    expect(shm().length).toBe(before);
  });

  it('works for passwords and owner passwords that start with "-" (100 files in a row)', async () => {
    const pdf = await samplePdf();
    const dash = await protectPdf(pdf, '-starts-with-dash-9');
    expect(qpdf(['--check', '--password=-starts-with-dash-9'], dash)).toMatch(/No syntax or stream encoding errors/);
    // A random owner password begins with "-" about 1 time in 64: 100 in a row would have failed before.
    for (let i = 0; i < 100; i++) await protectPdf(pdf, password);
  }, 120_000);

  it('never puts the password in an error message', async () => {
    const err = (await protectPdf(Buffer.from('not a pdf at all'), 'secret-in-the-args-77').catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain('secret-in-the-args-77');
    expect(shm().length).toBe(0);
  });

  it('refuses an empty password or one with a line break', async () => {
    await expect(protectPdf(await samplePdf(), '')).rejects.toThrow();
    await expect(protectPdf(await samplePdf(), 'two\nlines')).rejects.toThrow();
  });
});

describe('protectXlsx', () => {
  it('is an encrypted workbook that only the password opens (encrypted on a worker thread)', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Candidate', 'Score'], ['Priya', 87]]), 'S');
    const plain = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const locked = await protectXlsx(plain, 'doc-pass-for-priya-42');
    expect(locked.subarray(0, 2).toString()).not.toBe('PK');     // not a readable zip any more
    expect(officeCrypto.isEncrypted(locked)).toBe(true);
    expect(() => XLSX.read(locked, { type: 'buffer' })).toThrow();
    return officeCrypto.decrypt(locked, { password: 'doc-pass-for-priya-42' }).then((opened: Buffer) => {
      const rows = XLSX.utils.sheet_to_json(XLSX.read(opened, { type: 'buffer' }).Sheets.S, { header: 1 });
      expect(rows).toEqual([['Candidate', 'Score'], ['Priya', 87]]);
    });
  });
});
