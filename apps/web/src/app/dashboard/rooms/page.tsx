'use client';

import { useQuery } from '@/lib/use-graphql';
import { ROOMS_QUERY, TIMESLOTS_QUERY, EVENTS_QUERY } from '@/lib/queries';
import DataTable from '@/components/data-table';
import StatusBadge from '@/components/status-badge';

export default function RoomsPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const eventId = evData?.events?.[0]?.id;
  const { data: roomData, loading: roomsLoading } = useQuery<any>(ROOMS_QUERY, eventId ? { eventId } : undefined);
  const { data: slotData } = useQuery<any>(TIMESLOTS_QUERY, eventId ? { eventId } : undefined);

  const roomColumns = [
    { key: 'name', label: 'Room' },
    { key: 'capacity', label: 'Capacity', render: (r: any) => r.capacity || '—' },
    { key: 'isVirtual', label: 'Type', render: (r: any) => r.isVirtual ? 'Virtual' : 'Physical' },
    { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
  ];

  const slots = slotData?.timeSlots || [];
  const judgingSlots = slots.filter((s: any) => s.slotType === 'JUDGING').length;
  const dates = [...new Set(slots.map((s: any) => new Date(s.date).toLocaleDateString()))];

  return (
    <div>
      <h1 className="text-lg font-semibold text-white">Rooms & Time Slots</h1>
      <p className="mt-1 mb-6 text-sm text-slate-400">
        {roomData?.rooms?.length || 0} rooms · {judgingSlots} judging slots across {dates.length} day(s)
      </p>
      <DataTable columns={roomColumns} data={roomData?.rooms || []} loading={roomsLoading || !eventId} />

      {dates.length > 0 && (
        <div className="mt-6">
          <h2 className="text-sm font-medium text-white mb-3">Time Slots</h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {dates.map((date: string) => {
              const daySlots = slots.filter((s: any) => new Date(s.date).toLocaleDateString() === date);
              return (
                <div key={date} className="rounded-lg border border-border bg-white p-4">
                  <h3 className="text-sm font-medium text-white mb-2">{date}</h3>
                  <div className="space-y-1">
                    {daySlots.map((s: any) => (
                      <div key={s.id} className="flex items-center justify-between text-xs">
                        <span className="text-slate-400">
                          {new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – {new Date(s.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <StatusBadge status={s.slotType} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
