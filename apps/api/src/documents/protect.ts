import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { Worker } from 'worker_threads';

/**
 * Password protection for the files people download.
 *
 * PDFs: AES-256 (PDF 2.0 / R6) with qpdf. Opens only with the reader's
 * document password. Printing is allowed; copying text, editing, annotating,
 * filling forms and reassembling are not. The owner password, which would lift
 * those limits, is random per file and never kept.
 *
 * Excel: ECMA-376 "agile" encryption (AES-256, SHA-512, 100,000 rounds), the
 * same as Excel's own Encrypt with Password.
 *
 * Nothing unprotected touches a disk if it can be helped: qpdf works on files,
 * so they go in a private folder in /dev/shm (memory) where it exists, and the
 * passwords go in an argument file rather than on the command line, where any
 * process listing would show them.
 */

const run = promisify(execFile);

export class ProtectionUnavailable extends Error {}

/** Workspace in memory when the system has one (/dev/shm on Linux and in Docker). */
function scratchRoot(): string {
  return existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
}

/**
 * Passwords qpdf can't take: line breaks (its argument file is one argument
 * per line) and a leading "-" (read as an option in the positional form).
 */
export function unsafeForProtection(password: string): boolean {
  return /[\r\n\0]/.test(password) || password.startsWith('-');
}

export async function protectPdf(pdf: Buffer, password: string): Promise<Buffer> {
  if (!password || unsafeForProtection(password)) throw new Error('A document password is needed to protect the file.');
  const dir = await mkdtemp(join(scratchRoot(), 'hr-protect-'));
  try {
    await chmod(dir, 0o700);
    const input = join(dir, 'in.pdf');
    const output = join(dir, 'out.pdf');
    const args = join(dir, 'args');
    await writeFile(input, pdf, { mode: 0o600 });
    // Hex: never starts with "-", which qpdf would read as an option.
    const owner = randomBytes(32).toString('hex');
    // The positional form (--encrypt USER OWNER 256) works on every qpdf in use;
    // the named password options need qpdf 11.7+, and Debian 12 ships 11.3.
    await writeFile(args, [
      '--encrypt', password, owner, '256',
      '--print=full', '--modify=none', '--extract=n', '--annotate=n', '--form=n', '--assemble=n',
      '--',
      input, output,
    ].join('\n') + '\n', { mode: 0o600 });
    try {
      await run('qpdf', [`@${args}`], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    } catch (e: any) {
      // Exit code 3: finished with warnings, the output is good.
      if (e?.code === 'ENOENT') throw new ProtectionUnavailable('qpdf is not installed on this server, so PDFs cannot be password-protected.');
      // qpdf's own message can quote its arguments, passwords included: never pass it on.
      if (e?.code !== 3) throw new Error(`Could not protect the PDF (qpdf exit ${e?.code ?? 'unknown'}).`);
    }
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Excel encryption is pure JavaScript and takes most of a second for a large
 * workbook, so it runs on a worker thread: judges scoring live aren't held up.
 */
const XLSX_WORKER = `
const { parentPort, workerData } = require('worker_threads');
const officeCrypto = require(workerData.lib);
try {
  const out = officeCrypto.encrypt(Buffer.from(workerData.xlsx), { password: workerData.password });
  parentPort.postMessage({ ok: true, out });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.message || e) });
}`;

export function protectXlsx(xlsx: Buffer, password: string): Promise<Buffer> {
  if (!password || unsafeForProtection(password)) return Promise.reject(new Error('A document password is needed to protect the file.'));
  const lib = require.resolve('officecrypto-tool');
  return new Promise((resolve, reject) => {
    const worker = new Worker(XLSX_WORKER, { eval: true, workerData: { xlsx, password, lib } });
    worker.once('message', (m: { ok: boolean; out?: Uint8Array; error?: string }) => {
      worker.terminate();
      if (m.ok && m.out) resolve(Buffer.from(m.out));
      else reject(new Error(`Could not protect the workbook: ${m.error ?? 'unknown error'}`));
    });
    worker.once('error', (e) => reject(new Error(`Could not protect the workbook: ${e.message}`)));
  });
}

/** Is qpdf here? Checked at start-up so a missing tool is reported once, plainly. */
export async function pdfProtectionAvailable(): Promise<boolean> {
  try {
    await run('qpdf', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
