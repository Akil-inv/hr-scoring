'use client';

import { useEffect, useState } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { CandidateReport, REPORT_CSS } from '@/components/candidate-report';
import { CandidateRecord, ReviewData } from '@/lib/review';

/**
 * Loads the review data and renders one or more candidate reports, with a
 * toolbar to save them as PDF. Outside the dashboard layout so the printout
 * carries nothing but the report.
 */
export default function ReportView({ eventId, sessionId, date }: { eventId: string; sessionId?: string; date?: string }) {
  const token = useAuthStore((s) => s.token);
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { setError('Sign in first, then open the report again.'); return; }
    fetch(`/api/review/${eventId}${date ? `?date=${date}` : ''}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof body?.message === 'string' ? body.message : `Could not load (${res.status}).`);
        setData(body);
      })
      .catch((e) => setError(e.message));
  }, [eventId, date, token]);

  const records: CandidateRecord[] = !data ? [] : sessionId
    ? data.records.filter((r) => r.sessionId === sessionId)
    : data.records.filter((r) => !date || r.date === date).sort((a, b) => a.start.localeCompare(b.start));

  useEffect(() => {
    if (records.length === 1) document.title = `${records[0].name} — assessment report`;
    else if (date) document.title = `Assessment reports — ${date}`;
  }, [records, date]);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: REPORT_CSS }} />
      <div className="rp-toolbar">
        {error ? <span>{error}</span> : !data ? <span>Loading…</span> : records.length === 0 ? <span>Nothing to show.</span> : (
          <>
            <span>{records.length === 1 ? records[0].name : `${records.length} candidates`}</span>
            <button type="button" onClick={() => window.print()}>Save as PDF</button>
          </>
        )}
      </div>
      {data && records.map((r) => <CandidateReport key={r.sessionId} data={data} r={r} />)}
    </>
  );
}
