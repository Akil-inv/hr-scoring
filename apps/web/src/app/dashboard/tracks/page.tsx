'use client';

import { useQuery } from '@/lib/use-graphql';
import { TRACKS_QUERY, EVENTS_QUERY } from '@/lib/queries';
import DataTable from '@/components/data-table';
import StatusBadge from '@/components/status-badge';

export default function TracksPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const eventId = evData?.events?.[0]?.id;
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
