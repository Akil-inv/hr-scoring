import { Injectable, ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  /**
   * A new account, without a password: the admin then copies its invite link
   * (auth-kit), with which the person chooses their own password.
   */
  async createUser(input: { email: string; name: string; phone?: string; globalRole?: string }) {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Enter a valid email address.');
    const existing = await this.prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
    if (existing) throw new ConflictException('Email already registered');
    return this.prisma.user.create({
      data: { email, passwordHash: '', name: input.name || '', phone: input.phone || null, role: (input.globalRole as any) || 'COORDINATOR' },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
  }

  async listUsers() {
    return this.prisma.user.findMany({
      // Deleted accounts that had to be kept (anonymised) for their records.
      where: { NOT: { email: { endsWith: '@deleted.invalid' } } },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Everyone holding a role on one event.
   *
   * Without this the Users page can assign roles but never read them back, so
   * the role column shows no current state and reassigning is guesswork.
   */
  async listEventUsers(eventId: string) {
    const rows = await this.prisma.eventUser.findMany({
      where: { eventId },
      include: { user: { select: { id: true, email: true, name: true, role: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((eu: any) => ({
      userId: eu.user.id,
      email: eu.user.email,
      name: eu.user.name,
      globalRole: eu.user.role,
      role: eu.role,
    }));
  }

  async assignToEvent(userId: string, eventId: string, role: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return this.prisma.eventUser.upsert({
      where: { userId_eventId: { userId, eventId } },
      create: { userId, eventId, role: role as any },
      update: { role: role as any },
    });
  }

  async removeFromEvent(userId: string, eventId: string) {
    return this.prisma.eventUser.delete({ where: { userId_eventId: { userId, eventId } } });
  }

  async getMyEvents(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.role === 'SUPER_ADMIN') {
      const events = await this.prisma.event.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true, name: true, status: true, startDate: true, endDate: true } });
      return events.map((e: any) => ({ ...e, role: 'ADMIN' }));
    }
    const eventUsers = await this.prisma.eventUser.findMany({
      where: { userId },
      include: { event: { select: { id: true, name: true, status: true, startDate: true, endDate: true } } },
    });
    return eventUsers.map((eu: any) => ({ ...eu.event, role: eu.role }));
  }

}
