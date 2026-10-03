'use client';
import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/lib/auth-store';
import { useEventId } from '@/lib/event-store';

const API = process.env.NEXT_PUBLIC_API_URL || '';

const RANKING_FIELDS = `
  eventId trackId trackName status teamsRanked teamsWithIncompleteScores calculatedAt
  rankings {
    teamId teamName projectName trackName trackId
    rankPosition aggregatedScore judgeCount tieBreakNote judgeNames
    criterionAverages { criterionId criterionName average maxScore }
  }
`;

const RANKINGS_Q = `query Rankings($eventId: String!, $trackId: String) { rankings(eventId: $eventId, trackId: $trackId) { ${RANKING_FIELDS} } }`;
const CALCULATE_M = `mutation Calc($eventId: String!, $trackId: String) { calculateRankings(eventId: $eventId, trackId: $trackId) { ${RANKING_FIELDS} } }`;
const APPROVE_M = `mutation Approve($eventId: String!, $trackId: String) { approveRankings(eventId: $eventId, trackId: $trackId) { ${RANKING_FIELDS} } }`;
const PUBLISH_M = `mutation Publish($eventId: String!, $trackId: String) { publishRankings(eventId: $eventId, trackId: $trackId) { ${RANKING_FIELDS} } }`;
const EVENTS_Q = `query { events { id name status } }`;
const TRACKS_Q = `query Tracks($eventId: String!) { tracks(eventId: $eventId) { id name } }`;

async function gql(query: string, variables: any, token: string) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error((json.errors[0]?.message || 'GraphQL error').split('] ').pop());
  return json.data;
}

function medalStyle(rank: number) {
  if (rank === 1) return { bg: 'linear-gradient(135deg, #fbbf24, #f59e0b)', text: '#78350f' };
  if (rank === 2) return { bg: 'linear-gradient(135deg, #d1d5db, #9ca3af)', text: '#1f2937' };
  if (rank === 3) return { bg: 'linear-gradient(135deg, #d97706, #b45309)', text: '#fff' };
  return { bg: '#1e293b', text: '#94a3b8' };
}

const statusColors: Record<string, { bg: string; text: string }> = {
  PROVISIONAL: { bg: 'rgba(251,191,36,0.15)', text: '#fbbf24' },
  APPROVED: { bg: 'rgba(52,211,153,0.15)', text: '#34d399' },
  PUBLISHED: { bg: 'rgba(96,165,250,0.15)', text: '#60a5fa' },
  CALCULATING: { bg: 'rgba(167,139,250,0.15)', text: '#a78bfa' },
};

// ─── Methodology Modal ───
function MethodologyModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: '#0f172a', border: '1px solid #334155', borderRadius: 12,
        padding: '28px', maxWidth: 720, width: '92%', maxHeight: '85vh', overflowY: 'auto',
        color: '#e2e8f0',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: '#f1f5f9' }}>
              Scoring methodology
            </h2>
            <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>
              How indicative rankings are calculated
            </p>
          </div>
          <button type="button" onClick={onClose} style={{
            background: 'none', border: 'none', color: '#64748b', fontSize: 20, cursor: 'pointer', padding: '4px',
          }}>✕</button>
        </div>

        {/* Steps */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: '#94a3b8', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Calculation steps
          </h3>
          {[
            {
              num: '1',
              title: 'Collect submitted scorecards',
              desc: 'Only scorecards with status SUBMITTED, RESUBMITTED, or LOCKED are included. Drafts and not-started scorecards are excluded.',
            },
            {
              num: '2',
              title: 'Average each criterion across judges',
              desc: 'For each scoring criterion, compute the simple arithmetic mean across all judges who scored that team.',
              formula: 'criterion_avg = sum(all_judge_scores) / num_judges',
            },
            {
              num: '3',
              title: 'Sum criterion averages for team score',
              desc: 'The team\'s aggregated score is the sum of all criterion averages. Since criteria have different max scores (e.g. Impact /40 vs Feasibility /10), each criterion carries implicit weight proportional to its max score.',
              formula: 'team_score = innovation_avg + impact_avg + feasibility_avg + collaboration_avg + bonus_avg',
            },
            {
              num: '4',
              title: 'Rank by score, apply tie-breaks',
              desc: 'Teams ranked by aggregated score (descending). Tie-break 1: highest single criterion average. Tie-break 2: more judges scored = higher confidence.',
            },
            {
              num: '5',
              title: 'Mark as provisional',
              desc: 'Rankings start as PROVISIONAL. Admin can approve, then publish. All exports labeled "indicative — calibration done offline."',
            },
          ].map(step => (
            <div key={step.num} style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
              <div style={{
                width: 28, height: 28, borderRadius: 8, background: 'rgba(124,58,237,0.15)', color: '#a78bfa',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 500, flexShrink: 0,
              }}>{step.num}</div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: '#f1f5f9', marginBottom: 2 }}>{step.title}</div>
                <div style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.5 }}>{step.desc}</div>
                {step.formula && (
                  <div style={{
                    fontFamily: 'monospace', fontSize: 12, background: '#1e293b', padding: '6px 10px',
                    borderRadius: 6, marginTop: 6, color: '#a78bfa',
                  }}>{step.formula}</div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Scenario */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: '#94a3b8', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Example: 3 judges vs 5 judges
          </h3>
          <div style={{ background: '#1e293b', borderRadius: 8, padding: '14px', marginBottom: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#64748b' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Criterion</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>J1</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>J2</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>J3</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Avg</th>
                </tr>
              </thead>
              <tbody>
                <tr><td colSpan={5} style={{ fontSize: 11, color: '#64748b', padding: '8px 8px 2px' }}>Team Alpha — 3 judges</td></tr>
                {[['Innovation (/20)', '16', '14', '18', '16.0'], ['Impact (/40)', '32', '28', '36', '32.0'], ['Feasibility (/10)', '8', '7', '9', '8.0'], ['Collaboration (/20)', '15', '17', '16', '16.0'], ['Judge Bonus (/10)', '7', '8', '9', '8.0']].map(r => (
                  <tr key={r[0]}><td style={{ padding: '3px 8px', color: '#e2e8f0' }}>{r[0]}</td>{r.slice(1).map((v, i) => <td key={i} style={{ textAlign: 'right', padding: '3px 8px', fontFamily: 'monospace', color: '#e2e8f0' }}>{v}</td>)}</tr>
                ))}
                <tr style={{ borderTop: '1px solid #334155' }}><td style={{ padding: '6px 8px', fontWeight: 500, color: '#f1f5f9' }}>Total (/100)</td><td style={{ textAlign: 'right', padding: '6px 8px', fontFamily: 'monospace', color: '#f1f5f9' }}>78</td><td style={{ textAlign: 'right', padding: '6px 8px', fontFamily: 'monospace', color: '#f1f5f9' }}>74</td><td style={{ textAlign: 'right', padding: '6px 8px', fontFamily: 'monospace', color: '#f1f5f9' }}>88</td><td style={{ textAlign: 'right', padding: '6px 8px', fontFamily: 'monospace', fontWeight: 600, color: '#34d399' }}>80.0</td></tr>
              </tbody>
            </table>
          </div>

          <div style={{ background: '#1e293b', borderRadius: 8, padding: '14px', marginBottom: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#64748b' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Criterion</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>J1</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>J2</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>J3</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>J4</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>J5</th>
                  <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Avg</th>
                </tr>
              </thead>
              <tbody>
                <tr><td colSpan={7} style={{ fontSize: 11, color: '#64748b', padding: '8px 8px 2px' }}>Team Beta — 5 judges (includes harsh + lenient)</td></tr>
                {[['Innovation (/20)', '16', '14', '18', '10', '20', '15.6'], ['Impact (/40)', '32', '28', '36', '20', '38', '30.8'], ['Feasibility (/10)', '8', '7', '9', '5', '10', '7.8'], ['Collaboration (/20)', '15', '17', '16', '12', '18', '15.6'], ['Judge Bonus (/10)', '7', '8', '9', '4', '10', '7.6']].map(r => (
                  <tr key={r[0]}><td style={{ padding: '3px 8px', color: '#e2e8f0' }}>{r[0]}</td>{r.slice(1).map((v, i) => <td key={i} style={{ textAlign: 'right', padding: '3px 8px', fontFamily: 'monospace', color: '#e2e8f0' }}>{v}</td>)}</tr>
                ))}
                <tr style={{ borderTop: '1px solid #334155' }}><td style={{ padding: '6px 8px', fontWeight: 500, color: '#f1f5f9' }}>Total (/100)</td><td style={{ textAlign: 'right', padding: '6px 8px', fontFamily: 'monospace', color: '#f1f5f9' }}>78</td><td style={{ textAlign: 'right', padding: '6px 8px', fontFamily: 'monospace', color: '#f1f5f9' }}>74</td><td style={{ textAlign: 'right', padding: '6px 8px', fontFamily: 'monospace', color: '#f1f5f9' }}>88</td><td style={{ textAlign: 'right', padding: '6px 8px', fontFamily: 'monospace', color: '#f1f5f9' }}>51</td><td style={{ textAlign: 'right', padding: '6px 8px', fontFamily: 'monospace', color: '#f1f5f9' }}>96</td><td style={{ textAlign: 'right', padding: '6px 8px', fontFamily: 'monospace', fontWeight: 600, color: '#fbbf24' }}>77.4</td></tr>
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 13, color: '#94a3b8', padding: '10px 14px', background: 'rgba(251,191,36,0.05)', border: '1px solid rgba(251,191,36,0.15)', borderRadius: 8, lineHeight: 1.6 }}>
            Same first 3 judges gave identical scores. But Beta&apos;s 2 extra judges (one harsh at 51, one lenient at 96) pulled the average to 77.4. Alpha ranks higher at 80.0 despite fewer judges. This is why calibration is done offline.
          </div>
        </div>

        {/* What the system does NOT do */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: '#94a3b8', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Handled by offline calibration (not in this tool)
          </h3>
          {[
            { item: 'Judge tier weighting', detail: 'L3 (MEC) scores are not weighted more than L1 scores' },
            { item: 'Judge count normalization', detail: '3-judge average is treated the same as 5-judge average' },
            { item: 'Harshness adjustment', detail: 'Use the Judge Analytics export for each judge\'s harshness index (% deviation from global average)' },
            { item: 'Outlier removal', detail: 'All submitted scores are included equally — no automatic trimming' },
          ].map(r => (
            <div key={r.item} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0', borderBottom: '0.5px solid #1e293b', gap: 16 }}>
              <div style={{ fontSize: 13, color: '#f1f5f9', fontWeight: 500 }}>
                {r.item}
                <span style={{ marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>Offline</span>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', textAlign: 'right', flexShrink: 0, maxWidth: 300 }}>{r.detail}</div>
            </div>
          ))}
        </div>

        {/* Available exports */}
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, fontWeight: 500, color: '#94a3b8', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Exports for calibration
          </h3>
          {[
            { name: 'Raw scores', desc: 'One row per judge per team per criterion — full audit trail with comments' },
            { name: 'Score summary', desc: 'One row per scorecard with all criteria as columns, overall comments' },
            { name: 'Team aggregates', desc: 'Per-team avg / min / max / std dev per criterion — shows scoring consistency' },
            { name: 'Judge analytics', desc: 'Per-judge avg, range, harshness index — identifies harsh or lenient scorers' },
            { name: 'Rankings', desc: 'Indicative leaderboard with judge names — clearly labeled as pre-calibration' },
          ].map(r => (
            <div key={r.name} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '0.5px solid #1e293b' }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: '#60a5fa', width: 130, flexShrink: 0 }}>{r.name}</span>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>{r.desc}</span>
            </div>
          ))}
        </div>

        <button type="button"
          onClick={onClose}
          style={{
            width: '100%', padding: '10px', borderRadius: 8, fontSize: 14, fontWeight: 500,
            background: '#3b82f6', color: '#fff', border: 'none', cursor: 'pointer',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ───
export default function RankingsPage() {
  const token = useAuthStore((s) => s.token);
  const selectedEventId = useEventId();
  const [eventId, setEventId] = useState('');
  const [events, setEvents] = useState<any[]>([]);
  const [tracks, setTracks] = useState<any[]>([]);
  const [selectedTrack, setSelectedTrack] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null);
  const [showMethodology, setShowMethodology] = useState(false);

  useEffect(() => {
    if (!token) return;
    gql(EVENTS_Q, {}, token).then(d => {
      const evts = d.events || [];
      setEvents(evts);
      if (evts.length > 0 && !eventId) {
        const preferred = evts.some((e: any) => e.id === selectedEventId)
          ? selectedEventId
          : evts[0].id;
        setEventId(preferred);
      }
    }).catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!token || !eventId) return;
    gql(TRACKS_Q, { eventId }, token).then(d => setTracks(d.tracks || [])).catch(() => {});
  }, [token, eventId]);

  const fetchRankings = useCallback(async () => {
    if (!token || !eventId) return;
    setLoading(true);
    setError('');
    try {
      const vars: any = { eventId };
      if (selectedTrack) vars.trackId = selectedTrack;
      const d = await gql(RANKINGS_Q, vars, token);
      setData(d.rankings);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token, eventId, selectedTrack]);

  useEffect(() => { fetchRankings(); }, [fetchRankings]);

  const runMutation = async (query: string, key: string) => {
    if (!token || !eventId) return;
    setLoading(true);
    setError('');
    try {
      const vars: any = { eventId };
      if (selectedTrack) vars.trackId = selectedTrack;
      const d = await gql(query, vars, token);
      setData(d[key]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const downloadExport = async (endpoint: string, fallbackName: string) => {
    if (!token || !eventId) return;
    try {
      const url = `${API}/api/export/${endpoint}?eventId=${eventId}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      const disposition = res.headers.get('content-disposition');
      a.download = disposition?.split('filename=')[1]?.replace(/"/g, '') || `${fallbackName}.csv`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch (e: any) {
      setError(`Export failed: ${e.message}`);
    }
  };

  const exportAllData = async () => {
    for (const exp of [
      { endpoint: 'scores-raw', name: 'raw_scores' },
      { endpoint: 'scores', name: 'score_summary' },
      { endpoint: 'team-aggregates', name: 'team_aggregates' },
      { endpoint: 'judge-analytics', name: 'judge_analytics' },
      { endpoint: 'schedule', name: 'schedule' },
    ]) {
      await downloadExport(exp.endpoint, exp.name);
      await new Promise(r => setTimeout(r, 500));
    }
  };

  const exportRankingsCSV = () => {
    if (!data?.rankings?.length) return;
    const rows = data.rankings;
    const crits = rows[0]?.criterionAverages || [];
    const maxTotal = crits.reduce((s: number, c: any) => s + c.maxScore, 0);
    const header = [
      'Rank', 'Team', 'Project', 'Track', 'Judges', 'Judge Names',
      ...crits.map((c: any) => `${c.criterionName} (/${c.maxScore})`),
      'Total Score', 'Max Possible', 'Score %', 'Note',
    ];
    const csv = [
      header.join(','),
      ...rows.map((r: any) =>
        [
          r.rankPosition, `"${r.teamName}"`, `"${r.projectName}"`, `"${r.trackName || ''}"`,
          r.judgeCount, `"${r.judgeNames || ''}"`,
          ...r.criterionAverages.map((c: any) => c.average.toFixed(1)),
          r.aggregatedScore.toFixed(1), maxTotal,
          maxTotal > 0 ? ((r.aggregatedScore / maxTotal) * 100).toFixed(1) : '',
          '"Indicative - calibration done offline"',
        ].join(',')
      ),
    ].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rankings_${selectedTrack ? 'track' : 'overall'}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const rankings = data?.rankings || [];
  const status = data?.status;
  const sc = statusColors[status] || statusColors.CALCULATING;

  return (
    <div style={{ color: '#e2e8f0' }}>
      {/* Methodology modal */}
      {showMethodology && <MethodologyModal onClose={() => setShowMethodology(false)} />}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Rankings</h1>
            <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>
              Indicative leaderboard — final calibration done offline
            </p>
          </div>
          <button type="button"
            onClick={() => setShowMethodology(true)}
            title="Scoring methodology"
            style={{
              width: 28, height: 28, borderRadius: '50%', border: '1px solid #334155',
              background: 'rgba(100,116,139,0.1)', color: '#94a3b8', fontSize: 14, fontWeight: 600,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginTop: -4,
            }}
          >
            ?
          </button>
        </div>
        <select
          value={eventId}
          onChange={e => { setEventId(e.target.value); setSelectedTrack(null); setData(null); }}
          style={{ background: '#1e293b', color: '#e2e8f0', border: '1px solid #334155', borderRadius: 8, padding: '8px 12px', fontSize: 13 }}
        >
          {events.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>

      {/* Track tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, flexWrap: 'wrap' }}>
        <button type="button" onClick={() => setSelectedTrack(null)}
          style={{ padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: 'none',
            background: selectedTrack === null ? 'rgba(96,165,250,0.15)' : 'transparent',
            color: selectedTrack === null ? '#60a5fa' : '#94a3b8' }}>
          Overall
        </button>
        {tracks.map(t => (
          <button type="button" key={t.id} onClick={() => setSelectedTrack(t.id)}
            style={{ padding: '7px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: 'none',
              background: selectedTrack === t.id ? 'rgba(96,165,250,0.15)' : 'transparent',
              color: selectedTrack === t.id ? '#60a5fa' : '#94a3b8' }}>
            {t.name}
          </button>
        ))}
      </div>

      {/* Action bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: '#0f172a', borderRadius: 10, padding: '12px 16px', marginBottom: 16, border: '1px solid #1e293b',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {data && <span style={{ background: sc.bg, color: sc.text, padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500 }}>{status}</span>}
          {data && (
            <span style={{ fontSize: 12, color: '#64748b' }}>
              {data.teamsRanked} teams ranked
              {data.teamsWithIncompleteScores > 0 && <span style={{ color: '#f59e0b', marginLeft: 8 }}>⚠ {data.teamsWithIncompleteScores} incomplete</span>}
            </span>
          )}
          {data?.calculatedAt && (
            <span style={{ fontSize: 12, color: '#475569' }}>
              {new Date(data.calculatedAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore' })}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {rankings.length > 0 && (
            <>
              <button type="button" onClick={exportAllData}
                style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                  background: 'rgba(52,211,153,0.15)', color: '#34d399', border: '1px solid rgba(52,211,153,0.3)', cursor: 'pointer' }}>
                Export All Data
              </button>
              <button type="button" onClick={exportRankingsCSV}
                style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                  background: 'rgba(100,116,139,0.15)', color: '#94a3b8', border: '1px solid rgba(100,116,139,0.3)', cursor: 'pointer' }}>
                Export Rankings
              </button>
            </>
          )}
          <button type="button" onClick={() => runMutation(CALCULATE_M, 'calculateRankings')} disabled={loading}
            style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
              background: 'rgba(124,58,237,0.15)', color: '#a78bfa', border: '1px solid rgba(124,58,237,0.3)',
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.5 : 1 }}>
            {loading ? 'Calculating...' : data ? 'Recalculate' : 'Calculate rankings'}
          </button>
          {status === 'PROVISIONAL' && (
            <button type="button" onClick={() => runMutation(APPROVE_M, 'approveRankings')} disabled={loading}
              style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                background: 'rgba(52,211,153,0.15)', color: '#34d399', border: '1px solid rgba(52,211,153,0.3)', cursor: 'pointer' }}>
              Approve
            </button>
          )}
          {status === 'APPROVED' && (
            <button type="button" onClick={() => { if (confirm('Publish these rankings? This makes them final.')) runMutation(PUBLISH_M, 'publishRankings'); }} disabled={loading}
              style={{ padding: '8px 16px', borderRadius: 8, fontSize: 13, fontWeight: 500,
                background: 'rgba(96,165,250,0.15)', color: '#60a5fa', border: '1px solid rgba(96,165,250,0.3)', cursor: 'pointer' }}>
              Publish
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#f87171', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {error}
          <button type="button" onClick={() => setError('')} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* Empty state */}
      {!data && !loading && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#475569' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
          <p style={{ fontSize: 15, marginBottom: 4 }}>No rankings calculated yet</p>
          <p style={{ fontSize: 13 }}>Click "Calculate rankings" to generate provisional results from submitted scorecards</p>
        </div>
      )}

      {/* Rankings table */}
      {rankings.length > 0 && (
        <div style={{ borderRadius: 10, border: '1px solid #1e293b', overflow: 'hidden' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '60px 1fr 180px 140px 100px 80px',
            padding: '10px 16px', background: '#0f172a',
            fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>
            <span>Rank</span><span>Team</span><span>Judges</span>
            <span style={{ textAlign: 'right' }}>Score</span>
            <span style={{ textAlign: 'center' }}>Count</span>
            <span style={{ textAlign: 'center' }}>Details</span>
          </div>

          {rankings.map((r: any) => {
            const medal = medalStyle(r.rankPosition);
            const isExpanded = expandedTeam === r.teamId;
            const maxTotal = r.criterionAverages?.reduce((s: number, c: any) => s + c.maxScore, 0) || 100;

            return (
              <div key={r.teamId}>
                <div style={{
                  display: 'grid', gridTemplateColumns: '60px 1fr 180px 140px 100px 80px',
                  padding: '14px 16px', alignItems: 'center', borderTop: '1px solid #1e293b',
                  background: isExpanded ? 'rgba(30,41,59,0.5)' : 'transparent', transition: 'background 0.15s',
                }}>
                  <div>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 32, height: 32, borderRadius: 8, background: medal.bg, color: medal.text, fontSize: 14, fontWeight: 700,
                    }}>{r.rankPosition}</span>
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: '#f1f5f9' }}>{r.teamName}</div>
                    <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                      {r.projectName}
                      {r.trackName && <span style={{ marginLeft: 8, background: 'rgba(100,116,139,0.15)', padding: '1px 6px', borderRadius: 4, fontSize: 11 }}>{r.trackName}</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.5 }}>{r.judgeNames || '—'}</div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ fontSize: 18, fontWeight: 600, color: '#f1f5f9' }}>{r.aggregatedScore.toFixed(1)}</span>
                    <span style={{ fontSize: 12, color: '#475569', marginLeft: 2 }}>/{maxTotal}</span>
                    {r.tieBreakNote && <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 2 }}>TIE</div>}
                  </div>
                  <div style={{ textAlign: 'center', fontSize: 13, color: '#94a3b8' }}>{r.judgeCount}</div>
                  <div style={{ textAlign: 'center' }}>
                    <button type="button" onClick={() => setExpandedTeam(isExpanded ? null : r.teamId)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', fontSize: 18,
                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                      ▾
                    </button>
                  </div>
                </div>

                {isExpanded && r.criterionAverages?.length > 0 && (
                  <div style={{ padding: '0 16px 16px 76px', background: 'rgba(30,41,59,0.3)', borderTop: '1px solid rgba(30,41,59,0.5)' }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '12px 0 8px' }}>
                      Criterion breakdown (averaged across {r.judgeCount} judge{r.judgeCount !== 1 ? 's' : ''})
                    </div>
                    {r.criterionAverages.map((ca: any) => {
                      const pct = ca.maxScore > 0 ? (ca.average / ca.maxScore) * 100 : 0;
                      return (
                        <div key={ca.criterionId} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                          <span style={{ fontSize: 13, color: '#94a3b8', width: 200, flexShrink: 0 }}>{ca.criterionName}</span>
                          <div style={{ flex: 1, height: 6, background: '#1e293b', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ height: '100%', borderRadius: 3, width: `${Math.min(pct, 100)}%`,
                              background: pct >= 80 ? '#34d399' : pct >= 50 ? '#fbbf24' : '#f87171', transition: 'width 0.3s' }} />
                          </div>
                          <span style={{ fontSize: 13, fontWeight: 500, color: '#e2e8f0', width: 70, textAlign: 'right', flexShrink: 0 }}>
                            {ca.average.toFixed(1)} / {ca.maxScore}
                          </span>
                        </div>
                      );
                    })}
                    {r.tieBreakNote && <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 8, fontStyle: 'italic' }}>{r.tieBreakNote}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
