'use client';
import { useState } from 'react';
import { useQuery } from '@/lib/use-graphql';
import CountryFlag from '@/components/country-flag';
import PlatformChip from '@/components/platform-chip';
import { useAuthStore } from '@/lib/auth-store';
import { createClient } from '@/lib/graphql-client';
import {
  EVENTS_QUERY, TEAMS_QUERY, JUDGES_QUERY, ROOMS_QUERY, TIMESLOTS_QUERY,
  CONFLICTS_QUERY, SESSIONS_QUERY, SAVE_SESSIONS_MUTATION, GENERATE_SCHEDULE_MUTATION
} from '@/lib/queries';
import StatusBadge from '@/components/status-badge';
import { useEventId } from '@/lib/event-store';

interface PlannerCard {
  teamId: string;
  teamName: string;
  projectName: string;
  trackName: string;
  organisation: string;
  techStack: string;
  // Carried from the team record so filters, grouping and the printed sheet
  // have something to work with. The solver returns none of these.
  platform: string;
  country: string;
  useCaseTitle: string;
  roomId: string | null;
  date: string | null;
  slotId: string | null;
  slotStart: string | null;
  slotEnd: string | null;
  judgeIds: string[];
}

export default function ScheduleBuilderPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const selectedEventId = useEventId();
  const event =
    evData?.events?.find((e: any) => e.id === selectedEventId) ?? evData?.events?.[0];
  const eventId = event?.id;

  const { data: teamData } = useQuery<any>(TEAMS_QUERY, eventId ? { eventId } : undefined);
  const { data: judgeData } = useQuery<any>(JUDGES_QUERY, eventId ? { eventId } : undefined);
  const { data: roomData } = useQuery<any>(ROOMS_QUERY, eventId ? { eventId } : undefined);
  const { data: slotData } = useQuery<any>(TIMESLOTS_QUERY, eventId ? { eventId } : undefined);
  const { data: conflictData } = useQuery<any>(CONFLICTS_QUERY, eventId ? { eventId } : undefined);
  const { data: sessionData } = useQuery<any>(SESSIONS_QUERY, eventId ? { eventId } : undefined);
  const token = useAuthStore((s) => s.token);

  const allTeams = teamData?.teams || [];
  const judges = judgeData?.judges || [];
  const rooms = roomData?.rooms || [];
  const allSlots = (slotData?.timeSlots || []).filter((s: any) => s.slotType === 'JUDGING');
  const conflicts = conflictData?.conflicts || [];
  const existingSessions = sessionData?.sessions || [];

  // State
  const [plannerCards, setPlannerCards] = useState<PlannerCard[]>([]);
  const [scheduledCards, setScheduledCards] = useState<any[]>([]);
  const [groupBy, setGroupBy] = useState<'trackName' | 'organisation' | 'platform' | 'country' | 'useCaseTitle'>('trackName');
  // Narrow the pile rather than just rearranging it. With 79 teams, "show me
  // the AWS ones" is a different question from "group by platform".
  const [filterPlatform, setFilterPlatform] = useState('');
  const [filterCountry, setFilterCountry] = useState('');
  const [filterTrack, setFilterTrack] = useState('');
  const [filterUseCase, setFilterUseCase] = useState('');
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState('');

  // Track which teams are already scheduled or in planner
  const plannerTeamIds = new Set(plannerCards.map(c => c.teamId));
  const scheduledTeamIds = new Set(existingSessions.map((s: any) => s.teamId));
  const unscheduledTeams = allTeams.filter((t: any) => !plannerTeamIds.has(t.id) && !scheduledTeamIds.has(t.id));

  // Track judge workload (existing sessions + planner assignments)
  const judgeWorkload: Record<string, number> = {};
  existingSessions.forEach((s: any) => s.judges?.forEach((j: any) => { judgeWorkload[j.judgeId] = (judgeWorkload[j.judgeId] || 0) + 1; }));
  plannerCards.forEach(c => c.judgeIds.forEach(jId => { judgeWorkload[jId] = (judgeWorkload[jId] || 0) + 1; }));

  // Track used slots (room+slot combos)
  const usedSlots = new Set<string>();
  existingSessions.forEach((s: any) => usedSlots.add(`${s.roomId}:${s.timeSlotId}`));
  plannerCards.forEach(c => { if (c.roomId && c.slotId) usedSlots.add(`${c.roomId}:${c.slotId}`); });

  // Judge conflict lookup
  const conflictSet = new Set(conflicts.filter((c: any) => c.status === 'ACTIVE').map((c: any) => `${c.judgeId}:${c.teamId}`));
  const hasConflict = (judgeId: string, teamId: string) => conflictSet.has(`${judgeId}:${teamId}`);

  // Judge busy in slot
  const judgeBusyInSlot = (judgeId: string, slotId: string, excludeTeamId?: string) => {
    for (const s of existingSessions) {
      if (s.timeSlotId === slotId && s.teamId !== excludeTeamId && s.judges?.some((j: any) => j.judgeId === judgeId)) return true;
    }
    for (const c of plannerCards) {
      if (c.slotId === slotId && c.teamId !== excludeTeamId && c.judgeIds.includes(judgeId)) return true;
    }
    return false;
  };

  // Filter, then group. Filtering first means the group headers reflect what is
  // actually shown rather than the full set.
  /**
   * One matcher for both sides of the screen.
   *
   * Planner cards and team records carry the same fields, so a card placed in
   * the planner and a team still in the pile answer the same question — which
   * is what makes "show me AWS" useful during manual placement.
   */
  const matchesFilter = (t: any) =>
    (!filterPlatform || t.platform === filterPlatform) &&
    (!filterCountry || t.country === filterCountry) &&
    (!filterTrack || t.trackName === filterTrack) &&
    (!filterUseCase || t.useCaseTitle === filterUseCase);

  const applyFilters = (teams: any[]) => teams.filter(matchesFilter);

  /** Dim rather than hide placed cards, so the shape of the day stays visible. */
  const filtersActive = !!(filterPlatform || filterCountry || filterTrack || filterUseCase);

  const cardDimmed = (c: any) =>
    (filterPlatform || filterCountry || filterTrack || filterUseCase) && !matchesFilter(c);

  const groupTeams = (teams: any[]) => {
    const groups: Record<string, any[]> = {};
    applyFilters(teams).forEach(t => {
      const key = t[groupBy] || t.trackName || 'Other';
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    });
    return groups;
  };

  // Distinct values for the filter dropdowns, drawn from the data so a value
  // that does not exist is never offered.
  const distinct = (field: string) =>
    [...new Set(allTeams.map((t: any) => t[field]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

  /**
   * Open a plain, printable view of the whole schedule.
   *
   * Written into a new window rather than rendered in place: the planner is a
   * scrolling two-column layout that prints badly, and someone checking a
   * schedule before confirming it wants every session in order on as few
   * sheets as possible.
   */
  /**
   * Collect every session on screen — planner and confirmed alike — in one
   * shape, so print and export do not diverge.
   */
  const allRowsForOutput = () => {
    const roomName = (id: string) => rooms.find((r: any) => r.id === id)?.name || '';
    const judgeName = (id: string) => judges.find((j: any) => j.id === id)?.name || '';
    const judgeTier = (id: string) => judges.find((j: any) => j.id === id)?.judgeTier || '';

    const fromPlanner = plannerCards.map((c: any) => ({
      slotDate: c.date, slotStart: c.slotStart, slotEnd: c.slotEnd,
      roomName: roomName(c.roomId), teamName: c.teamName, projectName: c.projectName,
      trackName: c.trackName, organisation: c.organisation,
      country: c.country, platform: c.platform, useCaseTitle: c.useCaseTitle,
      judgeNames: (c.judgeIds || []).map(judgeName),
      judgeTiers: (c.judgeIds || []).map(judgeTier),
      confirmed: false,
    }));

    const fromConfirmed = scheduledCards.map((c: any) => ({
      slotDate: c.slotDate ?? c.date, slotStart: c.slotStart, slotEnd: c.slotEnd,
      roomName: c.roomName ?? roomName(c.roomId), teamName: c.teamName,
      projectName: c.projectName, trackName: c.trackName, organisation: c.organisation,
      country: c.country, platform: c.platform, useCaseTitle: c.useCaseTitle,
      judgeNames: c.judgeNames ?? (c.judges || []).map((j: any) => j.judgeName),
      judgeTiers: (c.judges || []).map((j: any) => j.judgeTier || ''),
      confirmed: true,
    }));

    return [...fromConfirmed, ...fromPlanner].sort((a: any, b: any) => {
      const ad = `${a.slotDate} ${a.slotStart}`;
      const bd = `${b.slotDate} ${b.slotStart}`;
      return ad.localeCompare(bd) || String(a.roomName).localeCompare(String(b.roomName));
    });
  };

  /**
   * Download the whole schedule as CSV.
   *
   * Deliberately unfiltered. Filters on screen are for working; an export is
   * for taking away, and it is easier to filter in a spreadsheet than to
   * remember what was set when the button was pressed.
   */
  const exportCsv = () => {
    const rows = allRowsForOutput();
    if (rows.length === 0) { setMessage('Nothing to export yet'); return; }

    const MAX_JUDGES = 5;
    const headers = [
      'status', 'date', 'start_time', 'end_time', 'room',
      'team', 'project', 'track', 'business_unit', 'country', 'platform', 'use_case',
      'judge_count', 'panel',
      ...Array.from({ length: MAX_JUDGES }, (_, i) => `judge_${i + 1}`),
      ...Array.from({ length: MAX_JUDGES }, (_, i) => `judge_${i + 1}_tier`),
    ];

    // Quote everything. Team names contain commas and apostrophes, and a
    // half-quoted file opens wrong in Excel without any warning.
    const cell = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const lines = [headers.join(',')];
    for (const r of rows) {
      const names: string[] = r.judgeNames || [];
      const tiers: string[] = r.judgeTiers || [];
      lines.push([
        r.confirmed ? 'CONFIRMED' : 'DRAFT',
        r.slotDate ?? '', r.slotStart ?? '', r.slotEnd ?? '', r.roomName ?? '',
        r.teamName ?? '', r.projectName ?? '', r.trackName ?? '',
        r.organisation ?? '', r.country ?? '', r.platform ?? '', r.useCaseTitle ?? '',
        names.length, names.join(' | '),
        ...Array.from({ length: MAX_JUDGES }, (_, i) => names[i] ?? ''),
        ...Array.from({ length: MAX_JUDGES }, (_, i) => tiers[i] ?? ''),
      ].map(cell).join(','));
    }

    // BOM so Excel reads the file as UTF-8 rather than guessing.
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `${(event?.name || 'schedule').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage(`Exported ${rows.length} sessions`);
  };

  const printSchedule = () => {
    const rows = allRowsForOutput();
    if (rows.length === 0) { setMessage('Nothing to print yet'); return; }

    const esc = (s: any) => String(s ?? '').replace(/[<>&]/g, c =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

    const byDay: Record<string, any[]> = {};
    for (const r of rows) {
      const d = r.slotDate || 'Unscheduled';
      (byDay[d] = byDay[d] || []).push(r);
    }

    const eventName = event?.name || 'Schedule';

    const body = Object.entries(byDay).map(([day, list]) => `
      <h2>${esc(new Date(day).toLocaleDateString('en-SG',
        { weekday: 'long', day: 'numeric', month: 'long' }))}
        <span class="count">${list.length} sessions</span></h2>
      <table>
        <thead><tr>
          <th>Time</th><th>Room</th><th>Team</th><th>Country</th>
          <th>Platform</th><th>Use case</th><th>Panel</th><th></th>
        </tr></thead>
        <tbody>
          ${list.map((r: any) => `<tr>
            <td class="t">${esc(r.slotStart)}</td>
            <td>${esc(r.roomName)}</td>
            <td class="team">${esc(r.teamName)}</td>
            <td>${esc(r.country || '')}</td>
            <td>${esc(r.platform || '')}</td>
            <td>${esc(r.useCaseTitle || '')}</td>
            <td class="panel">${esc((r.judgeNames || []).join(', '))}</td>
            <td class="st">${r.confirmed ? 'confirmed' : 'draft'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`).join('');

    const html = `<!doctype html><html><head><meta charset="utf-8">
      <title>${esc(eventName)} — Schedule</title>
      <style>
        @page { size: A4 landscape; margin: 12mm; }
        body { font: 11px -apple-system, system-ui, sans-serif; color: #111; }
        h1 { font-size: 16px; margin: 0 0 2px; }
        .sub { color: #666; font-size: 11px; margin-bottom: 16px; }
        h2 { font-size: 13px; margin: 18px 0 6px; page-break-after: avoid; }
        h2 .count { font-weight: 400; color: #666; font-size: 11px; margin-left: 8px; }
        table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
        tr { page-break-inside: avoid; }
        th { text-align: left; font-size: 9px; text-transform: uppercase;
             letter-spacing: .04em; color: #666; border-bottom: 1px solid #999;
             padding: 4px 6px; }
        td { padding: 4px 6px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
        .t { font-variant-numeric: tabular-nums; white-space: nowrap; }
        .team { font-weight: 600; }
        .panel { color: #444; font-size: 10px; }
        .st { color: #888; font-size: 9px; text-transform: uppercase; white-space: nowrap; }
      </style></head><body>
      <h1>${esc(eventName)}</h1>
      <div class="sub">${rows.length} sessions &middot; printed ${new Date().toLocaleString('en-SG')}</div>
      ${body}
      </body></html>`;

    const w = window.open('', '_blank');
    if (!w) { setMessage('Allow pop-ups to print the schedule'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 300);
  };

  // Available slots for a room+date
  const getAvailableSlots = (roomId: string, date: string, excludeTeamId?: string) => {
    return allSlots.filter((s: any) => {
      const slotDate = new Date(s.date).toISOString().split('T')[0];
      if (slotDate !== date) return false;
      const key = `${roomId}:${s.id}`;
      if (usedSlots.has(key)) {
        const isOwnSlot = plannerCards.some(c => c.teamId === excludeTeamId && c.roomId === roomId && c.slotId === s.id);
        return isOwnSlot;
      }
      return true;
    });
  };

  // Get unique dates
  const dates = [...new Set(allSlots.map((s: any) => new Date(s.date).toISOString().split('T')[0]))].sort((a, b) => String(a).localeCompare(String(b)));

  // Add team to planner
  const addToPlanner = (team: any) => {
    setPlannerCards(prev => [...prev, {
      teamId: team.id, teamName: team.name, projectName: team.projectName,
      trackName: team.trackName || '', organisation: team.organisation || '',
      techStack: team.techStack || '',
      platform: team.platform || '', country: team.country || '',
      useCaseTitle: team.useCaseTitle || '',
      roomId: null, date: null, slotId: null, slotStart: null, slotEnd: null, judgeIds: [],
    }]);
  };

  // Remove from planner
  const removeFromPlanner = (teamId: string) => {
    setPlannerCards(prev => prev.filter(c => c.teamId !== teamId));
  };

  // Update planner card
  const updateCard = (teamId: string, updates: Partial<PlannerCard>) => {
    setPlannerCards(prev => prev.map(c => c.teamId === teamId ? { ...c, ...updates } : c));
  };

  // Add judge to card
  const addJudge = (teamId: string, judgeId: string) => {
    setPlannerCards(prev => prev.map(c => {
      if (c.teamId !== teamId) return c;
      if (c.judgeIds.includes(judgeId)) return c;
      return { ...c, judgeIds: [...c.judgeIds, judgeId] };
    }));
  };

  // Remove judge from card
  const removeJudge = (teamId: string, judgeId: string) => {
    setPlannerCards(prev => prev.map(c => {
      if (c.teamId !== teamId) return c;
      return { ...c, judgeIds: c.judgeIds.filter(id => id !== judgeId) };
    }));
  };

  // Check if card is complete
  const isCardComplete = (card: PlannerCard) => {
    return card.roomId && card.date && card.slotId && card.judgeIds.length >= (event?.minJudgesPerTeam || 3);
  };

  // Confirm single card
  const confirmCard = async (card: PlannerCard) => {
    if (!isCardComplete(card) || !eventId) return;
    setSaving(true);
    try {
      const client = createClient(token);
      const res = await client.mutation(SAVE_SESSIONS_MUTATION, {
        inputs: [{ eventId, teamId: card.teamId, roomId: card.roomId, timeSlotId: card.slotId, judgeIds: card.judgeIds }]
      }).toPromise();

      // urql resolves with an `error` property rather than rejecting, so the
      // catch below never fires on a GraphQL failure. Without this check a
      // failed save removed the card from the planner and reported success.
      const saved = res.data?.saveScheduleSessions;
      if (res.error || !saved || saved.length !== 1) {
        setMessage(
          `${card.teamName} was not saved: ` +
          (res.error?.message?.split('] ').pop() || 'the server returned nothing.')
        );
        setSaving(false);
        return;
      }

      removeFromPlanner(card.teamId);
      setScheduledCards(prev => [...prev, card]);
      setMessage(`${card.teamName} scheduled successfully`);
      setTimeout(() => setMessage(''), 3000);
    } catch (e: any) { setMessage('Error saving session: ' + (e?.message || e)); }
    setSaving(false);
  };

  // Auto-generate
  // Guided scheduling anchors an MD and a PS to each room and holds vendors
  // back for manual invitation. Off means the scheduler behaves as it always
  // has, so there is a way back if guided output looks wrong.
  const [guided, setGuided] = useState(false);

  const autoGenerate = async () => {
    if (!eventId) return;
    setGenerating(true);
    try {
      const client = createClient(token);
      const res = await client.mutation(GENERATE_SCHEDULE_MUTATION, {
        input: { eventId, minJudgesPerTeam: event?.minJudgesPerTeam || 3, maxJudgesPerTeam: event?.maxJudgesPerTeam || 5, guided }
      }).toPromise();

      console.log('Generate response:', JSON.stringify(res, null, 2));

      if (res.error) {
        setMessage('API Error: ' + res.error.message);
        setGenerating(false);
        return;
      }

      const result = res.data?.generateSchedule;
      if (result?.success) {
        // Add generated sessions to planner
        // The solver returns ids, rooms and slots. Everything else about the
        // team — platform, country, track, use case — has to come from the
        // record we already hold, or the card arrives knowing nothing about
        // what it represents.
        const cards: PlannerCard[] = result.sessions.map((s: any) => {
          const team = allTeams.find((t: any) => t.id === s.teamId) || {};
          return {
            teamId: s.teamId,
            teamName: s.teamName || team.name || '',
            projectName: team.projectName || '',
            trackName: team.trackName || '',
            organisation: team.organisation || '',
            techStack: team.techStack || '',
            platform: team.platform || '',
            country: team.country || '',
            useCaseTitle: team.useCaseTitle || '',
            roomId: s.roomId, date: s.slotDate,
            slotId: s.slotId, slotStart: s.slotStart, slotEnd: s.slotEnd,
            judgeIds: s.judgeIds,
          };
        });
        cards.sort((a: PlannerCard, b: PlannerCard) => {
          if (a.date !== b.date) return (a.date || "").localeCompare(b.date || "");
          return (a.slotStart || "").localeCompare(b.slotStart || "");
        });
        setPlannerCards(cards);
        setMessage(`Generated ${cards.length} sessions (Quality: ${result.qualityScore}, Time: ${result.solveTimeSeconds}s)`);
      } else {
        if (res.error) { setMessage('Error: ' + res.error.message); } else { setMessage('Schedule generation failed: ' + (result?.warnings?.join(', ') || 'No sessions returned')); }
      }
    } catch (e: any) { setMessage('Error: ' + e.message); }
    setGenerating(false);
  };

  // Confirm all complete cards
  const confirmAll = async () => {
    const complete = plannerCards.filter(isCardComplete);
    if (complete.length === 0 || !eventId) return;
    setSaving(true);
    try {
      const client = createClient(token);
      const res = await client.mutation(SAVE_SESSIONS_MUTATION, {
        inputs: complete.map(c => ({ eventId, teamId: c.teamId, roomId: c.roomId!, timeSlotId: c.slotId!, judgeIds: c.judgeIds }))
      }).toPromise();

      // urql resolves with an `error` property rather than rejecting, so the
      // catch below is unreachable on a GraphQL failure. This used to clear the
      // planner and report success either way — and the reload a second later
      // destroyed the only copy of a solve that takes over two minutes.
      const saved = res.data?.saveScheduleSessions;
      if (res.error || !saved) {
        setMessage(
          'Nothing was saved: ' +
          (res.error?.message?.split('] ').pop() || 'the server returned nothing.') +
          ' Your planner has been left untouched — try again.'
        );
        setSaving(false);
        return;
      }

      const short = complete.length - saved.length;
      const incomplete = plannerCards.length - complete.length;

      if (short > 0) {
        // The mutation returns session ids rather than team ids, so there is no
        // reliable way to tell which of these cards landed. Clearing on a guess
        // would lose the ones that did not, so nothing is cleared and the
        // coordinator is told plainly. Rare, and recoverable.
        setMessage(
          `Only ${saved.length} of ${complete.length} sessions were saved. The ` +
          'planner has been left as it is — reload to see what is stored before ' +
          'trying again.'
        );
        setSaving(false);
        return;
      }

      setPlannerCards(prev => prev.filter(c => !isCardComplete(c)));
      setMessage(
        `${saved.length} session(s) saved` +
        (incomplete > 0
          ? `. ${incomplete} incomplete card(s) were not submitted and remain in the planner`
          : '')
      );
      setTimeout(() => window.location.reload(), 1500);
    } catch (e: any) { setMessage('Error saving sessions: ' + (e?.message || e)); }
    setSaving(false);
  };

  const completePlannerCount = plannerCards.filter(isCardComplete).length;
  const totalScheduled = existingSessions.length;
  const totalTeams = allTeams.length;
  const isEventLocked = event?.status === 'ACTIVE' || event?.status === 'COMPLETED';

  // Reset all sessions and planner
  const resetSchedule = async () => {
    if (!eventId || !token) return;
    if (!confirm('This will clear all sessions so you can regenerate from scratch.\n\nThis is only available before event day.\n\nAre you sure?')) return;
    setSaving(true);
    try {
      const res = await fetch(`/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: `mutation { resetSchedule(eventId: "${eventId}") }` }),
      });
      const d = await res.json();
      if (d.errors) {
        setMessage('Error: ' + (d.errors[0]?.message || 'Reset failed').split('] ').pop());
      } else {
        setPlannerCards([]);
        setMessage('Schedule cleared. You can now regenerate.');
        setTimeout(() => window.location.reload(), 1200);
      }
    } catch (e: any) { setMessage('Error: ' + e.message); }
    setSaving(false);
  };

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-white">Schedule Builder</h1>
          <p className="text-sm text-slate-400 mt-0.5">Drag teams and judges to build the schedule</p>
        </div>
        <div className="flex items-center gap-3">
          {message && (
            <div className="px-3 py-1.5 rounded-lg bg-accent/10 border border-accent/20 text-xs text-accent animate-in">
              {message}
            </div>
          )}
          {isEventLocked && (
            <div className="px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
              🔒 Event is {event?.status} — schedule changes only via Command Centre
            </div>
          )}
          {!isEventLocked && totalScheduled > 0 && (
            <button type="button" onClick={resetSchedule} disabled={saving}
              className="px-4 py-2 bg-dark-700 hover:bg-red-900/30 text-slate-400 hover:text-red-400 text-xs font-medium rounded-lg border border-dark-500 hover:border-red-500/30 transition-all disabled:opacity-50">
              ↺ Reset Schedule
            </button>
          )}
          <button type="button"
            onClick={() => setGuided(v => !v)}
            title={guided
              ? 'Anchors an MD and a PS to each room, and holds vendors back for you to invite'
              : 'Standard scheduling — the solver assigns every seat'}
            className={`flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg border transition-all ${
              guided
                ? 'bg-accent/10 border-accent/40 text-accent'
                : 'bg-dark-700 border-dark-500 text-slate-400 hover:text-slate-300'
            }`}>
            <span className={`inline-block w-7 h-4 rounded-full transition-all relative ${
              guided ? 'bg-accent' : 'bg-dark-500'
            }`}>
              <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${
                guided ? 'left-3.5' : 'left-0.5'
              }`} />
            </span>
            {guided ? 'Guided' : 'Auto'}
          </button>
          <button type="button" onClick={autoGenerate} disabled={generating || unscheduledTeams.length === 0 || isEventLocked}
            className="px-4 py-2 bg-dark-700 hover:bg-dark-600 text-white text-xs font-medium rounded-lg border border-dark-500 transition-all disabled:opacity-50">
            {generating ? '⟳ Generating...' : guided ? '⚡ Generate (guided)' : '⚡ Auto-Generate'}
          </button>
          <button type="button" onClick={exportCsv} disabled={plannerCards.length === 0 && scheduledCards.length === 0}
            className="px-4 py-2 bg-dark-700 hover:bg-dark-600 text-white text-xs font-medium rounded-lg border border-dark-500 transition-all disabled:opacity-50">
            Export CSV
          </button>
          <button type="button" onClick={printSchedule} disabled={plannerCards.length === 0 && scheduledCards.length === 0}
            className="px-4 py-2 bg-dark-700 hover:bg-dark-600 text-white text-xs font-medium rounded-lg border border-dark-500 transition-all disabled:opacity-50">
            Print
          </button>
          <button type="button" onClick={confirmAll} disabled={saving || completePlannerCount === 0 || isEventLocked}
            className="px-4 py-2 bg-accent hover:bg-accent/90 text-white text-xs font-medium rounded-lg transition-all disabled:opacity-50 shadow-lg shadow-accent/20">
            ✓ Confirm {completePlannerCount > 0 ? `(${completePlannerCount})` : 'All'}
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-4 mb-4 flex-shrink-0">
        <div className="flex-1 h-2 bg-dark-700 rounded-full overflow-hidden">
          <div className="h-full bg-gradient-to-r from-accent to-success rounded-full transition-all duration-500"
            style={{ width: `${totalTeams > 0 ? ((totalScheduled + completePlannerCount) / totalTeams) * 100 : 0}%` }} />
        </div>
        <span className="text-xs text-slate-400 font-mono whitespace-nowrap">
          {totalScheduled + completePlannerCount} / {totalTeams} scheduled
        </span>
      </div>

      {/* Judge Pool */}
      <div className="flex-shrink-0 mb-4 rounded-xl border border-dark-600 bg-dark-800/50 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Judge Pool</span>
          <span className="text-[10px] text-slate-500">{judges.length} judges</span>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {judges.map((j: any) => {
            const load = judgeWorkload[j.id] || 0;
            const atMax = load >= j.maxSessions;
            return (
              <div key={j.id} draggable={!atMax}
                onDragStart={(e) => { e.dataTransfer.setData('judgeId', j.id); e.dataTransfer.setData('judgeName', j.name); }}
                className={`flex-shrink-0 rounded-lg border px-3 py-2 cursor-grab active:cursor-grabbing transition-all ${
                  atMax ? 'border-dark-600 bg-dark-700/30 opacity-40 cursor-not-allowed'
                    : 'border-dark-500 bg-dark-700 hover:border-accent/40 hover:bg-dark-600'
                }`}>
                <p className="text-xs font-medium text-white whitespace-nowrap">{j.name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <StatusBadge status={j.judgeType} />
                  <span className="text-[10px] text-slate-400 font-mono">{load}/{j.maxSessions}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filters — apply to the remaining pile and the planner alike, so
          "where are the AWS teams" answers for both at once. */}
      <div className="flex-shrink-0 mb-4 flex items-center gap-2 rounded-xl border border-dark-600 bg-dark-800/50 px-3 py-2">
        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mr-1">Filter</span>

        <select value={filterPlatform} onChange={(e) => setFilterPlatform(e.target.value)}
          className="bg-dark-900/60 border border-dark-600 rounded text-[11px] text-slate-300 px-2 py-1 outline-none focus:border-accent/50">
          <option value="">All platforms</option>
          {distinct('platform').map((p: any) => <option key={p} value={p}>{p}</option>)}
        </select>

        <select value={filterCountry} onChange={(e) => setFilterCountry(e.target.value)}
          className="bg-dark-900/60 border border-dark-600 rounded text-[11px] text-slate-300 px-2 py-1 outline-none focus:border-accent/50">
          <option value="">All countries</option>
          {distinct('country').map((c: any) => <option key={c} value={c}>{c}</option>)}
        </select>

        <select value={filterTrack} onChange={(e) => setFilterTrack(e.target.value)}
          className="bg-dark-900/60 border border-dark-600 rounded text-[11px] text-slate-300 px-2 py-1 outline-none focus:border-accent/50">
          <option value="">All tracks</option>
          {distinct('trackName').map((t: any) => <option key={t} value={t}>{t}</option>)}
        </select>

        <select value={filterUseCase} onChange={(e) => setFilterUseCase(e.target.value)}
          className="bg-dark-900/60 border border-dark-600 rounded text-[11px] text-slate-300 px-2 py-1 outline-none focus:border-accent/50 max-w-[220px]">
          <option value="">All use cases</option>
          {distinct('useCaseTitle').map((u: any) => <option key={u} value={u}>{u}</option>)}
        </select>

        {(filterPlatform || filterCountry || filterTrack || filterUseCase) && (
          <>
            <span className="text-[11px] text-slate-500">
              {applyFilters(unscheduledTeams).length} of {unscheduledTeams.length} remaining
              {' · '}
              {scheduledCards.filter((c: any) => matchesFilter(c)).length} placed
            </span>
            <button type="button" onClick={() => { setFilterPlatform(''); setFilterCountry(''); setFilterTrack(''); setFilterUseCase(''); }}
              className="ml-auto text-[11px] text-amber-400 hover:text-amber-300">
              Clear
            </button>
          </>
        )}
      </div>

      {/* Three-panel layout */}
      <div className="flex-1 flex gap-4 min-h-0 overflow-hidden">

        {/* LEFT: Unscheduled teams */}
        <div className="w-56 flex-shrink-0 flex flex-col rounded-xl border border-dark-600 bg-dark-800/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-dark-600 bg-dark-700/30 flex-shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">{unscheduledTeams.length} Remaining</span>
            </div>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)}
              className="mt-2 w-full bg-dark-900/60 border border-dark-600 rounded text-[10px] text-slate-300 px-2 py-1 outline-none">
              <option value="trackName">Group by Track</option>
              <option value="platform">Group by Platform</option>
              <option value="country">Group by Country</option>
              <option value="useCaseTitle">Group by Use case</option>
              <option value="organisation">Group by Organisation</option>
            </select>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-3">
            {Object.entries(groupTeams(unscheduledTeams)).map(([group, teams]) => (
              <div key={group}>
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-2 mb-1">{group}</p>
                <div className="space-y-1">
                  {(teams as any[]).map((t: any) => (
                    <div key={t.id}
                      onClick={() => addToPlanner(t)}
                      className="rounded-lg border border-dark-600 bg-dark-700/50 p-2.5 cursor-pointer hover:border-accent/40 hover:bg-dark-700 transition-all group">
                      <p className="text-xs font-medium text-white group-hover:text-accent transition-colors">{t.name}</p>
                      <p className="text-[10px] text-slate-500 mt-0.5 truncate">{t.projectName}</p>
                      {t.organisation && <p className="text-[10px] text-slate-600 mt-0.5">{t.organisation}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {unscheduledTeams.length === 0 && (
              <div className="py-8 text-center text-xs text-slate-500">All teams assigned</div>
            )}
          </div>
        </div>

        {/* CENTER: Planner */}
        <div className="flex-1 flex flex-col rounded-xl border border-dark-600 bg-dark-800/30 overflow-hidden">
          <div className="px-4 py-3 border-b border-dark-600 bg-dark-700/30 flex-shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">Planner</span>
              <span className="text-[10px] text-slate-500">
                {filtersActive
                  ? `${plannerCards.filter(matchesFilter).length} of ${plannerCards.length} shown`
                  : `${plannerCards.length} cards · ${completePlannerCount} ready`}
              </span>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {plannerCards.filter(matchesFilter).map((card) => {
              const complete = isCardComplete(card);
              const availSlots = card.roomId && card.date ? getAvailableSlots(card.roomId, card.date, card.teamId) : [];

              return (
                <div key={card.teamId}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const judgeId = e.dataTransfer.getData('judgeId');
                    if (judgeId) {
                      if (hasConflict(judgeId, card.teamId)) {
                        setMessage('⚠ Conflict: this judge cannot evaluate this team');
                        return;
                      }
                      if (card.slotId && judgeBusyInSlot(judgeId, card.slotId, card.teamId)) {
                        setMessage('⚠ Judge is busy in this time slot');
                        return;
                      }
                      addJudge(card.teamId, judgeId);
                    }
                  }}
                  className={`rounded-xl border-2 p-4 transition-all ${
                    complete ? 'border-success/40 bg-success/5' : 'border-dark-500 bg-dark-800/60'
                  }`}>
                  {/* Team info + remove button */}
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold text-white">{card.teamName}</p>
                        <CountryFlag code={card.country} size={15} />
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                        <p className="text-xs text-slate-400">{card.projectName}</p>
                        <PlatformChip platform={card.platform} size="xs" />
                      </div>
                      <div className="flex gap-2 mt-1">
                        {card.trackName && <span className="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded">{card.trackName}</span>}
                        {card.organisation && <span className="text-[10px] bg-dark-600 text-slate-400 px-1.5 py-0.5 rounded">{card.organisation}</span>}
                        {card.techStack && <span className="text-[10px] bg-dark-600 text-slate-400 px-1.5 py-0.5 rounded">{card.techStack}</span>}
                      </div>
                    </div>
                    <button type="button" onClick={() => removeFromPlanner(card.teamId)} className="text-slate-500 hover:text-error text-xs">✕</button>
                  </div>

                  {/* Room, Date, Slot selectors */}
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <select value={card.roomId || ''} onChange={(e) => updateCard(card.teamId, { roomId: e.target.value || null, slotId: null, slotStart: null, slotEnd: null })}
                      className="bg-dark-900/80 border border-dark-500 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent">
                      <option value="">Room</option>
                      {rooms.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                    <select value={card.date || ''} onChange={(e) => updateCard(card.teamId, { date: e.target.value || null, slotId: null, slotStart: null, slotEnd: null })}
                      className="bg-dark-900/80 border border-dark-500 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent">
                      <option value="">Date</option>
                      {dates.map(d => <option key={d} value={d}>{new Date(d + 'T00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}</option>)}
                    </select>
                    <select value={card.slotId || ''} onChange={(e) => {
                      const slot = allSlots.find((s: any) => s.id === e.target.value);
                      updateCard(card.teamId, { slotId: e.target.value || null, slotStart: slot?.startTime || null, slotEnd: slot?.endTime || null });
                    }}
                      className="bg-dark-900/80 border border-dark-500 rounded-lg px-2 py-1.5 text-xs text-white outline-none focus:border-accent"
                      disabled={!card.roomId || !card.date}>
                      <option value="">Time</option>
                      {availSlots.map((s: any) => (
                        <option key={s.id} value={s.id}>
                          {new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Judges zone */}
                  <div className="rounded-lg border border-dashed border-dark-500 p-2.5 min-h-[48px] bg-dark-900/30">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {card.judgeIds.map(jId => {
                        const judge = judges.find((j: any) => j.id === jId);
                        const conflict = hasConflict(jId, card.teamId);
                        return (
                          <span key={jId} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium ${
                            conflict ? 'bg-error/20 text-error border border-error/30' : 'bg-dark-600 text-slate-200 border border-dark-500'
                          }`}>
                            {judge?.name || jId.slice(0, 8)}
                            <button type="button" onClick={() => removeJudge(card.teamId, jId)} className="hover:text-error ml-0.5">✕</button>
                          </span>
                        );
                      })}
                      {card.judgeIds.length < (event?.maxJudgesPerTeam || 5) && (
                        <span className="text-[10px] text-slate-500 italic">
                          {card.judgeIds.length < (event?.minJudgesPerTeam || 3)
                            ? `Drop ${(event?.minJudgesPerTeam || 3) - card.judgeIds.length} more judge(s)`
                            : 'Drop to add more'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Card footer */}
                  <div className="flex items-center justify-between mt-3">
                    <div className="flex gap-1.5">
                      {!card.roomId && <span className="text-[10px] text-warning">⚠ Room</span>}
                      {!card.date && <span className="text-[10px] text-warning">⚠ Date</span>}
                      {!card.slotId && <span className="text-[10px] text-warning">⚠ Time</span>}
                      {card.judgeIds.length < (event?.minJudgesPerTeam || 3) && <span className="text-[10px] text-warning">⚠ Judges</span>}
                    </div>
                    <button type="button" onClick={() => confirmCard(card)} disabled={!complete || saving}
                      className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all ${
                        complete
                          ? 'bg-success hover:bg-success/90 text-white shadow-lg shadow-success/20'
                          : 'bg-dark-600 text-slate-500 cursor-not-allowed'
                      }`}>
                      {complete ? '✓ Confirm' : 'Incomplete'}
                    </button>
                  </div>
                </div>
              );
            })}

            {plannerCards.length > 0 && plannerCards.filter(matchesFilter).length === 0 && (
              <div className="text-center py-12 text-xs text-slate-500">
                No cards match the filter.
              </div>
            )}
            {plannerCards.length === 0 && (
              <div className="py-16 text-center">
                <p className="text-slate-500 text-sm">Click a team on the left to start planning</p>
                <p className="text-slate-600 text-xs mt-2">or use ⚡ Auto-Generate for AI scheduling</p>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: Scheduled */}
        <div className="w-56 flex-shrink-0 flex flex-col rounded-xl border border-dark-600 bg-dark-800/50 overflow-hidden">
          <div className="px-4 py-3 border-b border-dark-600 bg-dark-700/30 flex-shrink-0">
            <span className="text-xs font-semibold text-white">{totalScheduled} Scheduled</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {existingSessions.map((s: any) => (
              <div key={s.id} className="rounded-lg border border-success/20 bg-success/5 p-2.5">
                <p className="text-xs font-medium text-white">{s.teamName}</p>
                <div className="mt-1 space-y-0.5">
                  <p className="text-[10px] text-slate-400">{s.roomName}</p>
                  <p className="text-[10px] text-slate-400 font-mono">
                    {s.scheduledStart ? new Date(s.scheduledStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
                  </p>
                  <p className="text-[10px] text-slate-500">
                    {s.judges?.map((j: any) => j.judgeName).join(', ')}
                  </p>
                </div>
                <div className="mt-1.5">
                  <StatusBadge status={s.stage} />
                </div>
              </div>
            ))}
            {totalScheduled === 0 && (
              <div className="py-8 text-center text-xs text-slate-500">No sessions yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
