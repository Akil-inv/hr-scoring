'use client';

import { useQuery } from '@/lib/use-graphql';
import { AUDIT_LOGS_QUERY, EVENTS_QUERY } from '@/lib/queries';
import StatusBadge from '@/components/status-badge';

export default function AuditPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const eventId = evData?.events?.[0]?.id;
  const { data, loading } = useQuery<any>(AUDIT_LOGS_QUERY, eventId ? { eventId, take: 50, skip: 0 } : undefined);

  const logs = data?.auditLogsByEvent || [];

  if (loading || !eventId) {
    return <div className="py-12 text-center text-sm text-slate-400">Loading...</div>;
  }

  return (
    <div>
      <h1 className="text-lg font-semibold text-white">Audit Log</h1>
      <p className="mt-1 mb-6 text-sm text-slate-400">Recent {logs.length} entries</p>

      <div className="space-y-2">
        {logs.map((log: any) => (
          <div key={log.id} className="rounded-lg border border-border bg-white px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <StatusBadge status={log.action} />
                <span className="text-sm font-medium text-white">{log.entityType}</span>
                <span className="text-xs text-slate-400 font-mono">{log.entityId.substring(0, 8)}...</span>
              </div>
              <div className="flex items-center gap-3 text-xs text-slate-400">
                <span>{log.user?.email}</span>
                <span>{new Date(log.createdAt).toLocaleString()}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
