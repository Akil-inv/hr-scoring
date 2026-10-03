import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, SlotType } from '@prisma/client';
import { GenerateTimeSlotsInput } from './rooms.types';

@Injectable()
export class TimeSlotsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * Get UTC offset string (e.g. '+08:00') for an IANA timezone.
   * Uses a reference date to determine the offset.
   */
  private getTimezoneOffset(timezone: string, refDate: Date): string {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        timeZoneName: 'shortOffset',
      });
      const parts = formatter.formatToParts(refDate);
      const tzPart = parts.find(p => p.type === 'timeZoneName');
      if (tzPart) {
        // Converts "GMT+8" or "GMT+5:30" to "+08:00" or "+05:30"
        const match = tzPart.value.match(/GMT([+-]?)(\d{1,2})(?::(\d{2}))?/);
        if (match) {
          const sign = match[1] || '+';
          const hours = match[2].padStart(2, '0');
          const minutes = match[3] || '00';
          return `${sign}${hours}:${minutes}`;
        }
      }
    } catch (e) {
      // Fallback to +08:00 for Asia/Singapore
    }
    return '+08:00';
  }

  async generate(input: GenerateTimeSlotsInput, userId: string) {
    const { eventId, date, operatingStart, operatingEnd, lunchStart, lunchEnd } = input;

    // Room availability is deliberately not touched here. It is a property of a
    // room and a date, edited on its own, and regenerating a day should not
    // silently discard it.

    // Fetch event timezone and session duration. Session duration is owned by
    // the event and is the single source of truth: slots are always cut to the
    // event's configured length, never to a value re-typed on the generation
    // form. input.sessionDurationMinutes is accepted for backward compatibility
    // but deliberately ignored — that duplicate input is what let the two drift.
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { timezone: true, sessionDurationMinutes: true },
    });
    if (!event) throw new BadRequestException('Event not found');
    const timezone = event.timezone || 'Asia/Singapore';
    const sessionDurationMinutes = event.sessionDurationMinutes;
    if (!sessionDurationMinutes || sessionDurationMinutes <= 0) {
      throw new BadRequestException(
        'Event has no valid session duration; set it in event setup before generating slots',
      );
    }

    // No break between sessions. Slots run back-to-back so the grid reflects the
    // event's session duration exactly, and the organizer controls timing solely
    // through that one value. input.breakDurationMinutes is accepted for backward
    // compatibility but deliberately ignored.
    const breakDurationMinutes = 0;

    // Get the date string in YYYY-MM-DD format
    const dateStr = new Date(date).toLocaleDateString('en-CA', { timeZone: 'UTC' });

    // Calculate UTC offset for this timezone on this date
    const refDate = new Date(dateStr + 'T12:00:00Z');
    const utcOffset = this.getTimezoneOffset(timezone, refDate);

    // Parse a time string (HH:MM) into a Date in the event's timezone
    const parseTime = (timeStr: string): Date => {
      return new Date(`${dateStr}T${timeStr}:00${utcOffset}`);
    };

    // Midnight UTC, not local. `date` is a date-only column, so Postgres
    // truncates in UTC — using the event offset here stores the previous day.
    const slotDate = new Date(`${dateStr}T00:00:00Z`);

    const opStart = parseTime(operatingStart);
    const opEnd = parseTime(operatingEnd);
    const lunchStartTime = lunchStart ? parseTime(lunchStart) : null;
    const lunchEndTime = lunchEnd ? parseTime(lunchEnd) : null;

    if (opStart >= opEnd) throw new BadRequestException('Operating start must be before end');
    if (lunchStartTime && lunchEndTime && lunchStartTime >= lunchEndTime) {
      throw new BadRequestException('Lunch start must be before lunch end');
    }

    // Delete existing slots for this date
    await this.prisma.timeSlot.deleteMany({
      where: { eventId, date: slotDate },
    });

    const slots: Array<{ eventId: string; date: Date; startTime: Date; endTime: Date; slotType: SlotType }> = [];
    let cursor = new Date(opStart);

    while (cursor < opEnd) {
      const slotEnd = new Date(cursor.getTime() + sessionDurationMinutes * 60000);

      // Check if we're in lunch
      if (lunchStartTime && lunchEndTime && cursor < lunchEndTime && slotEnd > lunchStartTime) {
        if (cursor <= lunchStartTime) {
          slots.push({
            eventId, date: slotDate,
            startTime: new Date(lunchStartTime),
            endTime: new Date(lunchEndTime),
            slotType: SlotType.LUNCH,
          });
        }
        cursor = new Date(lunchEndTime);
        continue;
      }

      if (slotEnd > opEnd) break;

      // Add judging slot
      slots.push({
        eventId, date: slotDate,
        startTime: new Date(cursor),
        endTime: new Date(slotEnd),
        slotType: SlotType.JUDGING,
      });

      // Add break after session
      const breakEnd = new Date(slotEnd.getTime() + breakDurationMinutes * 60000);
      if (breakDurationMinutes > 0 && breakEnd <= opEnd) {
        slots.push({
          eventId, date: slotDate,
          startTime: new Date(slotEnd),
          endTime: new Date(breakEnd),
          slotType: SlotType.BREAK,
        });
        cursor = breakEnd;
      } else {
        cursor = slotEnd;
      }
    }

    await this.prisma.timeSlot.createMany({ data: slots });

    await this.audit.log({
      userId, eventId,
      action: AuditAction.CREATE, entityType: 'TimeSlot',
      entityId: `batch-${dateStr}`,
      newValues: { date: dateStr, timezone, utcOffset, slotCount: slots.length },
    });

    return this.prisma.timeSlot.findMany({
      where: { eventId, date: slotDate },
      orderBy: { startTime: 'asc' },
    });
  }

  async findByEventAndDate(eventId: string, date: Date) {
    return this.prisma.timeSlot.findMany({
      where: { eventId, date },
      orderBy: { startTime: 'asc' },
    });
  }

  /**
   * Mark a room available or not for one half-day.
   *
   * Independent of slot generation. Availability is a property of a room and a
   * date; tying it to generation meant a coordinator could only change it by
   * regenerating, and any edit made afterwards was silently lost.
   */
  async setRoomAvailability(
    eventId: string,
    roomId: string,
    date: Date,
    session: string,
    unavailable: boolean,
    userId: string,
  ) {
    const day = new Date(new Date(date).toISOString().split('T')[0]);
    const sess = session.toUpperCase() === 'PM' ? 'PM' : 'AM';

    if (unavailable) {
      await this.prisma.roomUnavailability.upsert({
        where: { roomId_date_session: { roomId, date: day, session: sess } },
        create: { roomId, eventId, date: day, session: sess },
        update: {},
      });
    } else {
      await this.prisma.roomUnavailability.deleteMany({
        where: { roomId, date: day, session: sess },
      });
    }

    await this.audit.log({
      userId, eventId,
      action: AuditAction.UPDATE, entityType: 'Room', entityId: roomId,
      newValues: { date: day.toISOString().split('T')[0], session: sess, unavailable },
    });

    return { success: true };
  }

  /** What is stored, so the form can show it rather than the last thing typed. */
  async unavailabilityByEvent(eventId: string) {
    return this.prisma.roomUnavailability.findMany({
      where: { eventId },
      orderBy: [{ date: 'asc' }, { session: 'asc' }],
    });
  }

  async findAllByEvent(eventId: string) {
    return this.prisma.timeSlot.findMany({
      where: { eventId },
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    });
  }
}
