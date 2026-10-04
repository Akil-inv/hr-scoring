/**
 * Operator commands for field encryption. On the server use ./encryption.sh,
 * which runs this inside the api container:
 *
 *   status        what protects the data, and how much is encrypted
 *   check         unlock the key exactly as the app would, and say if it works
 *   recovery-kit  print the recovery key for the safe (break glass)
 *   move-to-kms <key id or alias>   protect the key with a (different) KMS key
 *   decrypt-all --yes   the switch back: store everything plain, remove the key
 */
import { DataKeyStore, exportKeys, formatRecoveryKey, initKeys, checkValue, wrapWithKms } from './field-crypto';
import { decryptEverything, scanEncryption, totals } from './backfill';

type Client = {
  dataKey: any;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

const MODE_TEXT: Record<string, string> = {
  kms: 'ON, key held by AWS KMS',
  local: 'ON, key from FIELD_ENCRYPTION_KEY (no KMS)',
  recovery: 'ON, BREAK GLASS: running on the recovery key, not KMS',
  off: 'OFF',
};

export async function runCli(argv: string[], db: Client, env: NodeJS.ProcessEnv, out: (s: string) => void): Promise<number> {
  const [cmd, ...rest] = argv;
  const store = db.dataKey as DataKeyStore;
  const unlock = () => initKeys(store, env, (m) => out(`  ${m}`));

  switch (cmd) {
    case 'status': {
      const rows = await db.dataKey.findMany({ orderBy: { version: 'asc' } });
      const scan = await scanEncryption(db);
      const t = totals(scan);
      out('Field encryption');
      out(`  Configured:  ${env.KMS_KEY_ID ? `KMS_KEY_ID=${env.KMS_KEY_ID}` : 'no KMS_KEY_ID'}${env.FIELD_ENCRYPTION_KEY ? ' + FIELD_ENCRYPTION_KEY' : ''}`);
      if (!rows.length) out('  Data key:    none yet (created on the first start with a key)');
      for (const r of rows) {
        out(`  Data key v${r.version}: ${r.kmsKeyId === 'local' ? 'local key, no KMS' : `wrapped by AWS KMS ${r.kmsKeyId}`}; fingerprint ${r.checkValue ?? '-'}`);
        out(`               created ${new Date(r.createdAt).toISOString().slice(0, 16)}Z; recovery kit ${r.recoveryExportedAt ? `printed ${new Date(r.recoveryExportedAt).toISOString().slice(0, 16)}Z` : 'NEVER PRINTED: run recovery-kit'}`);
      }
      out(`  Values:      ${t.encrypted} encrypted, ${t.plain} plain`);
      for (const [model, c] of Object.entries(scan)) if (c.encrypted + c.plain) out(`    ${model.padEnd(20)} ${c.encrypted} encrypted, ${c.plain} plain`);
      return 0;
    }

    case 'check': {
      const mode = await unlock();
      out(`OK: ${MODE_TEXT[mode]}.`);
      return 0;
    }

    case 'recovery-kit': {
      const mode = await unlock();
      if (mode === 'off') {
        out('Encryption is off: there is no key to print.');
        return 1;
      }
      const now = new Date();
      out('');
      out('==================  HR SCORING: ENCRYPTION RECOVERY KIT  ==================');
      out(`Printed ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
      out('');
      for (const k of exportKeys()) {
        out(`Recovery key, version ${k.version} (fingerprint ${checkValue(k.key)}):`);
        out(`  ${formatRecoveryKey(k.version, k.key)}`);
        out('');
      }
      out('Keep this OFFLINE: a password-manager vault, or printed in a safe, with two');
      out('people knowing where. With this key and a copy of the database, anyone can');
      out('read all candidate data, so treat it like the HR files themselves.');
      out('');
      out('Break glass (AWS KMS unavailable): on the server, add to .env');
      out('  FIELD_ENCRYPTION_KEY=<the recovery key above>');
      out('and run the deploy. When KMS works again, set KMS_KEY_ID as well, restart,');
      out('then remove FIELD_ENCRYPTION_KEY. Full steps: docs/FIELD-ENCRYPTION.md');
      out('============================================================================');
      await db.$executeRawUnsafe(`UPDATE "data_keys" SET "recovery_exported_at" = now()`);
      return 0;
    }

    case 'move-to-kms': {
      const target = rest[0];
      if (!target) {
        out('Give the KMS key: move-to-kms alias/hr-scoring');
        return 1;
      }
      const mode = await unlock();
      if (mode === 'off') {
        out('Encryption is off: nothing to move. Set KMS_KEY_ID and start the app instead.');
        return 1;
      }
      const n = await wrapWithKms(store, target, env);
      out(n ? `Done: the key is now protected by ${target}.` : `The key was already protected by ${target}.`);
      out(`Set KMS_KEY_ID=${target} in .env (and remove FIELD_ENCRYPTION_KEY if set), then restart.`);
      return 0;
    }

    case 'decrypt-all': {
      if (!rest.includes('--yes')) {
        out('This stores every value unencrypted again and removes the key. Stop the app first, then run with --yes.');
        return 1;
      }
      const mode = await unlock();
      if (mode === 'off') {
        out('Encryption is already off.');
        return 0;
      }
      const n = await decryptEverything(db, (m) => out(`  ${m}`));
      const left = totals(await scanEncryption(db)).encrypted;
      if (left > 0) {
        out(`${left} values are still encrypted (something wrote while this ran?). The key was kept. Stop the app and run again.`);
        return 1;
      }
      await db.$executeRawUnsafe(`DELETE FROM "data_keys"`);
      out(`Done: ${n} rows decrypted; the key is removed. Encryption is off once KMS_KEY_ID and FIELD_ENCRYPTION_KEY are out of .env.`);
      return 0;
    }

    default:
      out('Commands: status | check | recovery-kit | move-to-kms <key> | decrypt-all --yes');
      return cmd ? 1 : 0;
  }
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient();
  runCli(process.argv.slice(2), db, process.env, (s) => console.log(s))
    .then(async (code) => {
      await db.$disconnect();
      process.exit(code);
    })
    .catch(async (e) => {
      console.error(`Failed: ${e.message}`);
      await db.$disconnect();
      process.exit(1);
    });
}
