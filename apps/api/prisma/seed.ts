import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...\n');

  // ─── Users ───
  const adminEmail = 'admin@hackathon.local';
  let admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!admin) {
    admin = await prisma.user.create({
      data: { email: adminEmail, passwordHash: await bcrypt.hash('admin123', 10), role: Role.ADMIN },
    });
    console.log('✅ Admin user created');
  } else {
    console.log('⏭️  Admin user exists');
  }

  let coord = await prisma.user.findUnique({ where: { email: 'coordinator@hackathon.local' } });
  if (!coord) {
    coord = await prisma.user.create({
      data: { email: 'coordinator@hackathon.local', passwordHash: await bcrypt.hash('coord123', 10), role: Role.COORDINATOR },
    });
    console.log('✅ Coordinator user created');
  } else {
    console.log('⏭️  Coordinator user exists');
  }

  console.log('\n✅ Seed complete — users only. Use Event Setup to configure everything else.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
