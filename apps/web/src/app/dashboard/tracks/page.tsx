'use client';

import { useQuery } from '@/lib/use-graphql';
import { useEventId } from '@/lib/event-store';
import { TRACKS_QUERY } from '@/lib/queries';
import DataTable from '@/components/data-table';
import StatusBadge from '@/components/status-badge';

export default function TracksPage() {
  // The event chosen in the sidebar.
  const eventId = useEventId();
  const { data, loading } = useQuery<any>(TRACKS_QUERY, eventId ? { eventId } : undefined);

  const columns = [
    { key: 'name', label: 'Track' },
    { key: 'description', label: 'Description', render: (r: any) => r.description || '—' },
    { key: 'teamCount', label: 'Teams' },
    { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div>
      <h1 className="text-lg font-semibold text-white">Challenge Tracks</h1>
      <p className="mt-1 mb-6 text-sm text-slate-400">{data?.tracks?.length || 0} tracks configured</p>
      <DataTable columns={columns} data={data?.tracks || []} loading={loading || !eventId} />
    </div>
  );
}
