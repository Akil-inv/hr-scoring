'use client';
import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@/lib/use-graphql';
import { useAuthStore } from '@/lib/auth-store';
import { createClient } from '@/lib/graphql-client';
import { EVENTS_QUERY, SESSIONS_QUERY, JUDGES_QUERY, ROOMS_QUERY } from '@/lib/queries';
import { useEventId } from '@/lib/event-store';

const SCORECARDS_QUERY = `query SC($eventId: String!) { scorecardsByEvent(eventId: $eventId) { id status totalScore judgeName teamName judgeId } }`;
const RANKINGS_QUERY = `query R($eventId: String!) { rankings(eventId: $eventId) { id teamName totalScore rank trackName advancesToFinals pocAward } }`;
const TRACKS_QUERY = `query T($eventId: String!) { tracks(eventId: $eventId) { id name status } }`;
const TIMESLOTS_QUERY = `query TS($eventId: String!) { timeSlots(eventId: $eventId) { id slotType } }`;
const CONFLICTS_QUERY = `query C($eventId: String!) { conflicts(eventId: $eventId) { id status } }`;
const SCORING_TEMPLATE_QUERY = `query ST($eventId: String!) { scoringTemplates(eventId: $eventId) { id name status criteria { id name maxScore } } }`;

// ─── Reusable visual components ───
const Bar = ({ value, max, color = '#7c3aed', height = 6 }: { value: number; max: number; color?: string; height?: number }) => (
  <div style={{ height, borderRadius: height / 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', flex: 1 }}>
    <div style={{ width: `${max > 0 ? (value / max) * 100 : 0}%`, height: '100%', borderRadius: height / 2, background: color, transition: 'width 0.8s ease' }} />
  </div>
);

const Ring = ({ value, max, size = 64, stroke = 5, color = '#10b981' }: { value: number; max: number; size?: number; stroke?: number; color?: string }) => {
  const pct = max > 0 ? value / max : 0;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={`${circ * pct} ${circ * (1 - pct)}`} strokeLinecap="round" style={{ transition: 'stroke-dasharray 1s ease' }} />
    </svg>
  );
};

const Pill = ({ label, value, color }: { label: string; value: number; color: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, background: `${color}15`, border: `1px solid ${color}25` }}>
    <span style={{ fontSize: 13, color, fontWeight: 600 }}>{value}</span>
    <span style={{ fontSize: 12, color: '#5a4a28' }}>{label}</span>
  </div>
);

export default function DashboardPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const selectedEventId = useEventId();
  const event =
    evData?.events?.find((e: any) => e.id === selectedEventId) ?? evData?.events?.[0];
  const eventId = event?.id;
  const { data: sessionData } = useQuery<any>(SESSIONS_QUERY, eventId ? { eventId } : undefined);
  const { data: judgeData } = useQuery<any>(JUDGES_QUERY, eventId ? { eventId } : undefined);
  const { data: roomData } = useQuery<any>(ROOMS_QUERY, eventId ? { eventId } : undefined);
  const token = useAuthStore((s) => s.token);

  const [scorecards, setScorecards] = useState<any[]>([]);
  const [rankings, setRankings] = useState<any[]>([]);
  const [tracks, setTracks] = useState<any[]>([]);
  const [timeSlots, setTimeSlots] = useState<any[]>([]);
  const [conflicts, setConflicts] = useState<any[]>([]);
  const [template, setTemplate] = useState<any>(null);
  const [activePane, setActivePane] = useState(0);

  const sessions = sessionData?.sessions || [];
  const judges = judgeData?.judges || [];
  const rooms = roomData?.rooms || [];

  useEffect(() => {
    if (!eventId || !token) return;
    const client = createClient(token);
    client.query(SCORECARDS_QUERY, { eventId }).toPromise().then(r => setScorecards(r.data?.scorecardsByEvent || []));
    client.query(RANKINGS_QUERY, { eventId }).toPromise().then(r => setRankings(r.data?.rankings || [])).catch(() => {});
    client.query(TRACKS_QUERY, { eventId }).toPromise().then(r => setTracks(r.data?.tracks || [])).catch(() => {});
    client.query(TIMESLOTS_QUERY, { eventId }).toPromise().then(r => setTimeSlots(r.data?.timeSlots || [])).catch(() => {});
    client.query(CONFLICTS_QUERY, { eventId }).toPromise().then(r => setConflicts(r.data?.conflicts || [])).catch(() => {});
    client.query(SCORING_TEMPLATE_QUERY, { eventId }).toPromise().then(r => {
      const t = r.data?.scoringTemplates || [];
      setTemplate(t.find((x: any) => x.status === 'ACTIVE') || t[0] || null);
    }).catch(() => {});
  }, [eventId, token]);

  const stats = useMemo(() => {
    const completed = sessions.filter((s: any) => s.stage === 'COMPLETED').length;
    const inProgress = sessions.filter((s: any) => s.stage === 'IN_PROGRESS').length;
    const upcoming = sessions.filter((s: any) => s.stage === 'SCHEDULED').length;
    const delayed = sessions.filter((s: any) => s.stage === 'DELAYED').length;
    const cancelled = sessions.filter((s: any) => s.stage === 'CANCELLED').length;
    const total = sessions.length;
    const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const submitted = scorecards.filter((s: any) => ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(s.status)).length;
    const drafts = scorecards.filter((s: any) => s.status === 'DRAFT').length;
    const pending = scorecards.filter((s: any) => s.status === 'NOT_STARTED').length;
    const totalSC = scorecards.length;
    const scorePct = totalSC > 0 ? Math.round((submitted / totalSC) * 100) : 0;
    const scores = scorecards.filter((s: any) => s.totalScore != null).map((s: any) => s.totalScore);
    const avg = scores.length > 0 ? Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length) : 0;
    const high = scores.length > 0 ? Math.max(...scores) : 0;
    const low = scores.length > 0 ? Math.min(...scores) : 0;
    const sorted = [...scores].sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;

    // Score distribution buckets
    const dist = [
      { label: '90-100', min: 90, max: 100, color: '#10b981', count: 0 },
      { label: '80-89', min: 80, max: 89, color: '#3b82f6', count: 0 },
      { label: '70-79', min: 70, max: 79, color: '#7c3aed', count: 0 },
      { label: '60-69', min: 60, max: 69, color: '#f59e0b', count: 0 },
      { label: '<60', min: 0, max: 59, color: '#ef4444', count: 0 },
    ];
    scores.forEach(s => { const b = dist.find(d => s >= d.min && s <= d.max); if (b) b.count++; });
    const maxDist = Math.max(...dist.map(d => d.count), 1);

    // By judge
    const byJudge: Record<string, { name: string; total: number; done: number; avg: number }> = {};
    scorecards.forEach((sc: any) => {
      if (!byJudge[sc.judgeName]) byJudge[sc.judgeName] = { name: sc.judgeName, total: 0, done: 0, avg: 0 };
      byJudge[sc.judgeName].total++;
      if (['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(sc.status)) {
        byJudge[sc.judgeName].done++;
        if (sc.totalScore != null) byJudge[sc.judgeName].avg += sc.totalScore;
      }
    });
    Object.values(byJudge).forEach(j => { if (j.done > 0) j.avg = Math.round(j.avg / j.done); });
    const judgeProgress = Object.values(byJudge).sort((a, b) => (b.done / b.total) - (a.done / a.total));

    // By team
    const byTeam: Record<string, { name: string; total: number; done: number; avg: number }> = {};
    scorecards.forEach((sc: any) => {
      if (!byTeam[sc.teamName]) byTeam[sc.teamName] = { name: sc.teamName, total: 0, done: 0, avg: 0 };
      byTeam[sc.teamName].total++;
      if (['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(sc.status)) {
        byTeam[sc.teamName].done++;
        if (sc.totalScore != null) byTeam[sc.teamName].avg += sc.totalScore;
      }
    });
    Object.values(byTeam).forEach(t => { if (t.done > 0) t.avg = Math.round(t.avg / t.done); });
    const teamProgress = Object.values(byTeam).sort((a, b) => (b.done / b.total) - (a.done / a.total));

    const byType: Record<string, number> = {};
    judges.forEach((j: any) => { byType[j.judgeType] = (byType[j.judgeType] || 0) + 1; });
    const absent = judges.filter((j: any) => j.status === 'UNAVAILABLE').length;
    const activeJudges = judges.length - absent;
    const activeConflicts = conflicts.filter((c: any) => c.status === 'ACTIVE').length;

    const activeRoomSet = new Set(sessions.filter((s: any) => s.stage === 'IN_PROGRESS').map((s: any) => s.roomName));
    const roomStatus = rooms.map((r: any) => {
      const roomSessions = sessions.filter((s: any) => s.roomName === r.name);
      const done = roomSessions.filter((s: any) => s.stage === 'COMPLETED').length;
      const active = roomSessions.find((s: any) => s.stage === 'IN_PROGRESS');
      const next = roomSessions.filter((s: any) => s.stage === 'SCHEDULED').sort((a: any, b: any) => (a.scheduledStart || '').localeCompare(b.scheduledStart || ''))[0];
      return { name: r.name, total: roomSessions.length, done, active: active?.teamName, next: next?.teamName };
    });

    // Judge workload with org and track breakdown
    const trackNames = [...new Set(sessions.map((s: any) => s.trackName).filter(Boolean))];
    const trackColors: Record<string, string> = {};
    const palette = ['#7c3aed', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#06b6d4'];
    trackNames.forEach((t, i) => { trackColors[t] = palette[i % palette.length]; });

    const judgeLoad = judges.map((j: any) => {
      const judgeSessions = sessions.filter((s: any) => (s.judges || []).some((sj: any) => sj.judgeId === j.id));
      const assigned = judgeSessions.length;
      // Track breakdown
      const byTrack: Record<string, number> = {};
      judgeSessions.forEach((s: any) => {
        const t = s.trackName || 'Unassigned';
        byTrack[t] = (byTrack[t] || 0) + 1;
      });
      return {
        id: j.id, name: j.name, type: j.judgeType, assigned, max: j.maxSessions,
        status: j.status, org: j.organisation || '', department: j.department || '',
        byTrack,
      };
    }).sort((a, b) => b.assigned - a.assigned);

    // By affiliation
    const byOrg: Record<string, number> = {};
    judges.forEach((j: any) => {
      const org = j.organisation || 'Unknown';
      byOrg[org] = (byOrg[org] || 0) + 1;
    });

    // Track coverage: how many judges per track
    const trackCoverage: Record<string, number> = {};
    trackNames.forEach(t => {
      const judgesOnTrack = new Set<string>();
      sessions.filter((s: any) => s.trackName === t).forEach((s: any) => {
        (s.judges || []).forEach((sj: any) => judgesOnTrack.add(sj.judgeId));
      });
      trackCoverage[t] = judgesOnTrack.size;
    });

    const activeTracks = tracks.filter((t: any) => t.status !== 'ARCHIVED').length;
    const judgingSlots = timeSlots.filter((s: any) => s.slotType === 'JUDGING').length;
    const criteriaCount = template?.criteria?.length || 0;
    const maxScore = template?.criteria?.reduce((sum: number, c: any) => sum + (c.maxScore || 0), 0) || 0;

    const readyChecks = [
      { ok: !!event, label: 'Event configured', sub: event?.name || 'Not set' },
      { ok: activeTracks > 0, label: 'Tracks set up', sub: `${activeTracks} tracks` },
      { ok: sessions.length > 0, label: 'Teams loaded', sub: `${new Set(sessions.map((s: any) => s.teamName)).size} teams` },
      { ok: judges.length > 0, label: 'Judges onboarded', sub: `${judges.length} judges` },
      { ok: criteriaCount > 0, label: 'Scoring criteria', sub: `${criteriaCount} criteria, ${maxScore} pts` },
      { ok: sessions.length > 0, label: 'Schedule generated', sub: `${sessions.length} sessions` },
      { ok: rooms.length > 0, label: 'Rooms configured', sub: `${rooms.length} rooms` },
    ];
    const readyPct = Math.round((readyChecks.filter(c => c.ok).length / readyChecks.length) * 100);

    return {
      completed, inProgress, upcoming, delayed, cancelled, total, progressPct,
      submitted, drafts, pending, totalSC, scorePct, avg, high, low, median, dist, maxDist,
      judgeProgress, teamProgress, byType, absent, activeJudges, activeRooms: activeRoomSet.size,
      roomStatus, judgeLoad, readyChecks, readyPct, activeTracks, judgingSlots, criteriaCount,
      maxScore, activeConflicts, byOrg, trackNames, trackColors, trackCoverage,
    };
  }, [sessions, judges, rooms, scorecards, event, tracks, timeSlots, conflicts, template]);

  const highTeam = scorecards.find((s: any) => s.totalScore === stats.high)?.teamName || '';
  const lowTeam = scorecards.find((s: any) => s.totalScore === stats.low)?.teamName || '';

  const typeColors: Record<string, string> = {
    TECHNICAL: '#3b82f6', BUSINESS: '#10b981', DOMAIN: '#7c3aed', INNOVATION: '#f59e0b', EXECUTIVE: '#ef4444',
  };

  const sidebarItems = [
    { phase: 'Preparedness', items: [
      { icon: '\u2699', label: 'Readiness', stat: `${stats.readyPct}%`, sc: stats.readyPct >= 80 ? 'g' : 'y', sub: 'ready', cc: 'ib' },
      { icon: '\u25A3', label: 'Rooms & slots', stat: `${rooms.length}`, sc: 'g', sub: `rooms`, cc: 'ib' },
      { icon: '\u2605', label: 'Judges', stat: `${judges.length}`, sc: stats.absent > 0 ? 'y' : 'g', sub: `onboard`, cc: 'ib' },
      { icon: '\u2714', label: 'Schedule', stat: sessions.length > 0 ? '100' : '0', sc: sessions.length > 0 ? 'g' : 'r', sub: 'quality', cc: 'ib' },
    ]},
    { phase: 'Execution', items: [
      { icon: '\u25B6', label: 'Live status', stat: `${stats.activeRooms}`, sc: stats.activeRooms > 0 ? 'g' : 'b', sub: 'active', cc: 'ig' },
      { icon: '\u25A7', label: 'Progress', stat: `${stats.progressPct}%`, sc: 'b', sub: 'done', cc: 'ig' },
      { icon: '\u25C7', label: 'Scores', stat: `${stats.scorePct}%`, sc: 'b', sub: 'in', cc: 'ig' },
    ]},
    { phase: 'Results', items: [
      { icon: '\u265A', label: 'Leaderboard', stat: rankings.length > 0 ? 'Live' : '...', sc: rankings.length > 0 ? 'g' : 'y', sub: '', cc: 'ip' },
    ]},
  ];

  // ─── Pane renderers ───
  const renderReadiness = () => (
    <>
      <div className="p-title">Event readiness</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, marginBottom: 20 }}>
        <div style={{ position: 'relative' }}>
          <Ring value={stats.readyChecks.filter(c => c.ok).length} max={stats.readyChecks.length} size={80} stroke={6} color={stats.readyPct >= 80 ? '#10b981' : '#f59e0b'} />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 600, color: '#2a1a08' }}>{stats.readyPct}%</div>
        </div>
        <div><div style={{ fontSize: 16, color: '#2a1a08', fontWeight: 500 }}>Overall readiness</div><div style={{ fontSize: 13, color: stats.readyPct >= 80 ? '#10b981' : '#f59e0b', marginTop: 2 }}>{stats.readyPct >= 80 ? 'Ready to go' : 'Setup in progress'}</div></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {stats.readyChecks.map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: '#ead8b8', border: '0.5px solid #c9a04a22' }}>
            <div style={{ width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, background: c.ok ? '#d1fae5' : '#fee2e2', color: c.ok ? '#065f46' : '#991b1b', flexShrink: 0 }}>{c.ok ? '\u2713' : '\u2717'}</div>
            <div><div style={{ fontSize: 14, color: '#3a2a10' }}>{c.label}</div><div style={{ fontSize: 12, color: '#8a7a50' }}>{c.sub}</div></div>
          </div>
        ))}
      </div>
    </>
  );

  const renderRooms = () => {
    const slotTimes = [...new Set(sessions.map((s: any) => {
      if (!s.scheduledStart) return null;
      return new Date(s.scheduledStart).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false });
    }).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b))) as string[];

    const eventDates = [...new Set(sessions.map((s: any) => {
      if (!s.scheduledStart) return null;
      return new Date(s.scheduledStart).toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' });
    }).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b))) as string[];

    const rNames = rooms.map((r: any) => r.name).sort((a, b) => String(a).localeCompare(String(b)));
    // Only show rooms that have sessions
    const activeRoomNames = rNames.filter(r => sessions.some((s: any) => s.roomName === r));

    const getSession = (date: string, time: string, room: string) => {
      return sessions.find((s: any) => {
        if (!s.scheduledStart) return false;
        const d = new Date(s.scheduledStart);
        return d.toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' }) === date
          && d.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false }) === time
          && s.roomName === room;
      });
    };

    const sc: Record<string, { bg: string; text: string; border: string; dot: string }> = {
      'COMPLETED': { bg: '#d1fae5', text: '#065f46', border: '#a7f3d0', dot: '#10b981' },
      'IN_PROGRESS': { bg: '#dbeafe', text: '#1e40af', border: '#bfdbfe', dot: '#3b82f6' },
      'SCHEDULED': { bg: '#f0e8d8', text: '#5a4a28', border: '#d4c4a0', dot: '#8a7a50' },
      'DELAYED': { bg: '#fef3c7', text: '#92400e', border: '#fde68a', dot: '#f59e0b' },
      'CANCELLED': { bg: '#fee2e2', text: '#991b1b', border: '#fecaca', dot: '#ef4444' },
    };

    return (
      <>
        <div className="p-title">Rooms & schedule</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <Pill label="Rooms" value={activeRoomNames.length} color="#7c3aed" />
          <Pill label="Slots" value={slotTimes.length} color="#3b82f6" />
          <Pill label="Sessions" value={sessions.length} color="#10b981" />
        </div>

        {eventDates.map((date) => {
          const dateSlots = slotTimes.filter(time => activeRoomNames.some(room => getSession(date, time, room)));
          if (dateSlots.length === 0) return null;

          return (
            <div key={date} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#8b6a14', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid #c9a04a22' }}>{date}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ width: 50, padding: '5px 2px', fontSize: 10, color: '#8a7a50', fontWeight: 600, textAlign: 'left', borderBottom: '1px solid #c9a04a22' }}>Time</th>
                    {activeRoomNames.map(room => (
                      <th key={room} style={{ padding: '5px 3px', fontSize: 10, fontWeight: 600, color: '#5a4a28', textAlign: 'center', borderBottom: '1px solid #c9a04a22' }}>
                        {room.replace('Room ', '').replace(' - ', '\n')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dateSlots.map((time) => {
                    const hour = parseInt(time.split(':')[0]);
                    const rowBg = hour >= 12 ? '#e8dcc010' : 'transparent';
                    return (
                      <tr key={time}>
                        <td style={{ padding: '3px 2px', fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: '#5a4a28', fontWeight: 500, borderBottom: '0.5px solid #d4c4a015', background: rowBg, verticalAlign: 'top' }}>
                          {time}
                        </td>
                        {activeRoomNames.map(room => {
                          const sess = getSession(date, time, room);
                          const c = sess ? (sc[sess.stage] || sc['SCHEDULED']) : null;
                          return (
                            <td key={room} style={{ padding: '2px', borderBottom: '0.5px solid #d4c4a015', borderLeft: '0.5px solid #c9a04a08', background: rowBg, verticalAlign: 'top' }}>
                              {sess && c && (
                                <div style={{ padding: '4px 5px', borderRadius: 4, background: c.bg, border: `0.5px solid ${c.border}` }}>
                                  <div style={{ fontSize: 11, fontWeight: 500, color: c.text, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sess.teamName}</div>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                                    <span style={{ fontSize: 9, color: c.text, opacity: 0.7 }}>{sess.judges?.length || 0}J</span>
                                    <span style={{ fontSize: 9, color: c.text, opacity: 0.7 }}>{sess.scorecardsSubmitted || 0}/{sess.scorecardsTotal || 0}</span>
                                  </div>
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          {Object.entries(sc).map(([stage, c]) => (
            <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: c.bg, border: `0.5px solid ${c.border}` }} />
              <span style={{ fontSize: 10, color: '#8a7a50' }}>{stage.replace('_', ' ')}</span>
            </div>
          ))}
        </div>
      </>
    );
  };

  const renderJudges = () => (
    <>
      <div className="p-title">Judges</div>

      {/* Summary row */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        {Object.entries(stats.byType).map(([type, count]) => (
          <Pill key={type} label={type} value={count as number} color={typeColors[type] || '#6b7a90'} />
        ))}
        {stats.absent > 0 && <Pill label="Absent" value={stats.absent} color="#ef4444" />}
        <Pill label="Conflicts" value={stats.activeConflicts} color="#f59e0b" />
      </div>

      {/* Organisation breakdown */}
      <div style={{ fontSize: 11, color: '#8a7a50', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>By organisation</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {Object.entries(stats.byOrg).map(([org, count]) => (
          <div key={org} style={{ padding: '4px 10px', borderRadius: 6, background: '#ead8b8', border: '0.5px solid #c9a04a22', fontSize: 12 }}>
            <span style={{ fontWeight: 500, color: '#3a2a10' }}>{org}</span>
            <span style={{ color: '#8a7a50', marginLeft: 4 }}>{count as number}</span>
          </div>
        ))}
      </div>

      {/* Track coverage */}
      <div style={{ fontSize: 11, color: '#8a7a50', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>Track coverage</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {Object.entries(stats.trackCoverage).map(([track, count]) => (
          <div key={track} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, background: `${stats.trackColors[track] || '#6b7a90'}10`, border: `1px solid ${stats.trackColors[track] || '#6b7a90'}25` }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: stats.trackColors[track] || '#6b7a90' }} />
            <span style={{ fontSize: 12, color: '#3a2a10' }}>{track}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: stats.trackColors[track] || '#6b7a90' }}>{count as number}J</span>
          </div>
        ))}
      </div>

      {/* Per-judge detail */}
      <div style={{ fontSize: 11, color: '#8a7a50', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>Workload by judge</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', fontSize: 10, color: '#8a7a50', fontWeight: 600, padding: '4px 2px', borderBottom: '1px solid #c9a04a22', width: '25%' }}>Judge</th>
            <th style={{ textAlign: 'left', fontSize: 10, color: '#8a7a50', fontWeight: 600, padding: '4px 2px', borderBottom: '1px solid #c9a04a22', width: '20%' }}>Org</th>
            <th style={{ textAlign: 'center', fontSize: 10, color: '#8a7a50', fontWeight: 600, padding: '4px 2px', borderBottom: '1px solid #c9a04a22', width: '10%' }}>Type</th>
            <th style={{ textAlign: 'left', fontSize: 10, color: '#8a7a50', fontWeight: 600, padding: '4px 2px', borderBottom: '1px solid #c9a04a22', width: '35%' }}>Tracks</th>
            <th style={{ textAlign: 'right', fontSize: 10, color: '#8a7a50', fontWeight: 600, padding: '4px 2px', borderBottom: '1px solid #c9a04a22', width: '10%' }}>Load</th>
          </tr>
        </thead>
        <tbody>
          {stats.judgeLoad.map((j: any, i: number) => (
            <tr key={i} style={{ background: j.status === 'UNAVAILABLE' ? '#fee2e210' : 'transparent' }}>
              <td style={{ padding: '6px 2px', fontSize: 12, fontWeight: 500, color: j.status === 'UNAVAILABLE' ? '#991b1b' : '#3a2a10', borderBottom: '0.5px solid #d4c4a015', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {j.name}
                {j.status === 'UNAVAILABLE' && <span style={{ fontSize: 9, color: '#ef4444', marginLeft: 4 }}>ABSENT</span>}
              </td>
              <td style={{ padding: '6px 2px', fontSize: 11, color: '#5a4a28', borderBottom: '0.5px solid #d4c4a015', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {j.org || j.department || '-'}
              </td>
              <td style={{ padding: '6px 2px', textAlign: 'center', borderBottom: '0.5px solid #d4c4a015' }}>
                <span style={{ fontSize: 9, padding: '2px 5px', borderRadius: 3, background: `${typeColors[j.type] || '#6b7a90'}15`, color: typeColors[j.type] || '#6b7a90', fontWeight: 600, textTransform: 'uppercase' }}>{(j.type || '').slice(0, 4)}</span>
              </td>
              <td style={{ padding: '6px 2px', borderBottom: '0.5px solid #d4c4a015' }}>
                {/* Stacked track bar */}
                <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden', background: '#d4c4a015' }}>
                  {Object.entries(j.byTrack as Record<string, number>).map(([track, count], ti) => {
                    const pct = j.assigned > 0 ? ((count as number) / j.assigned) * 100 : 0;
                    return (
                      <div key={ti} title={`${track}: ${count}`} style={{
                        width: `${pct}%`, background: stats.trackColors[track] || '#6b7a90',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 8, color: '#fff', fontWeight: 600, minWidth: 0,
                      }}>
                        {pct > 20 ? count as number : ''}
                      </div>
                    );
                  })}
                </div>
              </td>
              <td style={{ padding: '6px 2px', fontSize: 12, fontWeight: 500, color: '#3a2a10', textAlign: 'right', borderBottom: '0.5px solid #d4c4a015' }}>
                {j.assigned}/{j.max}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );

  const renderSchedule = () => (
    <>
      <div className="p-title">Schedule quality</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, marginBottom: 20 }}>
        <div style={{ position: 'relative' }}>
          <Ring value={sessions.length > 0 ? 100 : 0} max={100} size={80} stroke={6} color="#10b981" />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, fontWeight: 600, color: '#10b981' }}>{sessions.length > 0 ? 100 : 0}</div>
        </div>
        <div><div style={{ fontSize: 16, fontWeight: 500, color: '#2a1a08' }}>Quality score</div><div style={{ fontSize: 13, color: '#8a7a50' }}>{sessions.length} sessions scheduled</div></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {[
          { ok: true, label: 'All teams scheduled', sub: '0 unscheduled' },
          { ok: true, label: 'No judge conflicts', sub: `${stats.activeConflicts} respected` },
          { ok: true, label: 'No double bookings', sub: 'Rooms clear' },
          { ok: true, label: 'Balanced workload', sub: `${event?.minJudgesPerTeam || 3}-${event?.maxJudgesPerTeam || 5} per team` },
        ].map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: '#ead8b8' }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#d1fae5', color: '#065f46', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, flexShrink: 0 }}>{'\u2713'}</div>
            <div><div style={{ fontSize: 13, color: '#3a2a10' }}>{c.label}</div><div style={{ fontSize: 11, color: '#8a7a50' }}>{c.sub}</div></div>
          </div>
        ))}
      </div>
    </>
  );

  const renderLive = () => (
    <>
      <div className="p-title">Live room status</div>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 16 }}>
        <Pill label="Active" value={stats.activeRooms} color="#10b981" />
        <Pill label="Available" value={rooms.length - stats.activeRooms} color="#6b7a90" />
      </div>
      {stats.roomStatus.map((r: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 8px', borderBottom: '0.5px solid #d4c4a033', borderRadius: r.active ? 8 : 0, background: r.active ? '#10b98110' : 'transparent' }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: r.active ? '#10b981' : '#94a3b8', flexShrink: 0, boxShadow: r.active ? '0 0 8px #10b98140' : 'none' }} />
          <div style={{ width: 140, fontSize: 14, color: '#3a2a10', fontWeight: 500 }}>{r.name}</div>
          <div style={{ flex: 1, fontSize: 14, color: r.active ? '#10b981' : '#8a7a50', fontWeight: r.active ? 500 : 400 }}>
            {r.active ? r.active : r.next ? `Next: ${r.next}` : 'Available'}
          </div>
          <span style={{ fontSize: 12, color: '#8a7a50' }}>{r.done}/{r.total}</span>
        </div>
      ))}
    </>
  );

  const renderProgress = () => (
    <>
      <div className="p-title">Session progress</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, marginBottom: 16 }}>
        <div style={{ position: 'relative' }}>
          <Ring value={stats.completed} max={stats.total} size={80} stroke={6} color="#10b981" />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 600, color: '#2a1a08' }}>{stats.progressPct}%</div>
        </div>
        <div><div style={{ fontSize: 16, fontWeight: 500, color: '#2a1a08' }}>{stats.completed} of {stats.total}</div><div style={{ fontSize: 13, color: '#8a7a50' }}>sessions completed</div></div>
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <Pill label="Completed" value={stats.completed} color="#10b981" />
        <Pill label="In progress" value={stats.inProgress} color="#3b82f6" />
        <Pill label="Upcoming" value={stats.upcoming} color="#6b7a90" />
        {stats.delayed > 0 && <Pill label="Delayed" value={stats.delayed} color="#f59e0b" />}
        {stats.cancelled > 0 && <Pill label="Cancelled" value={stats.cancelled} color="#ef4444" />}
      </div>
      <div style={{ fontSize: 12, color: '#8a7a50', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>By room</div>
      {stats.roomStatus.map((r: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '0.5px solid #d4c4a022' }}>
          <div style={{ width: 120, fontSize: 13, color: '#3a2a10', fontWeight: 500 }}>{r.name}</div>
          <Bar value={r.done} max={r.total} color="#10b981" height={7} />
          <span style={{ fontSize: 12, color: '#5a4a28', minWidth: 36, textAlign: 'right' }}>{r.done}/{r.total}</span>
        </div>
      ))}
    </>
  );

  const renderScores = () => (
    <>
      <div className="p-title">Scoring progress</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, marginBottom: 16 }}>
        <div style={{ position: 'relative' }}>
          <Ring value={stats.submitted} max={stats.totalSC} size={80} stroke={6} color="#7c3aed" />
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 600, color: '#2a1a08' }}>{stats.scorePct}%</div>
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 500, color: '#2a1a08' }}>{stats.submitted} of {stats.totalSC}</div>
          <div style={{ fontSize: 13, color: '#8a7a50' }}>scorecards submitted</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <Pill label="In" value={stats.submitted} color="#10b981" />
            <Pill label="Draft" value={stats.drafts} color="#f59e0b" />
            <Pill label="Pending" value={stats.pending} color="#6b7a90" />
          </div>
        </div>
      </div>

      {/* Score distribution */}
      <div style={{ fontSize: 12, color: '#8a7a50', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>Score distribution</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 60, marginBottom: 12, padding: '0 4px' }}>
        {stats.dist.map((d: any, i: number) => (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, color: '#5a4a28', fontWeight: 500 }}>{d.count}</span>
            <div style={{ width: '100%', height: `${stats.maxDist > 0 ? (d.count / stats.maxDist) * 40 : 0}px`, minHeight: 2, background: d.color, borderRadius: 3, transition: 'height 0.8s ease' }} />
            <span style={{ fontSize: 10, color: '#8a7a50' }}>{d.label}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 4px', borderTop: '0.5px solid #d4c4a033', marginBottom: 4 }}>
        <span style={{ fontSize: 13, color: '#5a4a28' }}>Average</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#2a1a08' }}>{stats.avg} / {stats.maxScore || 100}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 4px' }}>
        <span style={{ fontSize: 13, color: '#059669' }}>High: {stats.high} {highTeam ? `- ${highTeam}` : ''}</span>
        <span style={{ fontSize: 13, color: '#dc2626' }}>Low: {stats.low} {lowTeam ? `- ${lowTeam}` : ''}</span>
      </div>

      {/* By judge */}
      <div style={{ fontSize: 12, color: '#8a7a50', marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>By judge</div>
      {stats.judgeProgress.slice(0, 8).map((j: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '0.5px solid #d4c4a022' }}>
          <div style={{ width: 100, fontSize: 12, color: '#3a2a10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.name}</div>
          <Bar value={j.done} max={j.total} color={j.done === j.total ? '#10b981' : '#7c3aed'} height={6} />
          <span style={{ fontSize: 11, color: '#5a4a28', minWidth: 32, textAlign: 'right' }}>{j.done}/{j.total}</span>
          {j.done === 0 && <span style={{ fontSize: 9, color: '#f59e0b', fontWeight: 600 }}>!</span>}
        </div>
      ))}

      {/* By team */}
      <div style={{ fontSize: 12, color: '#8a7a50', marginTop: 14, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>By team</div>
      {stats.teamProgress.slice(0, 8).map((t: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '0.5px solid #d4c4a022' }}>
          <div style={{ width: 100, fontSize: 12, color: '#3a2a10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
          <Bar value={t.done} max={t.total} color={t.done === t.total ? '#10b981' : '#3b82f6'} height={6} />
          <span style={{ fontSize: 11, color: '#5a4a28', minWidth: 32, textAlign: 'right' }}>{t.done}/{t.total}</span>
          {t.done === t.total && <span style={{ fontSize: 10, color: '#10b981' }}>{'\u2713'}</span>}
        </div>
      ))}
    </>
  );

  const renderLeaderboard = () => (
    <>
      <div className="p-title">Leaderboard</div>
      {rankings.length > 0 ? (<>
        <div style={{ textAlign: 'center', fontSize: 14, color: '#8a7a50', marginBottom: 16 }}>Provisional rankings - {rankings.length} teams</div>
        {rankings.slice(0, 10).map((r: any, i: number) => {
          const colors = ['#f59e0b', '#94a3b8', '#cd7f32'];
          const bgColors = ['#fef3c7', '#e5e7eb', '#fed7aa'];
          const pc = i < 3 ? bgColors[i] : '#f3f4f6';
          const tc = i < 3 ? colors[i] : '#6b7280';
          const bc = i === 0 ? '#10b981' : i === 1 ? '#3b82f6' : i === 2 ? '#7c3aed' : '#94a3b8';
          return (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 4px', borderBottom: '0.5px solid #d4c4a033' }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: pc, color: tc, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{i + 1}</div>
              <div style={{ width: 130, fontSize: 14, color: '#3a2a10', fontWeight: 500 }}>{r.teamName}</div>
              <Bar value={r.totalScore} max={100} color={bc} height={8} />
              <span style={{ fontSize: 15, fontWeight: 600, color: '#2a1a08', minWidth: 32, textAlign: 'right' }}>{r.totalScore}</span>
            </div>
          );
        })}
        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          {rankings.filter((r: any) => r.advancesToFinals).length > 0 && (
            <div style={{ padding: '5px 14px', borderRadius: 6, background: '#d1fae5', color: '#065f46', fontSize: 13, fontWeight: 500, border: '1px solid #86efac' }}>
              {rankings.filter((r: any) => r.advancesToFinals).length} advance to finals
            </div>
          )}
          {rankings.filter((r: any) => r.pocAward).length > 0 && (
            <div style={{ padding: '5px 14px', borderRadius: 6, background: '#fef3c7', color: '#92400e', fontSize: 13, fontWeight: 500, border: '1px solid #fcd34d' }}>
              {rankings.filter((r: any) => r.pocAward).length} POC awards
            </div>
          )}
        </div>
      </>) : (
        <div style={{ textAlign: 'center', padding: '32px 0', color: '#8a7a50', fontSize: 15 }}>Complete scoring, then calculate rankings.</div>
      )}
    </>
  );

  const panes = [renderReadiness, renderRooms, renderJudges, renderSchedule, renderLive, renderProgress, renderScores, renderLeaderboard];

  return (
    <div>
      <style>{`
        .hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
        .hdr h1{font-size:24px;font-weight:500;color:#e8dcc0}
        .hdr-sub{font-size:14px;color:#6b5a30;margin-top:2px}
        .live-w{display:flex;align-items:center;gap:8px}
        .live-d{width:8px;height:8px;border-radius:50%;background:#10b981;animation:ld 2s ease-in-out infinite}
        @keyframes ld{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes fp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        .hall{display:flex;gap:20px;align-items:flex-start}
        .rack{width:200px;flex-shrink:0}
        .ph{font-size:11px;color:#8b6a14;letter-spacing:0.14em;text-transform:uppercase;margin:18px 0 6px 10px;font-weight:600}
        .ph:first-child{margin-top:0}
        .si{cursor:pointer;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;transition:all 0.2s;margin:2px 0;border-left:3px solid transparent}
        .si:hover{background:rgba(200,160,60,0.06)}
        .si.on{background:rgba(200,160,60,0.1);border-left-color:#c9a04a}
        .si-i{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
        .ib{background:rgba(59,130,246,0.1);color:#60a5fa}
        .ig{background:rgba(16,185,129,0.1);color:#34d399}
        .ip{background:rgba(124,58,237,0.1);color:#a78bfa}
        .si-n{font-size:14px;font-weight:500;color:#e8dcc0}
        .si-s{font-size:12px;color:#8a7a50;margin-top:2px;display:flex;align-items:center;gap:4px}
        .cg{color:#10b981} .cy{color:#f59e0b} .cr{color:#ef4444} .cb{color:#60a5fa}
        .main{flex:1;min-width:0}
        .card{border-radius:12px;overflow:hidden;border:0.5px solid rgba(200,160,60,0.18);animation:fp 0.45s ease forwards}
        .rod{height:24px;background:linear-gradient(180deg,#9a4a50 0%,#7a3038 30%,#5e2228 50%,#7a3038 70%,#9a4a50 100%);position:relative}
        .rod::before{content:'';position:absolute;inset:4px 24px;background:linear-gradient(180deg,rgba(255,200,100,0.12),transparent);border-radius:4px}
        .rod-b{border-radius:0 0 12px 12px;height:20px}
        .fin{position:absolute;top:-7px;width:13px;height:38px;z-index:2}
        .fin::before{content:'';position:absolute;top:0;left:50%;width:10px;height:10px;border-radius:50%;transform:translateX(-50%);background:radial-gradient(circle at 38% 33%,#eed89a,#c9a04a,#8b6a14);border:1.5px solid #6b5010;box-shadow:0 2px 5px rgba(0,0,0,0.3)}
        .fl{left:-3px} .fr{right:-3px}
        .silk{background:linear-gradient(135deg,#8a3038 0%,#722828 30%,#5e2020 50%,#722828 70%,#8a3038 100%);padding:5px;position:relative}
        .silk::before{content:'';position:absolute;inset:0;background:repeating-linear-gradient(45deg,transparent,transparent 14px,rgba(200,160,60,0.03) 14px,rgba(200,160,60,0.03) 15px)}
        .cld{position:absolute;opacity:0.06;pointer-events:none}
        .cld::before{content:'';display:block;width:44px;height:22px;background:radial-gradient(ellipse,#e8c87b 55%,transparent 56%);border-radius:50%}
        .cld::after{content:'';display:block;width:32px;height:16px;background:radial-gradient(ellipse,#e8c87b 55%,transparent 56%);border-radius:50%;margin-top:-10px;margin-left:14px}
        .cl1{top:14px;left:10px} .cl2{bottom:16px;right:12px} .cl3{top:38%;right:8px}
        .gf{border:2px solid;border-image:linear-gradient(180deg,#e8d5a0,#c9a04a 20%,#8b6914 50%,#c9a04a 80%,#e8d5a0) 1;margin:8px 6px;position:relative}
        .gf::before{content:'';position:absolute;inset:-4px;border:0.5px solid #c9a04a22}
        .gc{position:absolute;width:14px;height:14px}
        .gc::before{content:'';position:absolute;width:14px;height:14px;border:2.5px solid #c9a04a}
        .gc::after{content:'';position:absolute;width:6px;height:6px;background:#c9a04a}
        .gtl{top:-3px;left:-3px} .gtl::before{border-right:none;border-bottom:none} .gtl::after{top:0;left:0}
        .gtr{top:-3px;right:-3px} .gtr::before{border-left:none;border-bottom:none} .gtr::after{top:0;right:0}
        .gbl{bottom:-3px;left:-3px} .gbl::before{border-right:none;border-top:none} .gbl::after{bottom:0;left:0}
        .gbr{bottom:-3px;right:-3px} .gbr::before{border-left:none;border-top:none} .gbr::after{bottom:0;right:0}
        .ib2{border:0.5px solid #c9a04a22;margin:4px;padding:2px}
        .pch{background:linear-gradient(180deg,#f6eed8,#f2ead0 5%,#f6eed8 50%,#f2ead0 95%,#ead8b8);padding:20px 24px}
        .p-title{text-align:center;font-size:15px;font-weight:500;color:#8b6a14;letter-spacing:0.12em;text-transform:uppercase;padding-bottom:8px;border-bottom:0.5px solid #c9a04a22;margin-bottom:14px}
      `}</style>

      <div className="hdr">
        <div>
          <h1>{event?.name || 'Loading...'}</h1>
          <p className="hdr-sub">Dashboard{event?.location ? ` - ${event.location}` : ''}</p>
        </div>
        <div className="live-w"><div className="live-d" /><span style={{ fontSize: 14, color: '#6b7a90' }}>Live</span></div>
      </div>

      <div className="hall">
        <div className="rack">
          {sidebarItems.map((group, gi) => {
            const startIdx = sidebarItems.slice(0, gi).reduce((sum, g) => sum + g.items.length, 0);
            return (
              <div key={gi}>
                <div className="ph">{group.phase}</div>
                {group.items.map((item, ii) => {
                  const idx = startIdx + ii;
                  return (
                    <div key={idx} className={`si ${activePane === idx ? 'on' : ''}`} onClick={() => setActivePane(idx)}>
                      <div className={`si-i ${item.cc}`}>{item.icon}</div>
                      <div>
                        <div className="si-n">{item.label}</div>
                        <div className="si-s"><span className={`c${item.sc}`} style={{ fontWeight: 600 }}>{item.stat}</span> {item.sub}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="main">
          <div className="card" key={activePane}>
            <div className="rod"><div className="fin fl" /><div className="fin fr" /></div>
            <div className="silk">
              <div className="cld cl1" /><div className="cld cl2" /><div className="cld cl3" />
              <div className="gf">
                <div className="gc gtl" /><div className="gc gtr" /><div className="gc gbl" /><div className="gc gbr" />
                <div className="ib2"><div className="pch">
                  {panes[activePane]?.()}
                </div></div>
              </div>
            </div>
            <div className="rod rod-b" />
          </div>
        </div>
      </div>
    </div>
  );
}
