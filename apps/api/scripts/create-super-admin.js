/*
 * Create or reset a super admin account.
 *
 *   docker-compose exec api node scripts/create-super-admin.js you@example.com
 *
 * The password is read from the SUPER_ADMIN_PASSWORD environment variable if
 * set, otherwise asked for interactively, so it never lands in shell history.
 * Running it again for the same email resets that account's password and
 * makes it a super admin.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const readline = require('readline');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('Usage: node scripts/create-super-admin.js <email>');
    process.exit(1);
  }

  const password = process.env.SUPER_ADMIN_PASSWORD || (await ask('Password (min 12 characters): '));
  if (!password || password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.upsert({
      where: { email },
      update: { passwordHash, role: 'SUPER_ADMIN' },
      create: { email, passwordHash, role: 'SUPER_ADMIN', name: email.split('@')[0] },
    });
    console.log(`Super admin ready: ${user.email}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
