'use client';

import { useQuery } from '@/lib/use-graphql';
import { CONFLICTS_QUERY, EVENTS_QUERY } from '@/lib/queries';
import DataTable from '@/components/data-table';
import StatusBadge from '@/components/status-badge';

export default function ConflictsPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const eventId = evData?.events?.[0]?.id;
  const { data, loading } = useQuery<any>(CONFLICTS_QUERY, eventId ? { eventId } : undefined);

  const columns = [
    { key: 'judgeName', label: 'Judge' },
    { key: 'teamName', label: 'Team' },
    { key: 'reason', label: 'Reason' },
    { key: 'source', label: 'Source', render: (r: any) => r.source === 'SELF_DECLARED' ? 'Self' : 'Admin' },
    { key: 'status', label: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
  ];

  return (
    <div>
      <h1 className="text-lg font-semibold text-white">Conflict Declarations</h1>
      <p className="mt-1 mb-6 text-sm text-slate-400">{data?.conflicts?.length || 0} conflicts declared</p>
      <DataTable columns={columns} data={data?.conflicts || []} loading={loading || !eventId} />
    </div>
  );
}
