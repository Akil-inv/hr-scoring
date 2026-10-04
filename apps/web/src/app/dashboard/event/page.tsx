'use client';
import { useState, useEffect } from 'react';
import { useQuery } from '@/lib/use-graphql';
import { useAuthStore } from '@/lib/auth-store';
import { createClient } from '@/lib/graphql-client';
import { SET_ROOM_AVAILABILITY, ROOM_UNAVAILABILITY_QUERY, EVENTS_QUERY, ROOMS_QUERY, JUDGES_QUERY } from '@/lib/queries';
import { useEventId, useEventStore } from '@/lib/event-store';
import { CLOSE as CLOSE_EVENT } from '@/lib/event-control';
import ReadinessPlanner from '@/components/readiness-planner';
import CriteriaBuilder from '@/components/criteria-builder';

const TRACKS_QUERY = `query T($eventId: String!) { tracks(eventId: $eventId) { id name description status } }`;
const TIMESLOTS_QUERY = `query TS($eventId: String!) { timeSlots(eventId: $eventId) { id date startTime endTime slotType } }`;
const ROUNDS_QUERY = `query RD($eventId: String!) { judgingRounds(eventId: $eventId) { id name roundNumber status allowedTiers teamCount advanceCount } }`;
const SCORING_TEMPLATE_QUERY = `query ST($eventId: String!) { scoringTemplates(eventId: $eventId) { id name status maxTotal criteria { id name maxScore description displayOrder requiresComment guidanceText parentId } } }`;
const TEAMS_QUERY = `query TM($eventId: String!) { teams(eventId: $eventId) { id name projectName trackName status organisation techStack teamLeadEmail } }`;
const CREATE_EVENT = `mutation CE($input: CreateEventInput!) { createEvent(input: $input) { id name status } }`;
const UPDATE_EVENT = `mutation UE($id: String!, $input: UpdateEventInput!) { updateEvent(id: $id, input: $input) { id name status } }`;
const CREATE_ROOM = `mutation CR($input: CreateRoomInput!) { createRoom(input: $input) { id name } }`;
const DELETE_ROOM = `mutation DR($id: String!) { deleteRoom(id: $id) { id } }`;
const CREATE_TRACK = `mutation CT($input: CreateTrackInput!) { createTrack(input: $input) { id name } }`;
const DELETE_TRACK = `mutation DT($id: String!) { deleteTrack(id: $id) { id } }`;
const GEN_SLOTS = `mutation GS($input: GenerateTimeSlotsInput!) { generateTimeSlots(input: $input) { id slotType } }`;
const CLEAR_SLOTS = `mutation CS($eventId: String!, $date: String!) { clearTimeSlots(eventId: $eventId, date: $date) }`;
const CREATE_TEMPLATE = `mutation CST($input: CreateScoringTemplateInput!) { createScoringTemplate(input: $input) { id name status } }`;
const ADD_CRITERION = `mutation AC($input: AddCriterionInput!) { addCriterion(input: $input) { id name maxScore } }`;
const UPDATE_CRITERION = `mutation UC($id: String!, $input: UpdateCriterionInput!) { updateCriterion(id: $id, input: $input) { id name maxScore } }`;
const LOAD_RUBRIC = `mutation LR($eventId: String!) { loadStandardRubric(eventId: $eventId) { categoriesCreated rowsCreated } }`;
const DELETE_CRITERION = `mutation DC($id: String!) { removeCriterion(id: $id) }`;
const ACTIVATE_TEMPLATE = `mutation AT($id: String!) { activateScoringTemplate(id: $id) { id status } }`;

// Falls back to Singapore, not UTC. The schema default of 'UTC' was never a
// considered choice — an event that genuinely runs on UTC will say so.
const DEFAULT_TZ = 'Asia/Singapore';

// Module-level date helpers cannot see the loaded event, so they format in the
// default. That is display only; anything that decides AM from PM uses the
// event's own timezone below, where being wrong would change a schedule.
const TZ = DEFAULT_TZ;
const fmt = (s: string, o?: any) => { if (!s) return '-'; return new Date(s.length === 10 ? s + 'T00:00:00+08:00' : s).toLocaleDateString('en-SG', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', ...o }); };
const toDS = (s: string) => { if (!s) return ''; return new Date(s).toLocaleDateString('en-CA', { timeZone: TZ }); };
const getEvDays = (a: string, b: string) => { if (!a || !b) return []; const d: string[] = []; const s = new Date(a+'T00:00:00+08:00'); const e = new Date(b+'T00:00:00+08:00'); for (let x = new Date(s); x <= e; x.setTime(x.getTime()+86400000)) d.push(x.toLocaleDateString('en-CA',{timeZone:TZ})); return d; };
const slDS = (s: string) => s ? new Date(s).toLocaleDateString('en-CA',{timeZone:TZ}) : '';

/**
 * Drop Saturdays and Sundays from a list of days.
 *
 * Applied at the point the day list is derived, so the room availability table,
 * the Generate buttons and the capacity check all agree without each needing to
 * know about weekends.
 */
const dropWeekends = (days: string[]) =>
  days.filter(d => { const n = new Date(d + 'T12:00:00Z').getUTCDay(); return n !== 0 && n !== 6; });

export default function EventSetupPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const selectedEventId = useEventId();
  const selectEvent = useEventStore((s) => s.selectEvent);
  const setEvents = useEventStore((s) => s.setEvents);
  const [creatingNew, setCreatingNew] = useState(false);
  const event = creatingNew
    ? undefined
    : (evData?.events?.find((e: any) => e.id === selectedEventId));
  const eventId = event?.id;
  const { data: roomData } = useQuery<any>(ROOMS_QUERY, eventId ? { eventId } : undefined);
  const { data: judgeData } = useQuery<any>(JUDGES_QUERY, eventId ? { eventId } : undefined);
  const token = useAuthStore((s) => s.token);

  const rooms = roomData?.rooms || [];
  const judges = judgeData?.judges || [];

  const [tracks, setTracks] = useState<any[]>([]);
  const [timeSlots, setTimeSlots] = useState<any[]>([]);
  const [rounds, setRounds] = useState<any[]>([]);
  const [template, setTemplate] = useState<any>(null);
  const [teams, setTeams] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [msgT, setMsgT] = useState<'ok'|'err'>('ok');
  const [expanded, setExpanded] = useState<string|null>(null);

  // Event creation form
  const [ef, setEf] = useState({ name: 'UOB Innovation Challenge 2026', description: 'Annual innovation hackathon. Top 10 advance to Finals.', location: 'UOB Plaza, Level 5 Auditorium', timezone: 'Asia/Singapore', startDate: '', endDate: '', sessionDurationMinutes: 20, minJudgesPerTeam: 3, maxJudgesPerTeam: 5 });
  const [newRoom, setNewRoom] = useState({ name: '', capacity: 25, hasVideoConferencing: false });
  const [newTrack, setNewTrack] = useState({ name: '', description: '' });
  const [slotCfg, setSlotCfg] = useState({ startTime: '09:00', endTime: '17:00', lunchStart: '12:00', lunchEnd: '13:00', session: 20, brk: 5 });

  useEffect(() => {
    if (!eventId || !token) return;
    const c = createClient(token);
    c.query(TRACKS_QUERY, { eventId }).toPromise().then(r => setTracks(r.data?.tracks || []));
    c.query(TIMESLOTS_QUERY, { eventId }).toPromise().then(r => setTimeSlots(r.data?.timeSlots || []));
    c.query(ROUNDS_QUERY, { eventId }).toPromise().then(r => setRounds(r.data?.judgingRounds || []));
    c.query(TEAMS_QUERY, { eventId }).toPromise().then(r => setTeams(r.data?.teams || []));
    c.query(SCORING_TEMPLATE_QUERY, { eventId }).toPromise().then(r => {
      const t = r.data?.scoringTemplates || [];
      setTemplate(t.find((x: any) => x.status === 'ACTIVE') || t[0] || null);
    });
  }, [eventId, token]);

  useEffect(() => {
    if (event) {
      setEf(f => ({ ...f, name: event.name || f.name, description: event.description || f.description, location: event.location || f.location,
        timezone: event.timezone || f.timezone, startDate: toDS(event.startDate) || f.startDate, endDate: toDS(event.endDate) || f.endDate,
        sessionDurationMinutes: event.sessionDurationMinutes || f.sessionDurationMinutes,
        minJudgesPerTeam: event.minJudgesPerTeam || f.minJudgesPerTeam, maxJudgesPerTeam: event.maxJudgesPerTeam || f.maxJudgesPerTeam }));
    }
  }, [event]);

  const show = (m: string, t: 'ok'|'err' = 'ok') => { setMsg(m); setMsgT(t); if (t === 'ok') setTimeout(() => setMsg(''), 5000); };
  const run = async (mut: string, vars: any) => { const c = createClient(token); const r = await c.mutation(mut, vars).toPromise(); if (r.error) { show(r.error.message, 'err'); return null; } return r.data; };

  const reload = () => setTimeout(() => window.location.reload(), 800);

  const [importErrors, setImportErrors] = useState<any[]>([]);
  const uploadCsv = async (ep: string, file: File) => {
    if (!eventId || !token) return;
    setImportErrors([]);
    const fd = new FormData(); fd.append('file', file); fd.append('eventId', eventId);
    try {
      const r = await fetch(`/api/import/${ep}`, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: fd });
      const d = await r.json();
      if (d.imported !== undefined) {
        show(`${d.imported} ${ep} imported${d.errors?.length ? ` (${d.errors.length} rejected)` : ''}`);
        if (d.errors?.length) { setImportErrors(d.errors); }
        else { reload(); }
      } else if (d.message) { show(d.message, 'err'); reload(); }
    } catch (e: any) { show(e.message, 'err'); }
  };

  // Derived data
  const criteria = template?.criteria || [];
  // totalPoints is computed below, over categories only.
  // Most corporate events skip weekends, so that is the default. A coordinator
  // running one that does not will find the toggle beside the dates.
  const [skipWeekends, setSkipWeekends] = useState(true);

  const eventTz = (event?.timezone && event.timezone !== 'UTC') ? event.timezone : DEFAULT_TZ;
  const allRangeDays = getEvDays(ef.startDate, ef.endDate);
  const weekendCount = allRangeDays.length - dropWeekends(allRangeDays).length;
  const eventDays = skipWeekends ? dropWeekends(allRangeDays) : allRangeDays;
  const judgingSlots = timeSlots.filter((s: any) => s.slotType === 'JUDGING').length;

  // Availability is required for scheduling, so its coverage belongs on the
  // setup page rather than being discovered when a solve fails.
  // Rooms unavailable for part of a day, keyed `date|roomId|AM`. Absent means
  // available, so an untouched form generates slots exactly as before.
  const [roomOut, setRoomOut] = useState<Record<string, boolean>>({});
  const [roomGridOpen, setRoomGridOpen] = useState(false);

  // Seeded from what is stored, not from what was last typed. Generating slots
  // reloads the page, so local state alone lost every exclusion after the first
  // day — and exclusions set in an earlier sitting would never have appeared.
  const { data: roomUnavailData } = useQuery<any>(
    ROOM_UNAVAILABILITY_QUERY,
    eventId ? { eventId } : undefined,
  );

  useEffect(() => {
    const rows = roomUnavailData?.roomUnavailability;
    if (!rows) return;
    const seeded: Record<string, boolean> = {};
    for (const r of rows) {
      const day = new Date(r.date).toISOString().split('T')[0];
      seeded[`${day}|${r.roomId}|${r.session}`] = true;
    }
    setRoomOut(seeded);
  }, [roomUnavailData]);

  /**
   * Saves immediately. The state is updated first so the box responds to the
   * click, then reverted if the write fails — a control that looks like it
   * worked and did not is the fault this replaces.
   */
  const toggleRoomOut = async (day: string, roomId: string, session: 'AM' | 'PM') => {
    const key = `${day}|${roomId}|${session}`;
    const next = !roomOut[key];
    setRoomOut(prev => ({ ...prev, [key]: next }));

    const ok = await run(SET_ROOM_AVAILABILITY, {
      eventId, roomId, date: day, session, unavailable: next,
    });

    if (!ok) {
      setRoomOut(prev => ({ ...prev, [key]: !next }));
      show('Could not save room availability', 'err');
    }
  };

  const outFor = (day: string) =>
    Object.entries(roomOut)
      .filter(([k, on]) => on && k.startsWith(`${day}|`))
      .map(([k]) => {
        const [, roomId, session] = k.split('|');
        return { roomId, session };
      });

  const totalExcluded = Object.values(roomOut).filter(Boolean).length;

  const judgesWithAvailability = judges.filter((j: any) => (j.availability?.length ?? 0) > 0).length;
  const availabilityByDate = (() => {
    const counts = new Map<string, number>();
    for (const j of judges) {
      for (const a of (j.availability ?? [])) {
        const key = new Date(a.date).toISOString().split('T')[0];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => String(a).localeCompare(String(b))).map(([date, count]) => ({ date, count }));
  })();

  // Step completion checks
  const s1 = !!event; // Event created (false while creatingNew, showing the create form)
  // Step 2 is complete when the categories total 100 and each category's rows
  // total that category's own max. A flat sum of 100 is not sufficient —
  // five categories of 20 with no rows beneath them would pass while leaving
  // judges nothing to score.
  const categoryList = criteria.filter((c: any) => !c.parentId);
  const totalPoints = categoryList.reduce((s: number, c: any) => s + (c.maxScore || 0), 0);
  const everyCategoryBalances = categoryList.every((cat: any) => {
    const rows = criteria.filter((c: any) => c.parentId === cat.id);
    if (rows.length === 0) return false;
    return rows.reduce((s: number, r: any) => s + r.maxScore, 0) === cat.maxScore;
  });
  const s2 = categoryList.length > 0 && totalPoints === 100 && everyCategoryBalances;
  const s3 = tracks.length > 0; // Tracks exist
  const s4 = teams.length > 0; // Teams uploaded
  const s5 = judges.length > 0; // Judges uploaded
  const s6 = rooms.length > 0; // Rooms created
  const s7 = timeSlots.filter((s: any) => s.slotType === 'JUDGING').length > 0; // Time slots generated
  const allReady = s1 && s2 && s3 && s4 && s5 && s6 && s7;

  // ─── Capacity Validation ───
  const minJudges = ef.minJudgesPerTeam || 3;
  const maxJudges = ef.maxJudgesPerTeam || 5;
  const totalJudgeCapacity = judges.reduce((s: number, j: any) => s + (j.maxSessions || 4), 0);
  const judgeSessionsNeeded = teams.length * minJudges;
  const sessionDuration = ef.sessionDurationMinutes || 20;
  const slotsPerRoom = judgingSlots;
  // Number of days the event runs, used to turn total slots into slots/day.
  const evDayCount = Math.max(eventDays.length, 1);
  // Room-slots the scheduler can actually use. An excluded half-day removes that
  // room from every slot in it, so a capacity computed as rooms × slots reports
  // space that does not exist.
  const slotsPerHalfDay = (day: string, half: 'AM' | 'PM') =>
    timeSlots.filter((s: any) => {
      if (s.slotType !== 'JUDGING' || slDS(s.date) !== day) return false;
      const h = parseInt(new Intl.DateTimeFormat('en-GB', {
        timeZone: eventTz, hour: '2-digit', hour12: false,
      }).format(new Date(s.startTime)), 10);
      return (h < 12) === (half === 'AM');
    }).length;

  const excludedRoomSlots = Object.entries(roomOut)
    .filter(([, on]) => on)
    .reduce((sum, [key]) => {
      const [day, , half] = key.split('|');
      return sum + slotsPerHalfDay(day, half as 'AM' | 'PM');
    }, 0);

  const roomSessionCapacity =
    judgingSlots * Math.max(rooms.length, 1) - excludedRoomSlots;

  const capacityWarnings: string[] = [];
  if (allReady) {
    if (totalJudgeCapacity < judgeSessionsNeeded) {
      capacityWarnings.push(
        `Judge capacity shortage: ${teams.length} teams × ${minJudges} min judges = ${judgeSessionsNeeded} judge-sessions needed, but total judge capacity is only ${totalJudgeCapacity}. Increase judge max_sessions or reduce min judges per team.`
      );
    }
    if (roomSessionCapacity < teams.length) {
      capacityWarnings.push(
        `Room/slot shortage: ${rooms.length} rooms × ${judgingSlots} time slots = ${roomSessionCapacity} session slots, but ${teams.length} teams need scheduling. Add more rooms or time slots.`
      );
    }
    if (judges.length < minJudges) {
      capacityWarnings.push(
        `Not enough judges: ${judges.length} judges uploaded but each team needs at least ${minJudges}.`
      );
    }
    // Check individual judge loads
    const avgLoad = judgeSessionsNeeded / judges.length;
    const overloadedJudges = judges.filter((j: any) => (j.maxSessions || 4) < avgLoad);
    if (overloadedJudges.length > judges.length * 0.5) {
      capacityWarnings.push(
        `Most judges have low max_sessions (avg needed: ${avgLoad.toFixed(1)} per judge). Consider increasing capacity for: ${overloadedJudges.slice(0, 3).map((j: any) => j.name + '(' + j.maxSessions + ')').join(', ')}`
      );
    }
  }

  // New criterion form
  const [newCrit, setNewCrit] = useState({ name: '', maxScore: 10, description: '', requiresComment: false });
  // L1 is most senior, L4 least. Vendors sit on their own V1-V3 track at equal
  // standing to each other. L1 judges are held back for the final round; L2
  // judges anchor a room for the whole event.
  const tierColors: Record<string,string> = {
    L1: '#ef4444', L2: '#f59e0b', L3: '#3b82f6', L4: '#64748b',
    V1: '#10b981', V2: '#10b981', V3: '#10b981',
  };
  const tierLabels: Record<string,string> = {
    L1: 'Leadership (final round)', L2: 'MD - room anchor', L3: 'ED', L4: 'Senior',
    V1: 'Vendor', V2: 'Vendor', V3: 'Vendor',
  };
  const typeColors: Record<string,string> = { TECHNICAL: '#3b82f6', BUSINESS: '#10b981', DOMAIN: '#7c3aed', INNOVATION: '#f59e0b', EXECUTIVE: '#ef4444' };

  const [editingStep, setEditingStep] = useState<number|null>(null);

  /**
   * Which steps the coordinator has explicitly opened or closed.
   *
   * Absent means fall back to the rule: a finished step is collapsed, an
   * unfinished one is open. So the page opens on the work that remains without
   * anyone having to click, and a returning coordinator sees one section rather
   * than eight.
   */
  const [stepOpen, setStepOpen] = useState<Record<number, boolean>>({});

  const isStepOpen = (num: number, done: boolean) =>
    stepOpen[num] !== undefined ? stepOpen[num] : !done;

  const toggleStep = (num: number, done: boolean) =>
    setStepOpen(prev => ({ ...prev, [num]: !isStepOpen(num, done) }));

  const stepStyle = (num: number, done: boolean, active: boolean, isEditing: boolean) => ({
    wrapper: { marginBottom: 16, opacity: active ? 1 : 0.35, pointerEvents: (active ? 'auto' : 'none') as any, transition: 'opacity 0.3s' },
    circle: { width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600, flexShrink: 0 as any,
      background: done ? 'rgba(16,185,129,0.15)' : active ? 'rgba(124,58,237,0.15)' : 'rgba(255,255,255,0.04)',
      color: done ? '#10b981' : active ? '#a78bfa' : '#6b7a90',
      border: `1.5px solid ${done ? 'rgba(16,185,129,0.3)' : active ? 'rgba(124,58,237,0.3)' : 'rgba(255,255,255,0.06)'}` },
    title: { fontSize: 15, fontWeight: 500, color: done ? '#10b981' : active ? '#fff' : '#6b7a90', flex: 1 },
    body: { marginLeft: 42, padding: '16px 20px', borderRadius: 12,
      // Hidden rather than unmounted: the inputs inside keep their state, so
      // collapsing a half-filled step and coming back to it loses nothing.
      display: (isStepOpen(num, done) || isEditing) ? 'block' : 'none',
      border: `1px solid ${isEditing ? 'rgba(124,58,237,0.3)' : done ? 'rgba(16,185,129,0.15)' : active ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)'}`,
      background: isEditing ? 'rgba(124,58,237,0.03)' : 'rgba(255,255,255,0.02)' },
    header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10,
      cursor: active ? 'pointer' : 'default' } as any,
  });

  return (
    <div>
      <style>{`
        .hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
        .hdr h1{font-size:22px;font-weight:600;color:#fff}
        .hdr-sub{font-size:14px;color:#94a3b8;margin-top:2px}
        .msg{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;position:fixed;top:16px;right:16px;z-index:50}
        .msg-ok{background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#34d399}
        .msg-err{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#f87171}
        .btn{padding:7px 16px;border-radius:7px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid;transition:all 0.15s}
        .btn-pri{background:#7c3aed;border-color:#7c3aed;color:#fff}.btn-pri:hover{background:#6d28d9}
        .btn-sec{background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.1);color:#fff}.btn-sec:hover{background:rgba(255,255,255,0.08)}
        .btn-sm{padding:5px 12px;font-size:12px}
        .btn-danger{background:rgba(239,68,68,0.08);border-color:rgba(239,68,68,0.15);color:#f87171}.btn-danger:hover{background:rgba(239,68,68,0.15)}
        .btn-success{background:rgba(16,185,129,0.08);border-color:rgba(16,185,129,0.15);color:#10b981}.btn-success:hover{background:rgba(16,185,129,0.15)}
        .fg{display:grid;grid-template-columns:1fr 1fr;gap:10px}
        .fg3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
        .row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:0.5px solid rgba(255,255,255,0.04)}
        .row:last-child{border-bottom:none}
        .lbl{font-size:14px;color:#94a3b8}
        .val{font-size:14px;color:#fff;font-weight:500}
        .inp{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:7px 12px;color:#fff;font-size:14px;width:100%}
        .inp:focus{border-color:rgba(124,58,237,0.4);outline:none}
        .inp-sm{width:80px;text-align:center}
        .item{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:8px;background:rgba(255,255,255,0.02);border:0.5px solid rgba(255,255,255,0.04);margin-bottom:6px}
        .item-name{font-size:14px;color:#fff;font-weight:500}
        .item-sub{font-size:12px;color:#6b7a90}
        .add-row{display:flex;gap:8px;margin-top:8px}
        .pill{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;margin:2px}
        .ready-banner{padding:16px 20px;border-radius:12px;border:1.5px solid rgba(16,185,129,0.3);background:rgba(16,185,129,0.06);text-align:center;margin-top:20px}
        .tbl{width:100%;border-collapse:collapse;table-layout:fixed}
        .tbl th{text-align:left;font-size:11px;color:#6b7a90;font-weight:600;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,0.06)}
        .tbl td{padding:6px 4px;font-size:13px;border-bottom:0.5px solid rgba(255,255,255,0.03);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      `}</style>

      {msg && <div className={`msg ${msgT === 'ok' ? 'msg-ok' : 'msg-err'}`}>{msg}</div>}

      <div className="hdr">
        <div>
          <h1>Event setup</h1>
          <p className="hdr-sub">{s1 ? event.name : 'Create your event to get started'}</p>
        </div>
        {s1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ padding: '4px 12px', borderRadius: 6, fontSize: 13, fontWeight: 500, background: event.status === 'ACTIVE' ? 'rgba(16,185,129,0.1)' : 'rgba(107,122,144,0.1)', color: event.status === 'ACTIVE' ? '#10b981' : '#6b7a90' }}>{event.status}</span>
            {event.status === 'DRAFT' && (
              <button
                type="button"
                className="btn btn-pri btn-sm"
                onClick={async () => {
                  if (!confirm(`Activate "${event.name}"? Judges will be able to score once the scoring template is also active.`)) return;
                  const d = await run(UPDATE_EVENT, { id: event.id, input: { status: 'ACTIVE' } });
                  if (d) { show('Event activated'); reload(); }
                }}
              >
                Activate event
              </button>
            )}
            {event.status === 'ACTIVE' && (
              <button
                type="button"
                className="btn btn-sec btn-sm"
                onClick={async () => {
                  if (!confirm(`Mark "${event.name}" as completed? This closes judging and locks scoring \u2014 judges will no longer be able to submit or change scores. Make sure all scoring is finished first.`)) return;
                  const d = await run(CLOSE_EVENT, { e: event.id });
                  if (d) { show('Event marked completed \u2014 scoring is now locked'); reload(); }
                }}
              >
                Mark completed
              </button>
            )}
          </div>
        )}
      </div>

      {/* ─── STEP 1: Create Event ─── */}
      <div style={stepStyle(1, s1, true, editingStep === 1).wrapper}>
        <div style={stepStyle(1, s1, true, editingStep === 1).header}
            onClick={() => { if (true) toggleStep(1, s1); }}>
          <div style={stepStyle(1, s1, true, editingStep === 1).circle}>{(s1 && editingStep !== 1) ? '\u2713' : 1}</div>
          <span style={stepStyle(1, s1, true, editingStep === 1).title}>Create event</span>
          {s1 && editingStep !== 1 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(1)}>Edit</button>}
          {editingStep === 1 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(null)}>Done editing</button>}
          {s1 && editingStep !== 1 && <span style={{ fontSize: 11, color: '#10b981', padding: '2px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.08)' }}>Done</span>}
          <span style={{ fontSize: 12, color: '#8ea3bc', marginLeft: 2 }}>{isStepOpen(1, s1) ? '\u25B4' : '\u25BE'}</span>
          {s1 && editingStep !== 1 && (
            <button type="button" className="btn btn-sec btn-sm" style={{ marginLeft: 'auto' }}
              onClick={() => {
                // Blank the form. An effect prefills `ef` from the current
                // event, so without this the create form opens holding the
                // existing event's name and dates.
                setEf({ name: '', description: '', location: '', timezone: 'Asia/Singapore',
                  startDate: '', endDate: '', sessionDurationMinutes: 20,
                  minJudgesPerTeam: 3, maxJudgesPerTeam: 5 });
                setCreatingNew(true);
                setEditingStep(null);
              }}>
              + New event
            </button>
          )}
          {creatingNew && (
            <button type="button" className="btn btn-sec btn-sm" style={{ marginLeft: 'auto' }}
              onClick={() => setCreatingNew(false)}>
              Cancel new event
            </button>
          )}
        </div>
        <div style={stepStyle(1, s1, true, editingStep === 1).body}>
        {(!s1 || editingStep === 1) ? (
          <>
            <div className="fg">
              <div><div className="lbl" style={{marginBottom:4}}>Event name</div><input className="inp" value={ef.name} onChange={e => setEf({...ef, name: e.target.value})} /></div>
              <div><div className="lbl" style={{marginBottom:4}}>Location</div><input className="inp" value={ef.location} onChange={e => setEf({...ef, location: e.target.value})} /></div>
              <div><div className="lbl" style={{marginBottom:4}}>Start date</div><input type="date" className="inp" value={ef.startDate} onChange={e => setEf({...ef, startDate: e.target.value})} /></div>
              <div><div className="lbl" style={{marginBottom:4}}>End date</div><input type="date" className="inp" value={ef.endDate} onChange={e => setEf({...ef, endDate: e.target.value})} /></div>
            </div>
            {weekendCount > 0 && (
              <label style={{display:'flex',alignItems:'center',gap:8,marginTop:10,cursor:'pointer'}}>
                <input type="checkbox" checked={skipWeekends}
                  onChange={e => setSkipWeekends(e.target.checked)} />
                <span style={{fontSize:13,color:'#b4c2d4'}}>
                  Skip weekends
                </span>
                <span style={{fontSize:13,color:'#8ea3bc'}}>
                  {skipWeekends
                    ? `${weekendCount} weekend day(s) excluded — ${eventDays.length} judging day(s)`
                    : `${allRangeDays.length} day(s) including weekends`}
                </span>
              </label>
            )}
            <div><div className="lbl" style={{marginBottom:4,marginTop:10}}>Description</div><textarea className="inp" rows={2} value={ef.description} onChange={e => setEf({...ef, description: e.target.value})} /></div>
            <div className="fg" style={{marginTop:10}}>
              <div><div className="lbl" style={{marginBottom:4}}>Session duration (min)</div><input type="number" className="inp" value={ef.sessionDurationMinutes} onChange={e => setEf({...ef, sessionDurationMinutes: Number(e.target.value)})} /></div>
              <div className="fg">
                <div><div className="lbl" style={{marginBottom:4}}>Min judges</div><input type="number" className="inp" value={ef.minJudgesPerTeam} onChange={e => setEf({...ef, minJudgesPerTeam: Number(e.target.value)})} /></div>
                <div><div className="lbl" style={{marginBottom:4}}>Max judges</div><input type="number" className="inp" value={ef.maxJudgesPerTeam} onChange={e => setEf({...ef, maxJudgesPerTeam: Number(e.target.value)})} /></div>
              </div>
            </div>
            <button type="button" className="btn btn-pri" style={{marginTop:14}} onClick={async () => {
              if (!ef.name || !ef.startDate || !ef.endDate) { show('Name and dates required', 'err'); return; }
              if (s1) {
                const input: any = { name: ef.name, description: ef.description, location: ef.location, timezone: ef.timezone,
                  sessionDurationMinutes: ef.sessionDurationMinutes, minJudgesPerTeam: ef.minJudgesPerTeam, maxJudgesPerTeam: ef.maxJudgesPerTeam };
                if (ef.startDate) input.startDate = ef.startDate + 'T00:00:00Z';
                if (ef.endDate) input.endDate = ef.endDate + 'T00:00:00Z';
                const d = await run(UPDATE_EVENT, { id: event.id, input });
                if (d) { show('Event updated'); setEditingStep(null); reload(); }
              } else {
                const d = await run(CREATE_EVENT, { input: { ...ef, startDate: ef.startDate+'T00:00:00Z', endDate: ef.endDate+'T00:00:00Z' } });
                if (d) {
                  show('Event created');
                  const created = d.createEvent;
                  if (created?.id) {
                    // Add to the store and select it so the sidebar and every
                    // other page point at the new event, not the old one.
                    const existing = (evData?.events || []).map((e: any) => ({
                      id: e.id, name: e.name, status: e.status,
                    }));
                    setEvents([...existing, { id: created.id, name: created.name, status: created.status }]);
                    selectEvent(created.id);
                  }
                  setCreatingNew(false);
                  reload();
                }
              }
            }}>{s1 ? 'Save changes' : 'Create event'}</button>
          </>
        ) : (
          <div>
            <div className="fg">
              <div className="row"><span className="lbl">Name</span><span className="val">{event.name}</span></div>
              <div className="row"><span className="lbl">Location</span><span className="val">{event.location || '-'}</span></div>
              <div className="row"><span className="lbl">Dates</span><span className="val">{fmt(ef.startDate)} - {fmt(ef.endDate)}</span></div>
              <div className="row"><span className="lbl">Session</span><span className="val">{ef.sessionDurationMinutes} min, {ef.minJudgesPerTeam}-{ef.maxJudgesPerTeam} judges</span></div>
            </div>
          </div>
        )}
        </div>
      </div>

      {/* ─── STEP 2: Scoring Criteria ─── */}
      <div style={stepStyle(2, s2, s1, editingStep === 2).wrapper}>
        <div style={stepStyle(2, s2, s1, editingStep === 2).header}
            onClick={() => { if (s1) toggleStep(2, s2); }}>
          <div style={stepStyle(2, s2, s1, editingStep === 2).circle}>{(s2 && editingStep !== 2) ? '\u2713' : 2}</div>
          <span style={stepStyle(2, s2, s1, editingStep === 2).title}>{`Scoring criteria (${criteria.length}) — ${totalPoints}/100 pts`}</span>
          {s2 && s1 && editingStep !== 2 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(2)}>Edit</button>}
          {editingStep === 2 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(null)}>Done editing</button>}
          {s2 && editingStep !== 2 && <span style={{ fontSize: 11, color: '#10b981', padding: '2px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.08)' }}>Done</span>}
          <span style={{ fontSize: 12, color: '#8ea3bc', marginLeft: 2 }}>{isStepOpen(2, s2) ? '\u25B4' : '\u25BE'}</span>
        </div>
        <div style={stepStyle(2, s2, s1, editingStep === 2).body}>
          <CriteriaBuilder
            criteria={criteria}
            maxTotal={100}
            status={template?.status}
            onActivate={async () => {
              if (!template?.id) {
                show('Add the criteria first.', 'err');
                return;
              }
              const res = await run(ACTIVATE_TEMPLATE, { id: template.id });
              if (res) {
                show('Rubric marked done — judges can now score against it.');
                reload();
              }
            }}
            onLoadRubric={async () => {
              const res = await run(LOAD_RUBRIC, { eventId });
              if (res) {
                const r = res.loadStandardRubric;
                show(`Loaded ${r.categoriesCreated} categories and ${r.rowsCreated} rows`);
                reload();
              }
            }}
            onAddCategory={async (name: string, maxScore: number) => {
              let tplId = template?.id;
              if (!tplId) {
                const res = await run(CREATE_TEMPLATE, { input: { eventId, name: ef.name } });
                if (!res) return;
                tplId = res.createScoringTemplate.id;
              }
              const res = await run(ADD_CRITERION, {
                input: { templateId: tplId, name, maxScore, weight: 1.0 },
              });
              if (res) { show(`"${name}" added`); reload(); }
            }}
            onAddRow={async (parentId: string, name: string, maxScore: number, guidanceText: string, requiresComment: boolean) => {
              const res = await run(ADD_CRITERION, {
                input: {
                  templateId: template?.id,
                  parentId,
                  name,
                  maxScore,
                  guidanceText: guidanceText || undefined,
                  requiresComment,
                  weight: 1.0,
                },
              });
              if (res) { show(`"${name}" added`); reload(); }
            }}
            onUpdate={async (id: string, changes: any) => {
              const res = await run(UPDATE_CRITERION, { id, input: changes });
              if (res) { show('Updated'); reload(); }
            }}
            onRemove={async (id: string, name: string) => {
              if (!confirm(`Remove "${name}"? Any rows beneath it go too.`)) return;
              await run(DELETE_CRITERION, { id });
              show(`"${name}" removed`);
              reload();
            }}
          />
        </div>
      </div>

      {/* ─── STEP 3: Challenge Tracks ─── */}
      <div style={stepStyle(3, s3, s1 && s2, editingStep === 3).wrapper}>
        <div style={stepStyle(3, s3, s1 && s2, editingStep === 3).header}
            onClick={() => { if (s1 && s2) toggleStep(3, s3); }}>
          <div style={stepStyle(3, s3, s1 && s2, editingStep === 3).circle}>{(s3 && editingStep !== 3) ? '\u2713' : 3}</div>
          <span style={stepStyle(3, s3, s1 && s2, editingStep === 3).title}>{`Challenge tracks (${tracks.length})`}</span>
          {s7 && s1 && s2 && s3 && s4 && s5 && s6 && editingStep !== 7 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(7)}>Edit</button>}
          {editingStep === 7 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(null)}>Done editing</button>}
          {s3 && editingStep !== 3 && <span style={{ fontSize: 11, color: '#10b981', padding: '2px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.08)' }}>Done</span>}
          <span style={{ fontSize: 12, color: '#8ea3bc', marginLeft: 2 }}>{isStepOpen(3, s3) ? '\u25B4' : '\u25BE'}</span>
        </div>
        <div style={stepStyle(3, s3, s1 && s2, editingStep === 3).body}>
        {tracks.map(t => (
          <div className="item" key={t.id}>
            <div><span className="item-name">{t.name}</span>{t.description && <div className="item-sub">{t.description}</div>}</div>
            <button type="button" className="btn btn-danger btn-sm" onClick={async () => { if (!confirm(`Remove "${t.name}"?`)) return; await run(DELETE_TRACK, { id: t.id }); show(`"${t.name}" removed`); reload(); }}>Remove</button>
          </div>
        ))}
        <div className="add-row">
          <input className="inp" placeholder="Track name" value={newTrack.name} onChange={e => setNewTrack({...newTrack, name: e.target.value})} style={{flex:2}} />
          <input className="inp" placeholder="Description" value={newTrack.description} onChange={e => setNewTrack({...newTrack, description: e.target.value})} style={{flex:3}} />
          <button type="button" className="btn btn-pri btn-sm" onClick={async () => {
            if (!newTrack.name.trim()) return;
            await run(CREATE_TRACK, { input: { eventId, name: newTrack.name.trim(), description: newTrack.description } });
            show(`"${newTrack.name}" added`); setNewTrack({ name: '', description: '' }); reload();
          }}>Add</button>
        </div>
        {!s2 && <div style={{fontSize:13,color:'#f59e0b',marginTop:8}}>Add at least one track to continue</div>}
      </div>
      </div>

      {/* ─── STEP 4: Upload Teams ─── */}
      <div style={stepStyle(4, s4, s1 && s2 && s3, editingStep === 4).wrapper}>
        <div style={stepStyle(4, s4, s1 && s2 && s3, editingStep === 4).header}
            onClick={() => { if (s1 && s2 && s3) toggleStep(4, s4); }}>
          <div style={stepStyle(4, s4, s1 && s2 && s3, editingStep === 4).circle}>{(s4 && editingStep !== 4) ? '\u2713' : 4}</div>
          <span style={stepStyle(4, s4, s1 && s2 && s3, editingStep === 4).title}>{`Teams (${teams.length})`}</span>
          {s7 && s1 && s2 && s3 && s4 && s5 && s6 && editingStep !== 7 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(7)}>Edit</button>}
          {editingStep === 7 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(null)}>Done editing</button>}
          {s4 && editingStep !== 4 && <span style={{ fontSize: 11, color: '#10b981', padding: '2px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.08)' }}>Done</span>}
          <span style={{ fontSize: 12, color: '#8ea3bc', marginLeft: 2 }}>{isStepOpen(4, s4) ? '\u25B4' : '\u25BE'}</span>
        </div>
        <div style={stepStyle(4, s4, s1 && s2 && s3, editingStep === 4).body}>
        {teams.length > 0 && (
          <>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                {tracks.map(t => { const c = teams.filter((tm: any) => tm.trackName === t.name).length; return c > 0 ? <span key={t.id} className="pill" style={{background:'rgba(124,58,237,0.1)',color:'#a78bfa',border:'1px solid rgba(124,58,237,0.2)'}}>{t.name}: {c}</span> : null; })}
              </div>
              <button type="button" className="btn btn-danger btn-sm" onClick={async () => {
                if (!confirm(`Remove all ${teams.length} teams? You can re-upload the CSV.`)) return;
                for (const t of teams) { await run(`mutation D($id: String!) { deleteTeam(id: $id) { id } }`, { id: t.id }); }
                show(`All teams removed`); reload();
              }}>Clear all</button>
            </div>
            {expanded === 'teams' ? (
              <div style={{maxHeight:350,overflowY:'auto',marginBottom:8}}>
                <table className="tbl"><thead><tr><th style={{width:'20%'}}>Team</th><th style={{width:'24%'}}>Project</th><th style={{width:'15%'}}>Track</th><th style={{width:'15%'}}>Org</th><th style={{width:'14%'}}>Tech</th><th style={{width:'12%'}}></th></tr></thead>
                <tbody>{teams.map(t => (<tr key={t.id}>
                  <td style={{color:'#fff',fontWeight:500}}>{t.name}</td>
                  <td style={{color:'#94a3b8'}}>{t.projectName}</td>
                  <td><span className="pill" style={{background:'rgba(124,58,237,0.1)',color:'#a78bfa'}}>{t.trackName}</span></td>
                  <td style={{color:'#94a3b8'}}>{t.organisation}</td>
                  <td style={{color:'#6b7a90',fontSize:11}}>{t.techStack}</td>
                  <td style={{textAlign:'right'}}><span style={{fontSize:11,color:'#ef4444',cursor:'pointer'}} onClick={async () => {
                    if (!confirm(`Remove "${t.name}"?`)) return;
                    await run(`mutation D($id: String!) { deleteTeam(id: $id) { id } }`, { id: t.id });
                    show(`"${t.name}" removed`); reload();
                  }}>Remove</span></td>
                </tr>))}</tbody></table>
                <button type="button" className="btn btn-sec btn-sm" style={{marginTop:6}} onClick={() => setExpanded(null)}>Collapse</button>
              </div>
            ) : (
              <button type="button" className="btn btn-sec btn-sm" onClick={() => setExpanded('teams')}>View all {teams.length} teams</button>
            )}
          </>
        )}
        <div style={{display:'flex',gap:10,alignItems:'center',marginTop:8}}>
          <label className="btn btn-pri btn-sm" style={{cursor:'pointer'}}>
            {teams.length > 0 ? 'Upload more' : 'Upload teams CSV'}
            <input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onChange={e => { if (e.target.files?.[0]) uploadCsv('teams', e.target.files[0]); }} />
          </label>
          <span style={{fontSize:12,color:'#6b7a90'}}>Columns: team_name, project_name, track_name, team_lead_email, organisation, tech_stack, problem_statement, solution_summary, country (TH SG MY ID VN HK CN), platform (AWS GCP CLOUDERA PURPLE FABRIC QLIK SENSE INTERNAL OTHER)</span>
        </div>
        {!s3 && <div style={{fontSize:13,color:'#f59e0b',marginTop:8}}>Upload a CSV to load teams. Track names must match the tracks above.</div>}

      </div>
      </div>

      {/* ─── STEP 5: Upload Judges ─── */}
      <div style={stepStyle(5, s5, s1 && s2 && s3 && s4, editingStep === 5).wrapper}>
        <div style={stepStyle(5, s5, s1 && s2 && s3 && s4, editingStep === 5).header}
            onClick={() => { if (s1 && s2 && s3 && s4) toggleStep(5, s5); }}>
          <div style={stepStyle(5, s5, s1 && s2 && s3 && s4, editingStep === 5).circle}>{(s5 && editingStep !== 5) ? '\u2713' : 5}</div>
          <span style={stepStyle(5, s5, s1 && s2 && s3 && s4, editingStep === 5).title}>{`Judges (${judges.length})`}</span>
          {s7 && s1 && s2 && s3 && s4 && s5 && s6 && editingStep !== 7 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(7)}>Edit</button>}
          {editingStep === 7 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(null)}>Done editing</button>}
          {s5 && editingStep !== 5 && <span style={{ fontSize: 11, color: '#10b981', padding: '2px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.08)' }}>Done</span>}
          <span style={{ fontSize: 12, color: '#8ea3bc', marginLeft: 2 }}>{isStepOpen(5, s5) ? '\u25B4' : '\u25BE'}</span>
        </div>
        <div style={stepStyle(5, s5, s1 && s2 && s3 && s4, editingStep === 5).body}>
        {judges.length > 0 && (
          <>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              {Object.entries(tierLabels).map(([tier, label]) => {
                const c = judges.filter((j: any) => j.judgeTier === tier).length;
                return c > 0 ? <span key={tier} className="pill" style={{background:`${tierColors[tier]}18`,color:tierColors[tier],border:`1px solid ${tierColors[tier]}30`}}>{tier} {label}: {c}</span> : null;
              })}
              </div>
              <button type="button" className="btn btn-danger btn-sm" onClick={async () => {
                if (!confirm(`Remove all ${judges.length} judges? You can re-upload the CSV.`)) return;
                for (const j of judges) { await run(`mutation D($id: String!) { deleteJudge(id: $id) { id } }`, { id: j.id }); }
                show('All judges removed'); reload();
              }}>Clear all</button>
            </div>
            {expanded === 'judges' ? (
              <div style={{maxHeight:350,overflowY:'auto',marginBottom:8}}>
                <table className="tbl"><thead><tr><th style={{width:'20%'}}>Name</th><th style={{width:'20%'}}>Organisation</th><th style={{width:'12%'}}>Type</th><th style={{width:'8%'}}>Tier</th><th style={{width:'22%'}}>Email</th><th style={{width:'8%'}}>Max</th><th style={{width:'10%'}}></th></tr></thead>
                <tbody>{judges.map((j: any) => (<tr key={j.id}><td style={{color:'#fff',fontWeight:500}}>{j.name}</td><td style={{color:'#94a3b8'}}>{j.organisation}</td><td><span className="pill" style={{background:`${typeColors[j.judgeType]||'#6b7a90'}15`,color:typeColors[j.judgeType]||'#6b7a90'}}>{j.judgeType}</span></td><td style={{color:tierColors[j.judgeTier]||'#6b7a90',fontWeight:600}}>{j.judgeTier||'L1'}</td><td style={{color:'#6b7a90',fontSize:11}}>{j.email}</td><td style={{color:'#94a3b8',textAlign:'center'}}>{j.maxSessions}</td>
                  <td style={{textAlign:'right'}}><span style={{fontSize:11,color:'#ef4444',cursor:'pointer'}} onClick={async () => {
                    if (!confirm(`Remove "${j.name}"?`)) return;
                    await run(`mutation D($id: String!) { deleteJudge(id: $id) { id } }`, { id: j.id });
                    show(`"${j.name}" removed`); reload();
                  }}>Remove</span></td></tr>))}</tbody></table>
                <button type="button" className="btn btn-sec btn-sm" style={{marginTop:6}} onClick={() => setExpanded(null)}>Collapse</button>
              </div>
            ) : (
              <button type="button" className="btn btn-sec btn-sm" onClick={() => setExpanded('judges')}>View all {judges.length} judges</button>
            )}
          </>
        )}
        <div style={{display:'flex',gap:10,alignItems:'center',marginTop:8}}>
          <label className="btn btn-pri btn-sm" style={{cursor:'pointer'}}>
            {judges.length > 0 ? 'Upload more' : 'Upload judges CSV'}
            <input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}} onChange={e => { if (e.target.files?.[0]) uploadCsv('judges', e.target.files[0]); }} />
          </label>
          <span style={{fontSize:12,color:'#6b7a90'}}>Columns: name, email, phone, judge_type, judge_tier, organisation, max_sessions, standby</span>
        </div>
        {!s4 && <div style={{fontSize:13,color:'#f59e0b',marginTop:8}}>Upload a CSV to load judges.</div>}

        {judges.length > 0 && (
          <div style={{marginTop:16,paddingTop:14,borderTop:'0.5px solid rgba(255,255,255,0.06)'}}>
            <div style={{display:'flex',alignItems:'baseline',gap:10,marginBottom:8}}>
              <span style={{fontSize:13,fontWeight:500,color:'#fff'}}>Judge availability</span>
              <span style={{fontSize:12,color: judgesWithAvailability === judges.length ? '#10b981' : '#f59e0b'}}>
                {judgesWithAvailability} of {judges.length} covered
              </span>
            </div>

            {/* The count per day is the number that matters. "93 rows
                imported" says nothing about whether the 31st has an anchor. */}
            {availabilityByDate.length > 0 && (
              <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:10}}>
                {availabilityByDate.map((d: any) => (
                  <span key={d.date} style={{fontSize:11,color:'#94a3b8',background:'rgba(255,255,255,0.04)',
                    border:'0.5px solid rgba(255,255,255,0.07)',padding:'3px 9px',borderRadius:5}}>
                    {new Date(d.date).toLocaleDateString('en-SG',{day:'numeric',month:'short'})}
                    <span style={{marginLeft:6,color:'#e2e8f0',fontWeight:500}}>{d.count}</span>
                  </span>
                ))}
              </div>
            )}

            <div style={{display:'flex',gap:10,alignItems:'center'}}>
              <label className="btn btn-sec btn-sm" style={{cursor:'pointer'}}>
                {judgesWithAvailability > 0 ? 'Replace availability' : 'Upload availability CSV'}
                <input type="file" accept=".xlsx,.xls,.csv" style={{display:'none'}}
                  onChange={e => { if (e.target.files?.[0]) uploadCsv('availability', e.target.files[0]); }} />
              </label>
              <span style={{fontSize:12,color:'#6b7a90'}}>
                Columns: email, date (YYYY-MM-DD), session (AM / PM / BOTH) &mdash; one row per judge per day
              </span>
            </div>

            {judgesWithAvailability < judges.length && (
              <div style={{fontSize:13,color:'#f59e0b',marginTop:8}}>
                {judges.length - judgesWithAvailability} judge(s) have no availability and cannot be scheduled.
              </div>
            )}
          </div>
        )}
      </div>
      </div>

      {/* ─── Capacity check ─── */}
      {/* Shown as soon as teams and judges exist, so shortfalls surface before
          the solver spends 120 seconds discovering them. */}
      {s4 && s5 && (
        <div style={{ marginLeft: 42, marginBottom: 16 }}>
          <ReadinessPlanner
            teams={teams}
            judges={judges}
            roomCount={Math.max(rooms.length, 1)}
            slotsPerDay={Math.max(Math.round(slotsPerRoom / Math.max(evDayCount, 1)), 1)}
            eventDays={evDayCount}
            minJudgesPerTeam={minJudges}
            maxConsecutive={4}
            anchorTier="L2"
            excludedTiers={['L1']}
          />
        </div>
      )}

      {/* ─── STEP 6: Rooms ─── */}
      <div style={stepStyle(6, s6, s1 && s2 && s3 && s4 && s5, editingStep === 6).wrapper}>
        <div style={stepStyle(6, s6, s1 && s2 && s3 && s4 && s5, editingStep === 6).header}
            onClick={() => { if (s1 && s2 && s3 && s4 && s5) toggleStep(6, s6); }}>
          <div style={stepStyle(6, s6, s1 && s2 && s3 && s4 && s5, editingStep === 6).circle}>{(s6 && editingStep !== 6) ? '\u2713' : 6}</div>
          <span style={stepStyle(6, s6, s1 && s2 && s3 && s4 && s5, editingStep === 6).title}>{`Rooms (${rooms.length})`}</span>
          {s7 && s1 && s2 && s3 && s4 && s5 && s6 && editingStep !== 7 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(7)}>Edit</button>}
          {editingStep === 7 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(null)}>Done editing</button>}
          {s6 && editingStep !== 6 && <span style={{ fontSize: 11, color: '#10b981', padding: '2px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.08)' }}>Done</span>}
          <span style={{ fontSize: 12, color: '#8ea3bc', marginLeft: 2 }}>{isStepOpen(6, s6) ? '\u25B4' : '\u25BE'}</span>
        </div>
        <div style={stepStyle(6, s6, s1 && s2 && s3 && s4 && s5, editingStep === 6).body}>
        {rooms.map(r => (
          <div className="item" key={r.id}>
            <span className="item-name">{r.name}</span>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <span className="item-sub">
                Cap: {r.capacity || 25}
                {r.hasVideoConferencing && <span style={{marginLeft:8,color:'#38bdf8'}}>VC</span>}
              </span>
              <button type="button" className="btn btn-danger btn-sm" onClick={async () => { if (!confirm(`Remove "${r.name}"?`)) return; await run(DELETE_ROOM, { id: r.id }); show(`"${r.name}" removed`); reload(); }}>Remove</button>
            </div>
          </div>
        ))}
        <div className="add-row" key="room-add-form">
          <input className="inp" placeholder="Room name" value={newRoom.name} onChange={e => setNewRoom({...newRoom, name: e.target.value})} style={{flex:1}} onKeyDown={e => { if (e.key === 'Enter') { /* add */ } }} />
          <input type="number" className="inp" style={{width:70}} placeholder="Cap" value={newRoom.capacity} onChange={e => setNewRoom({...newRoom, capacity: Number(e.target.value)})} />
          <label style={{display:'flex',alignItems:'center',gap:5,fontSize:12,color:'#94a3b8',cursor:'pointer',whiteSpace:'nowrap'}}>
            <input type="checkbox" checked={!!newRoom.hasVideoConferencing}
              onChange={e => setNewRoom({...newRoom, hasVideoConferencing: e.target.checked})} />
            Video conferencing
          </label>
          <button type="button" className="btn btn-pri btn-sm" onClick={async () => {
            if (!newRoom.name.trim()) return;
            await run(CREATE_ROOM, { input: { eventId, name: newRoom.name.trim(), capacity: newRoom.capacity, hasVideoConferencing: !!newRoom.hasVideoConferencing } });
            show(`"${newRoom.name}" added`); setNewRoom({ name: '', capacity: 25, hasVideoConferencing: false }); reload();
          }}>Add</button>
        </div>
        {!s6 && <div style={{fontSize:13,color:'#f59e0b',marginTop:8}}>Add at least one room</div>}
      </div>
      </div>

      {/* ─── STEP 7: Time Slots ─── */}
      <div style={stepStyle(7, s7, s1 && s2 && s3 && s4 && s5 && s6, editingStep === 7).wrapper}>
        <div style={stepStyle(7, s7, s1 && s2 && s3 && s4 && s5 && s6, editingStep === 7).header}
            onClick={() => { if (s1 && s2 && s3 && s4 && s5 && s6) toggleStep(7, s7); }}>
          <div style={stepStyle(7, s7, s1 && s2 && s3 && s4 && s5 && s6, editingStep === 7).circle}>{(s7 && editingStep !== 7) ? '\u2713' : 7}</div>
          <span style={stepStyle(7, s7, s1 && s2 && s3 && s4 && s5 && s6, editingStep === 7).title}>{`Time slots (${judgingSlots})`}</span>
          {s7 && s1 && s2 && s3 && s4 && s5 && s6 && editingStep !== 7 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(7)}>Edit</button>}
          {editingStep === 7 && <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditingStep(null)}>Done editing</button>}
          {s7 && editingStep !== 7 && <span style={{ fontSize: 11, color: '#10b981', padding: '2px 8px', borderRadius: 4, background: 'rgba(16,185,129,0.08)' }}>Done</span>}
          <span style={{ fontSize: 12, color: '#8ea3bc', marginLeft: 2 }}>{isStepOpen(7, s7) ? '\u25B4' : '\u25BE'}</span>
        </div>
        <div style={stepStyle(7, s7, s1 && s2 && s3 && s4 && s5 && s6, editingStep === 7).body}>
        {eventDays.length > 0 ? (
          <>
            {/* Existing slots */}
            {eventDays.map(day => {
              const daySlots = timeSlots.filter((s: any) => slDS(s.date) === day && s.slotType === 'JUDGING');
              return daySlots.length > 0 ? (
                <div className="item" key={day}>
                  <span className="item-name">{fmt(day)}</span>
                  <div style={{display:'flex',gap:8,alignItems:'center'}}>
                    <span className="item-sub">{daySlots.length} slots</span>
                    <button type="button" className="btn btn-danger btn-sm" onClick={async () => { if (!confirm(`Clear slots for ${fmt(day)}?`)) return; await run(CLEAR_SLOTS, { eventId, date: day }); show('Slots cleared'); reload(); }}>Clear</button>
                  </div>
                </div>
              ) : null;
            })}
            {/* Config */}
            <div style={{padding:12,borderRadius:8,background:'rgba(255,255,255,0.02)',border:'0.5px solid rgba(255,255,255,0.06)',marginTop:8}}>
              <div className="fg">
                <div style={{display:'flex',gap:6,alignItems:'center'}}><span className="lbl" style={{fontSize:12,minWidth:50}}>Hours</span><input type="time" className="inp" style={{width:90}} value={slotCfg.startTime} onChange={e => setSlotCfg({...slotCfg, startTime: e.target.value})} /><span style={{color:'#6b7a90'}}>to</span><input type="time" className="inp" style={{width:90}} value={slotCfg.endTime} onChange={e => setSlotCfg({...slotCfg, endTime: e.target.value})} /></div>
                <div style={{display:'flex',gap:6,alignItems:'center'}}><span className="lbl" style={{fontSize:12,minWidth:50}}>Lunch</span><input type="time" className="inp" style={{width:90}} value={slotCfg.lunchStart} onChange={e => setSlotCfg({...slotCfg, lunchStart: e.target.value})} /><span style={{color:'#6b7a90'}}>to</span><input type="time" className="inp" style={{width:90}} value={slotCfg.lunchEnd} onChange={e => setSlotCfg({...slotCfg, lunchEnd: e.target.value})} /></div>
              </div>
              {rooms.length > 0 && (
                <div style={{marginTop:12,paddingTop:10,borderTop:'0.5px solid rgba(255,255,255,0.06)'}}>
                  {/* Collapsed by default: nothing is excluded in the ordinary
                      case, and a grid of empty boxes should not take a third of
                      the section to say so. */}
                  <div style={{display:'flex',alignItems:'center',gap:10}}>
                    <button type="button"
                      onClick={() => setRoomGridOpen(!roomGridOpen)}
                      className="btn btn-sec btn-sm"
                      style={{display:'flex',alignItems:'center',gap:6}}
                    >
                      <span>Room availability</span>
                      <span style={{fontSize:11}}>{roomGridOpen ? '\u25B4' : '\u25BE'}</span>
                    </button>
                    <span style={{fontSize:13,color: totalExcluded > 0 ? '#f59e0b' : '#8ea3bc'}}>
                      {totalExcluded > 0
                        ? `${totalExcluded} half-day(s) excluded`
                        : 'All rooms available on every day'}
                    </span>
                  </div>

                  {roomGridOpen && (
                    <div style={{marginTop:10,overflowX:'auto'}}>
                      <div style={{fontSize:13,color:'#8ea3bc',marginBottom:8}}>
                        Mark a room only when it is <em>not</em> available.
                      </div>
                      <table style={{borderCollapse:'collapse',fontSize:13}}>
                        <thead>
                          <tr>
                            <th style={{textAlign:'left',padding:'4px 14px 8px 0',fontWeight:400,color:'#8ea3bc'}} />
                            {rooms.map((r: any) => (
                              <th key={r.id} colSpan={2}
                                style={{textAlign:'center',padding:'4px 12px 8px',fontWeight:500,color:'#b4c2d4',
                                        borderBottom:'0.5px solid rgba(255,255,255,0.08)'}}>
                                {r.name}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {eventDays.map(day => {
                            return (
                              <tr key={day}>
                                <td style={{padding:'5px 14px 5px 0',color:'#b4c2d4',whiteSpace:'nowrap'}}>
                                  {fmt(day)}
                                </td>
                                {rooms.map((r: any) => (
                                  (['AM','PM'] as const).map(sess => {
                                    const out = !!roomOut[`${day}|${r.id}|${sess}`];
                                    return (
                                      <td key={r.id + sess} style={{padding:'5px 6px',textAlign:'center'}}>
                                        <span
                                          role="button"
                                          title={out ? `${r.name} unavailable ${sess}` : `Mark ${r.name} unavailable ${sess}`}
                                          onClick={() => toggleRoomOut(day, r.id, sess)}
                                          style={{
                                            display:'inline-flex',alignItems:'center',justifyContent:'center',
                                            gap:4, cursor:'pointer', padding:'2px 8px', borderRadius:5,
                                            minWidth:52,
                                            border:`0.5px solid ${out ? 'rgba(239,68,68,0.45)' : 'rgba(255,255,255,0.12)'}`,
                                            background: out ? 'rgba(239,68,68,0.1)' : 'transparent',
                                            color: out ? '#f87171' : '#8ea3bc',
                                          }}
                                        >
                                          <span style={{fontSize:12,width:8,display:'inline-block'}}>
                                            {out ? '\u00D7' : ''}
                                          </span>
                                          {sess}
                                        </span>
                                      </td>
                                    );
                                  })
                                ))}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              <div style={{display:'flex',gap:8,marginTop:10,flexWrap:'wrap'}}>
                {eventDays.map(day => {
                  const existing = timeSlots.filter((s: any) => slDS(s.date) === day && s.slotType === 'JUDGING').length;
                  const excluded = outFor(day);
                  const daySlots = timeSlots.filter((s: any) => slDS(s.date) === day && s.slotType === 'JUDGING').length;
                  const dayLost = excluded.reduce(
                    (n: number, e: any) => n + slotsPerHalfDay(day, e.session as 'AM' | 'PM'), 0);
                  const dayUsable = daySlots * Math.max(rooms.length, 1) - dayLost;
                  return (
                    <button type="button" key={day} className={`btn btn-sm ${existing > 0 ? 'btn-success' : 'btn-pri'}`} style={{flex:1}} onClick={async () => {
                      if (existing > 0 && !confirm(`${fmt(day)} already has ${existing} slots. Regenerate?`)) return;
                      const d = await run(GEN_SLOTS, { input: { eventId, date: day, operatingStart: slotCfg.startTime, operatingEnd: slotCfg.endTime, sessionDurationMinutes: slotCfg.session, breakDurationMinutes: slotCfg.brk, lunchStart: slotCfg.lunchStart, lunchEnd: slotCfg.lunchEnd } });
                      if (d) {
                        show(excluded.length > 0
                          ? `${d.generateTimeSlots.length} slots for ${fmt(day)} — ${excluded.length} room half-day(s) excluded`
                          : `${d.generateTimeSlots.length} slots for ${fmt(day)}`);
                        reload();
                      }
                    }}>{fmt(day)} {existing > 0 ? `(${existing})` : 'Generate'}{excluded.length > 0 ? ' ⚠' : ''}</button>
                  );
                })}
              </div>
            </div>
          </>
        ) : (
          <div style={{fontSize:13,color:'#f59e0b'}}>Set event dates in Step 1 first</div>
        )}
      </div>
      </div>

      {/* ─── Ready banner ─── */}
      {allReady && (
        <div className="ready-banner">
          <div style={{fontSize:18,fontWeight:500,color:'#10b981',marginBottom:6}}>Ready to schedule</div>
          <div style={{fontSize:14,color:'#94a3b8',marginBottom:12}}>{teams.length} teams, {judges.length} judges, {rooms.length} rooms, {judgingSlots} slots, {criteria.length} criteria</div>
          <button type="button" className="btn btn-pri" onClick={() => window.location.href = '/dashboard/schedule'}>Go to Schedule</button>
        </div>
      )}
    
      
      {allReady && capacityWarnings.length > 0 && (
        <div style={{marginTop:16,borderRadius:10,border:'1px solid rgba(245,158,11,0.3)',background:'rgba(245,158,11,0.05)',padding:'16px 20px'}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
            <span style={{fontSize:20}}>⚠️</span>
            <div>
              <div style={{fontSize:14,fontWeight:600,color:'#f59e0b'}}>Schedule may not be feasible</div>
              <div style={{fontSize:12,color:'#94a3b8'}}>Fix these issues before generating</div>
            </div>
          </div>
          {capacityWarnings.map((w: string, i: number) => (
            <div key={i} style={{fontSize:13,color:'#fbbf24',padding:'8px 12px',background:'rgba(245,158,11,0.05)',borderRadius:6,marginBottom:i < capacityWarnings.length - 1 ? 8 : 0,borderLeft:'3px solid rgba(245,158,11,0.4)'}}>
              {w}
            </div>
          ))}
        </div>
      )}

      {allReady && capacityWarnings.length === 0 && (
        <div style={{marginTop:16,borderRadius:10,border:'1px solid rgba(52,211,153,0.3)',background:'rgba(52,211,153,0.05)',padding:'16px 20px',display:'flex',alignItems:'center',gap:12}}>
          <span style={{fontSize:20}}>✅</span>
          <div>
            <div style={{fontSize:14,fontWeight:600,color:'#34d399'}}>Ready to schedule</div>
            <div style={{fontSize:12,color:'#94a3b8'}}>
              {teams.length} teams · {judges.length} judges (capacity: {totalJudgeCapacity}) · {rooms.length} rooms · All constraints satisfied
            </div>
          </div>
        </div>
      )}

{importErrors.length > 0 && (
        <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:9999}}>
          <div style={{background:"#0f172a",border:"1px solid #334155",borderRadius:12,padding:"24px",maxWidth:560,width:"90%",maxHeight:"70vh",display:"flex",flexDirection:"column" as const}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
              <div style={{width:36,height:36,borderRadius:8,background:"rgba(239,68,68,0.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>⚠️</div>
              <div>
                <div style={{fontSize:15,fontWeight:600,color:"#f1f5f9"}}>Import completed with issues</div>
                <div style={{fontSize:13,color:"#94a3b8"}}>{importErrors.length} row{importErrors.length > 1 ? "s" : ""} could not be imported</div>
              </div>
            </div>
            <div style={{flex:1,overflowY:"auto",marginBottom:16,borderRadius:8,border:"1px solid #1e293b",background:"#0a0e1a"}}>
              {importErrors.map((e: any, i: number) => (
                <div key={i} style={{fontSize:13,padding:"10px 14px",borderBottom:i < importErrors.length - 1 ? "1px solid #1e293b" : "none",display:"flex",gap:8}}>
                  <span style={{color:"#64748b",flexShrink:0}}>Row {e.row}</span>
                  <span style={{color:"#f87171"}}>{e.message}</span>
                </div>
              ))}
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
              <button type="button" onClick={() => { setImportErrors([]); window.location.reload(); }} style={{padding:"8px 24px",borderRadius:8,fontSize:14,fontWeight:500,background:"#3b82f6",color:"#fff",border:"none",cursor:"pointer"}}>
                OK, got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
