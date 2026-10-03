'use client';
import { useState, useEffect } from 'react';
import { useQuery } from '@/lib/use-graphql';
import { useAuthStore } from '@/lib/auth-store';
import { createClient } from '@/lib/graphql-client';
import { EVENTS_QUERY, SESSIONS_QUERY, JUDGES_QUERY, ROOMS_QUERY, TIMESLOTS_QUERY } from '@/lib/queries';
import StatusBadge from '@/components/status-badge';
import CountryFlag from '@/components/country-flag';
import PlatformChip, { platformColor } from '@/components/platform-chip';
import { useEventId } from '@/lib/event-store';

const UPDATE_STAGE = `mutation U($input: UpdateStageInput!) { updateSessionStage(input: $input) { success message } }`;
const SWAP_SESSIONS_MUT = `mutation SS($input: SwapSessionsInput!) { swapSessions(input: $input) { success message } }`;
const SWAP_TEAMS_MUT = `mutation ST($sessionIdA: String!, $sessionIdB: String!) { swapTeams(sessionIdA: $sessionIdA, sessionIdB: $sessionIdB) { success message } }`;
const RESCHEDULE_MUT = `mutation RS($input: RescheduleInput!) { rescheduleSession(input: $input) { success message } }`;
const HEALTH_CHECK = `query HC($eventId: String!) { sessionHealthCheck(eventId: $eventId) { sessionId teamName roomName stage judgesAssigned judgesRequired isHealthy issues } }`;
const FIND_REPLACEMENTS = `query FR($sessionId: String!) { findReplacementJudges(sessionId: $sessionId) { judgeId judgeName judgeType currentLoad maxSessions isAvailable hasConflict isBusyInSlot score } }`;
const ADD_JUDGE_MUT = `mutation AJ($input: AddJudgeInput!) { addJudgeToSession(input: $input) { success message } }`;

export default function CommandCentrePage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const selectedEventId = useEventId();
  const event =
    evData?.events?.find((e: any) => e.id === selectedEventId) ?? evData?.events?.[0];
  const eventId = event?.id;
  const { data: sessionData } = useQuery<any>(SESSIONS_QUERY, eventId ? { eventId } : undefined);
  const { data: judgeData } = useQuery<any>(JUDGES_QUERY, eventId ? { eventId } : undefined);
  const { data: roomData } = useQuery<any>(ROOMS_QUERY, eventId ? { eventId } : undefined);
  const { data: slotData } = useQuery<any>(TIMESLOTS_QUERY, eventId ? { eventId } : undefined);
  const token = useAuthStore((s) => s.token);

  const sessions = sessionData?.sessions || [];
  const judges = judgeData?.judges || [];

  // Messaging. Kept deliberately small: pick judges, type, send. No threads,
  // no history beyond what is still unread.
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgBody, setMsgBody] = useState('');
  const [msgTo, setMsgTo] = useState<string[]>([]);
  const [msgSending, setMsgSending] = useState(false);
  const [unread, setUnread] = useState<any[]>([]);

  const loadUnread = async () => {
    if (!eventId) return;
    try {
      const d = await run(`query M($eventId: String!) {
        judgeMessages(eventId: $eventId) { id judgeId judgeName body sentByName sentAt }
      }`, { eventId });
      setUnread(d?.judgeMessages || []);
    } catch { /* the panel is not worth an error banner */ }
  };

  useEffect(() => { loadUnread(); }, [eventId]);

  /**
   * Open compose with a whole panel selected.
   *
   * The judges are already on the session record, so this is a selection
   * shortcut rather than a second mechanism — the message that goes out is
   * identical to one addressed to three people by hand.
   */
  /**
   * Mark an MD out of a session, or back into it.
   *
   * An MD who has stepped out to take a call will not necessarily open their
   * portal to say so. Somebody in the room marking it is the realistic case,
   * and it writes the same field the judge's own control does.
   */
  const setJudgeBreak = async (sessionId: string, judgeId: string, judgeName: string, on: boolean) => {
    if (on && !confirm(`Mark ${judgeName} as stepped out of this session?`)) return;
    const d = await run(`mutation B($input: SetJudgeBreakInput!) {
      setJudgeBreak(input: $input) { success message }
    }`, { input: { sessionId, judgeId, onBreak: on } });
    if (d?.setJudgeBreak) {
      showMsg(d.setJudgeBreak.message);
      setTimeout(() => window.location.reload(), 800);
    }
  };

  const messageSession = (s: any) => {
    setMsgTo((s.judges || []).map((j: any) => j.judgeId));
    setMsgBody('');
    setMsgOpen(true);
  };

  const sendMessage = async () => {
    if (!msgBody.trim() || msgTo.length === 0) return;
    setMsgSending(true);
    try {
      await run(`mutation S($eventId: String!, $judgeIds: [String!]!, $body: String!) {
        messageJudges(eventId: $eventId, judgeIds: $judgeIds, body: $body) { sent }
      }`, { eventId, judgeIds: msgTo, body: msgBody });
      setMsgBody(''); setMsgTo([]); setMsgOpen(false);
      loadUnread();
    } catch (e: any) {
      alert(e.message || 'Could not send');
    }
    setMsgSending(false);
  };
  const rooms = roomData?.rooms || [];
  const timeSlots = slotData?.timeSlots || [];

  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [msgType, setMsgType] = useState<'ok' | 'err'>('ok');
  const [healthIssues, setHealthIssues] = useState<any[]>([]);
  const [validTargets, setValidTargets] = useState<Set<string>>(new Set());
  const [swapDialog, setSwapDialog] = useState<any>(null);
  const [replacements, setReplacements] = useState<any[]>([]);
  const [replFor, setReplFor] = useState<string | null>(null);
  const [activeDate, setActiveDate] = useState<string | null>(null);

  const showMsg = (msg: string, type: 'ok' | 'err' = 'ok') => {
    setMessage(msg); setMsgType(type);
    setTimeout(() => setMessage(''), 5000);
  };

  const run = async (mutation: string, variables: any) => {
    const client = createClient(token);
    const res = await client.mutation(mutation, variables).toPromise();
    if (res.error) { const msg = res.error.message.replace(/\[GraphQL\] /g, '').replace(/Invalid.*?Message: /g, ''); showMsg(msg, 'err'); return null; }
    return res.data;
  };

  /**
   * Only offered when the session is above the event minimum — below it,
   * taking a judge off would leave the team under-judged.
   */
  const removeJudgeFrom = async (sessionId: string, judgeId: string, judgeName: string) => {
    if (!confirm(`Remove ${judgeName} from this session?`)) return;
    const data = await run(`mutation R($input: RemoveJudgeInput!) {
      removeJudge(input: $input) { success message warnings }
    }`, { input: { sessionId, judgeId } });
    if (data?.removeJudge) {
      const r = data.removeJudge;
      showMsg(r.warnings?.length ? `${r.message} — ${r.warnings.join('; ')}` : r.message);
      setTimeout(() => window.location.reload(), 800);
    }
  };

  const updateStage = async (sessionId: string, stage: string) => {
    const data = await run(UPDATE_STAGE, { input: { sessionId, stage } });
    if (data) { showMsg(data.updateSessionStage.message); setTimeout(() => window.location.reload(), 800); }
  };

  const runHealthCheck = async () => {
    if (!eventId) return;
    const client = createClient(token);
    const res = await client.query(HEALTH_CHECK, { eventId }).toPromise();
    const issues = (res.data?.sessionHealthCheck || []).filter((h: any) => !h.isHealthy);
    setHealthIssues(issues);
    if (issues.length === 0) showMsg('All sessions healthy');
  };

  const findReplacements = async (sessionId: string) => {
    const client = createClient(token);
    const res = await client.query(FIND_REPLACEMENTS, { sessionId }).toPromise();
    setReplacements(res.data?.findReplacementJudges || []);
    setReplFor(sessionId);
  };

  const addJudge = async (sessionId: string, judgeId: string) => {
    const data = await run(ADD_JUDGE_MUT, { input: { sessionId, judgeId, reason: 'Added from command centre' } });
    if (data) { showMsg(data.addJudgeToSession.message); setTimeout(() => window.location.reload(), 800); }
  };

  // Helpers
  const getHour = (s: any) => s.scheduledStart ? new Date(s.scheduledStart).getHours() : 12;
  const getDate = (s: any) => s.scheduledStart ? new Date(s.scheduledStart).toLocaleDateString('en-SG', { weekday: 'short', day: 'numeric', month: 'short' }) : 'Unknown';
  const getTime = (s: any) => s.scheduledStart ? new Date(s.scheduledStart).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--';

  const dates = [...new Set(sessions.map((s: any) => getDate(s)))].sort((a, b) => String(a).localeCompare(String(b)));
  const roomNames = rooms.map((r: any) => r.name).sort((a, b) => String(a).localeCompare(String(b)));

  useEffect(() => { if (dates.length > 0 && !activeDate) setActiveDate(dates[0]); }, [dates]);

  const getSessionsFor = (date: string, period: 'AM' | 'PM', room: string) =>
    sessions
      .filter((s: any) => getDate(s) === date && (period === 'AM' ? getHour(s) < 12 : getHour(s) >= 12) && s.roomName === room)
      .sort((a: any, b: any) => (a.scheduledStart || '').localeCompare(b.scheduledStart || ''));

  // Stats
  const completed = sessions.filter((s: any) => s.stage === 'COMPLETED').length;
  const inProgress = sessions.filter((s: any) => s.stage === 'IN_PROGRESS').length;
  const upcoming = sessions.filter((s: any) => s.stage === 'SCHEDULED').length;
  const delayed = sessions.filter((s: any) => s.stage === 'DELAYED').length;

  // ─── Click-to-swap ───
  const [swapSource, setSwapSource] = useState<string | null>(null);
  const [moveDialog, setMoveDialog] = useState<any>(null);

  const getValidSwapTargets = (sourceId: string): Set<string> => {
    const valid = new Set<string>();
    for (const target of sessions) {
      if (target.id === sourceId) continue;
      // Cannot swap completed, cancelled, or in-progress sessions
      if (['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(target.stage)) continue;
      valid.add(target.id);
    }
    return valid;
  };

  const handleCardClick = (sessionId: string) => {
    const s = sessions.find((ss: any) => ss.id === sessionId);
    if (!s || ['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(s.stage)) return;

    if (!swapSource) {
      setSwapSource(sessionId);
      setValidTargets(getValidSwapTargets(sessionId));
    } else if (swapSource === sessionId) {
      setSwapSource(null);
      setValidTargets(new Set());
    } else if (validTargets.has(sessionId)) {
      const source = sessions.find((ss: any) => ss.id === swapSource);
      const target = sessions.find((ss: any) => ss.id === sessionId);
      if (source && target) {
        setSwapDialog({ sourceId: swapSource, targetId: sessionId, source, target,
          sourceName: source.teamName, targetName: target.teamName });
      }
      setSwapSource(null);
      setValidTargets(new Set());
    }
  };

  const cancelSwapSelection = () => {
    setSwapSource(null);
    setValidTargets(new Set());
  };

  const getEmptySlots = (sessionId: string) => {
    const s = sessions.find((ss: any) => ss.id === sessionId);
    if (!s) return [];
    const sessionDate = s.scheduledStart ? new Date(s.scheduledStart).toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" }) : null;
    const judgingSlots = timeSlots.filter((ts: any) => ts.slotType === "JUDGING");
    const occupiedSlotRooms = new Set(sessions.filter((ss: any) => !["CANCELLED", "RESCHEDULED"].includes(ss.stage)).map((ss: any) => ss.timeSlotId + ":" + ss.roomId));
    const available: any[] = [];
    for (const ts of judgingSlots) {
      for (const room of rooms) {
        const key = ts.id + ":" + room.id;
        if (!occupiedSlotRooms.has(key)) {
          const slotTime = new Date(ts.startTime).toLocaleTimeString("en-SG", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hour12: false });
          const slotDate = new Date(ts.startTime).toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", weekday: "short", day: "numeric", month: "short" });
          available.push({ slotId: ts.id, roomId: room.id, roomName: room.name, time: slotTime, date: slotDate });
        }
      }
    }
    return available.sort((a, b) => a.time.localeCompare(b.time));
  };

  const executeMove = async (sessionId: string, newSlotId: string, newRoomId: string) => {
    setMoveDialog(null);
    const data = await run(RESCHEDULE_MUT, { input: { sessionId, newTimeSlotId: newSlotId, newRoomId, reason: "Moved to empty slot" } });
    if (data) { showMsg(data.rescheduleSession.message); setTimeout(() => window.location.reload(), 800); }
  };

  // ─── Drag-and-drop (also triggers swap dialog) ───
  const [dragSession, setDragSession] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [dragTargets, setDragTargets] = useState<Set<string>>(new Set());

  const handleDragStart = (e: React.DragEvent, sessionId: string) => {
    const s = sessions.find((ss: any) => ss.id === sessionId);
    if (!s || s.stage === 'COMPLETED' || s.stage === 'CANCELLED') { e.preventDefault(); return; }
    setDragSession(sessionId);
    setDragTargets(getValidSwapTargets(sessionId));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sessionId);
    // Better drag image
    const el = e.currentTarget as HTMLElement;
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.style.width = el.offsetWidth + 'px';
    ghost.style.opacity = '0.85';
    ghost.style.position = 'absolute';
    ghost.style.top = '-1000px';
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, el.offsetWidth / 2, 20);
    setTimeout(() => document.body.removeChild(ghost), 0);
  };

  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    if (!dragTargets.has(targetId)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(targetId);
  };

  const handleDragLeave = () => setDragOver(null);

  const handleDragEnd = () => {
    setDragSession(null);
    setDragOver(null);
    setDragTargets(new Set());
  };

  const handleDrop = (e: React.DragEvent, targetSessionId: string) => {
    e.preventDefault();
    const sourceId = e.dataTransfer.getData('text/plain');
    setDragOver(null);
    if (!sourceId || sourceId === targetSessionId) { handleDragEnd(); return; }

    const source = sessions.find((s: any) => s.id === sourceId);
    const target = sessions.find((s: any) => s.id === targetSessionId);
    if (!source || !target) { handleDragEnd(); return; }

    setSwapDialog({ sourceId, targetId: targetSessionId, source, target,
      sourceName: source.teamName, targetName: target.teamName });
    handleDragEnd();
  };

  const executeSwap = async (type: 'teams' | 'full') => {
    if (!swapDialog) return;
    const { sourceId, targetId, sourceName, targetName } = swapDialog;
    setSwapDialog(null);

    if (type === 'teams') {
      showMsg(`Swapping teams ${sourceName} and ${targetName}...`);
      const data = await run(SWAP_TEAMS_MUT, { sessionIdA: sourceId, sessionIdB: targetId });
      if (data) { showMsg(data.swapTeams.message); setTimeout(() => window.location.reload(), 800); }
    } else {
      showMsg(`Swapping full sessions ${sourceName} and ${targetName}...`);
      const data = await run(SWAP_SESSIONS_MUT, { input: { sessionIdA: sourceId, sessionIdB: targetId } });
      if (data) { showMsg(data.swapSessions.message); setTimeout(() => window.location.reload(), 800); }
    }
  };

  // Session card component
  // ─── Live clock for timers ───
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const SESSION_DURATION_MIN = event?.sessionDurationMinutes || 20;

  const getTimerInfo = (s: any) => {
    if (s.stage !== 'IN_PROGRESS') return null;
    const start = s.actualStart ? new Date(s.actualStart) : null;
    if (!start) return { elapsed: 0, remaining: SESSION_DURATION_MIN * 60, pct: 0, overrun: false };
    const elapsedSec = Math.floor((now.getTime() - start.getTime()) / 1000);
    const totalSec = SESSION_DURATION_MIN * 60;
    const remainingSec = Math.max(0, totalSec - elapsedSec);
    return { elapsed: elapsedSec, remaining: remainingSec, pct: Math.min(100, (elapsedSec / totalSec) * 100), overrun: elapsedSec > totalSec };
  };

  const formatTimer = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Check if session is "due now" (within 5 min of scheduled start)
  const isDueNow = (s: any) => {
    if (!s.scheduledStart || s.stage === 'COMPLETED' || s.stage === 'CANCELLED') return false;
    const scheduled = new Date(s.scheduledStart);
    const diffMin = (scheduled.getTime() - now.getTime()) / 60000;
    return diffMin >= -5 && diffMin <= 5 && s.stage === 'SCHEDULED';
  };

  const SessionCard = ({ s }: { s: any }) => {
    const isExpanded = expandedCard === s.id;
    const isSwapSource = swapSource === s.id;
    const isDragging = dragSession === s.id;
    const isDragOver = dragOver === s.id;
    const isValidClick = swapSource && swapSource !== s.id && validTargets.has(s.id);
    const isInvalidClick = swapSource && swapSource !== s.id && !validTargets.has(s.id);
    const isValidDrag = dragSession && dragSession !== s.id && dragTargets.has(s.id);
    const isInvalidDrag = dragSession && dragSession !== s.id && !dragTargets.has(s.id);
    const isActive = s.stage === 'IN_PROGRESS';
    const canSwap = s.stage === 'SCHEDULED' || s.stage === 'DELAYED';
    const timer = getTimerInfo(s);
    const dueNow = isDueNow(s);

    return (
      <div
        className={[
          'sess',
          isSwapSource ? 'swap-source' : '',
          isDragging ? 'dragging' : '',
          isDragOver ? 'drag-over' : '',
          isActive ? 'active-sess' : '',
          dueNow ? 'due-now' : '',
          timer?.overrun ? 'overrun' : '',
          (isValidClick || isValidDrag) ? 'swap-valid' : '',
          (isInvalidClick || isInvalidDrag) ? 'swap-invalid' : '',
        ].filter(Boolean).join(' ')}
        style={platformColor(s.teamPlatform) ? {
          borderLeft: `4px solid ${platformColor(s.teamPlatform)!.fg}`,
        } : undefined}
        draggable={canSwap}
        onDragStart={(e) => handleDragStart(e, s.id)}
        onDragOver={(e) => handleDragOver(e, s.id)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, s.id)}
        onDragEnd={handleDragEnd}
        onClick={() => { if (swapSource) handleCardClick(s.id); }}
      >
        {/* Timer bar for active sessions */}
        {timer && (
          <div className="timer-bar">
            <div className={`timer-fill ${timer.overrun ? 'timer-overrun' : ''}`} style={{ width: `${timer.pct}%` }} />
          </div>
        )}

        {/* Swap target overlay */}
        {(isValidClick || isValidDrag) && swapSource && (
          <div className="swap-click-zone" onClick={(e) => { e.stopPropagation(); handleCardClick(s.id); }}>
            <span className="swap-click-label">Tap to swap here</span>
          </div>
        )}

        {/* Header */}
        <div className="sess-top">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer' }}
            onClick={(e) => { e.stopPropagation(); setExpandedCard(isExpanded ? null : s.id); }}>
            {dueNow && <div className="due-dot" />}
            <span className="sess-team">{s.teamName}</span>
            <CountryFlag code={s.teamCountry} size={14} showVC />
            <PlatformChip platform={s.teamPlatform} size="xs" />
            {(s.judges?.length ?? 0) > 0 && (
              <span
                role="button"
                title={`Message the ${s.judges.length} judge(s) on this session`}
                onClick={(e) => { e.stopPropagation(); messageSession(s); }}
                style={{
                  fontSize: 13, color: '#a9bdd3', cursor: 'pointer',
                  padding: '2px 8px', borderRadius: 5, fontWeight: 500,
                  background: 'rgba(140,175,215,0.1)',
                  border: '0.5px solid rgba(140,175,215,0.3)',
                }}
              >note</span>
            )}
            <span style={{ fontSize: 12, color: '#8ea3bc' }}>{isExpanded ? '\u25B2' : '\u25BC'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Live timer badge */}
            {timer && (
              <div className={`timer-badge ${timer.overrun ? 'timer-badge-overrun' : timer.remaining < 120 ? 'timer-badge-warn' : ''}`}>
                {timer.overrun ? (
                  <span>+{formatTimer(timer.elapsed - SESSION_DURATION_MIN * 60)}</span>
                ) : (
                  <span>{formatTimer(timer.remaining)}</span>
                )}
              </div>
            )}
            <StatusBadge status={s.stage} />
            {canSwap && (
              <button type="button" className={`swap-btn ${isSwapSource ? 'swap-btn-active' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleCardClick(s.id); }}>
                {isSwapSource ? 'Cancel' : 'Swap'}
              </button>
            )}
          </div>
        </div>
        <div className="sess-meta">
          <span className="sess-time">{getTime(s)}</span>
          {/*
            Judges expected, not judges assigned. A session where one stepped
            out reads "3 judges - 2/2 scored" otherwise, which invites a
            coordinator to chase a judge who is not coming.
          */}
          <span>
            {(s.judges?.length || 0) - (s.judgesOnBreak || 0)} judges
            {(s.judgesOnBreak || 0) > 0 && (
              <span style={{ color: '#8ea3bc' }}>
                {' '}({s.judgesOnBreak} stepped out)
              </span>
            )}
            {' '}- {s.scorecardsSubmitted || 0}/{s.scorecardsTotal || 0} scored
          </span>
        </div>

        {/* Expanded: full details */}
        {isExpanded && (
          <div className="sess-expanded">
            {/* Project / Use case */}
            {s.projectName && (
              <div className="exp-section">
                <div className="exp-label">Use case</div>
                <div className="exp-value">{s.projectName}</div>
              </div>
            )}

            {/* Track / Department / Org */}
            <div className="exp-tags">
              {s.trackName && <span className="exp-tag tag-track">{s.trackName}</span>}
              {s.department && <span className="exp-tag tag-dept">{s.department}</span>}
              {s.organisation && <span className="exp-tag tag-org">{s.organisation}</span>}
            </div>

            {/* Tech stack / Tools */}
            {(s.techStack || s.vendorTools) && (
              <div className="exp-section">
                <div className="exp-label">Platform / Tools</div>
                <div className="exp-tools">
                  {(s.techStack || s.vendorTools || '').split(',').filter(Boolean).map((t: string, i: number) => (
                    <span key={i} className="exp-tool">{t.trim()}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Judges */}
            <div className="exp-section">
              <div className="exp-label">Judges ({s.judges?.length || 0})</div>
              {(s.judges || []).map((j: any) => (
                <div key={j.judgeId} className="exp-judge">
                  <span className="exp-judge-name">{j.judgeName}</span>
                  <span className="exp-judge-type">{j.judgeTier || j.judgeType || ''}</span>
                  {j.onBreak && (
                    <span style={{fontSize:12,color:'#f59e0b',fontWeight:500}}>stepped out</span>
                  )}
                  {/* Either IG seat, and only when the other is not already
                      out — the server refuses it either way, but a control that
                      cannot work should not invite the click. */}
                  {['L2', 'L3', 'L4'].includes(j.judgeTier) &&
                   !(s.judges || []).some((o: any) =>
                     o.judgeId !== j.judgeId && o.onBreak &&
                     ['L2', 'L3', 'L4'].includes(o.judgeTier)) && (
                    <span
                      role="button"
                      title={j.onBreak ? 'Mark as back' : 'Mark as stepped out'}
                      onClick={(e) => { e.stopPropagation(); setJudgeBreak(s.id, j.judgeId, j.judgeName, !j.onBreak); }}
                      style={{cursor:'pointer',fontSize:12,color: j.onBreak ? '#4ade80' : '#8ea3bc',
                              padding:'1px 6px',borderRadius:4,
                              border:'0.5px solid rgba(255,255,255,0.12)'}}
                    >{j.onBreak ? 'back' : 'break'}</span>
                  )}
                  {/* Only above the event minimum — below it, removing a judge
                      would leave the team under-judged. */}
                  {(s.judges?.length ?? 0) > (event?.minJudgesPerTeam ?? 3) && (
                    <span
                      role="button"
                      title={`Remove ${j.judgeName}`}
                      onClick={(e) => { e.stopPropagation(); removeJudgeFrom(s.id, j.judgeId, j.judgeName); }}
                      style={{ marginLeft: 'auto', cursor: 'pointer', color: '#f87171',
                               fontSize: 15, lineHeight: 1, padding: '0 4px' }}
                    >&times;</span>
                  )}
                </div>
              ))}
              <span className="exp-add-judge" onClick={(e) => { e.stopPropagation(); findReplacements(s.id); }}>+ Add judge</span>
            </div>

            {/* Replacement panel */}
            {replFor === s.id && replacements.length > 0 && (
              <div className="exp-repl">
                <div className="exp-label">Available judges</div>
                {replacements.filter(r => r.score > 0 && !r.hasConflict && !r.isBusyInSlot && r.isAvailable).slice(0, 6).map((r: any) => (
                  <div key={r.judgeId} className="exp-repl-row">
                    <span style={{ color: '#fff', fontSize: 14 }}>{r.judgeName} <span style={{ color: '#8ea3bc' }}>{r.judgeType}</span></span>
                    <button type="button" className="exp-repl-add" onClick={(e) => { e.stopPropagation(); addJudge(s.id, r.judgeId); }}>Add</button>
                  </div>
                ))}
              </div>
            )}

            {/* Score progress */}
            {(s.scorecardsTotal || 0) > 0 && (
              <div className="exp-section">
                <div className="exp-label">Scoring progress</div>
                <div className="exp-bar">
                  <div className="exp-bar-fill" style={{ width: `${((s.scorecardsSubmitted || 0) / s.scorecardsTotal) * 100}%` }} />
                </div>
                <div style={{ fontSize: 13, color: '#8ea3bc', marginTop: 3 }}>
                  {s.scorecardsSubmitted || 0} of {s.scorecardsTotal} scorecards submitted
                </div>
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        {s.stage === 'SCHEDULED' && (
          <div className="sess-btns">
            <button type="button" className="btn-act btn-go" onClick={(e) => { e.stopPropagation(); updateStage(s.id, 'IN_PROGRESS'); }}>Start session</button>
            <button type="button" className="btn-act" style={{background:"rgba(124,58,237,0.15)",border:"1px solid rgba(124,58,237,0.3)",color:"#a78bfa"}} onClick={(e) => { e.stopPropagation(); setMoveDialog({ sessionId: s.id, teamName: s.teamName, slots: getEmptySlots(s.id) }); }}>Move</button>
          </div>
        )}
        {s.stage === 'IN_PROGRESS' && (
          <div className="sess-btns">
            <button type="button" className="btn-act btn-done" onClick={(e) => { e.stopPropagation(); updateStage(s.id, 'COMPLETED'); }}>Complete</button>
            <button type="button" className="btn-act btn-delay" onClick={(e) => { e.stopPropagation(); updateStage(s.id, 'DELAYED'); }}>Delay</button>
          </div>
        )}
        {s.stage === 'DELAYED' && (
          <div className="sess-btns">
            <button type="button" className="btn-act btn-go" onClick={(e) => { e.stopPropagation(); updateStage(s.id, 'IN_PROGRESS'); }}>Resume</button>
            <button type="button" className="btn-act btn-cancel" onClick={(e) => { e.stopPropagation(); updateStage(s.id, 'CANCELLED'); }}>Cancel</button>
          </div>
        )}
      </div>
    );
  };

  // Render period block
  const PeriodBlock = ({ period, label, colorClass }: { period: 'AM' | 'PM'; label: string; colorClass: string }) => {
    if (!activeDate) return null;
    const periodSessions = sessions.filter((s: any) => getDate(s) === activeDate && (period === 'AM' ? getHour(s) < 12 : getHour(s) >= 12));
    if (periodSessions.length === 0) return null;

    return (
      <div style={{ marginBottom: 24 }}>
        <span className={`period-badge ${colorClass}`}>{label}</span>
        <div className="room-grid" style={{ gridTemplateColumns: `repeat(${Math.min(roomNames.filter(r => getSessionsFor(activeDate!, period, r).length > 0).length, 3)}, 1fr)` }}>
          {roomNames.map(room => {
            const rs = getSessionsFor(activeDate!, period, room);
            if (rs.length === 0) return null;
            const done = rs.filter((s: any) => s.stage === 'COMPLETED').length;
            const hasActive = rs.some((s: any) => s.stage === 'IN_PROGRESS');
            return (
              <div className={`room-col ${hasActive ? 'room-active' : ''}`} key={room}>
                <div className="room-hdr">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {hasActive && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', animation: 'pls 2s ease-in-out infinite' }} />}
                    <span className="room-name">{room}</span>
                  </div>
                  <span className="room-count">{done}/{rs.length} done</span>
                </div>
                <div className="sess-list">
                  {rs.map((s: any) => <SessionCard key={s.id} s={s} />)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div>
      {msgOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setMsgOpen(false)}>
          <div className="w-full max-w-lg rounded-xl border border-dark-600 bg-dark-800 p-5"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-white">Message judges</span>
              <button type="button" onClick={() => setMsgOpen(false)} className="text-slate-500 hover:text-white">✕</button>
            </div>

            <div className="mb-3 max-h-44 overflow-y-auto rounded-lg border border-dark-600 p-2">
              {judges.map((j: any) => {
                const has = unread.some((m: any) => m.judgeId === j.id);
                const on = msgTo.includes(j.id);
                return (
                  <label key={j.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-dark-700">
                    <input type="checkbox" checked={on}
                      onChange={() => setMsgTo(prev => on ? prev.filter(x => x !== j.id) : [...prev, j.id])} />
                    <span className="text-xs text-slate-300">{j.name}</span>
                    {/* An undismissed message means they have not looked yet. */}
                    {has && <span className="ml-auto text-[10px] text-amber-400">unread note</span>}
                  </label>
                );
              })}
            </div>

            <div className="mb-3 flex gap-2">
              <button type="button" onClick={() => setMsgTo(judges.map((j: any) => j.id))}
                className="text-[11px] text-accent hover:underline">Select all</button>
              <button type="button" onClick={() => setMsgTo([])}
                className="text-[11px] text-slate-500 hover:underline">Clear</button>
              <span className="ml-auto text-[11px] text-slate-500">
                {msgTo.length} selected
                {msgTo.length > 0 && msgTo.length < judges.length && ' — edit above if wrong'}
              </span>
            </div>

            <textarea value={msgBody} onChange={e => setMsgBody(e.target.value)}
              rows={3} maxLength={280}
              placeholder="Room 2 is running about 15 minutes behind — no need to move."
              className="w-full rounded-lg border border-dark-600 bg-dark-900/60 px-3 py-2 text-xs text-slate-200 outline-none resize-none" />

            <div className="mt-3 flex items-center gap-3">
              <span className="text-[11px] text-slate-500">
                Replaces any note they have not yet dismissed.
              </span>
              <button type="button" onClick={sendMessage}
                disabled={msgSending || !msgBody.trim() || msgTo.length === 0}
                className="ml-auto rounded-lg bg-accent px-4 py-2 text-xs font-medium text-white disabled:opacity-40">
                {msgSending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pls{0%,100%{opacity:1}50%{opacity:0.4}}
        @keyframes fi{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
        .cc-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
        .cc-hdr h1{font-size:22px;font-weight:600;color:#fff}
        .cc-sub{font-size:15px;color:#b4c2d4;margin-top:2px}
        .cc-actions{display:flex;align-items:center;gap:10px}
        .cc-btn{padding:8px 16px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.2s;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#fff}
        .cc-btn:hover{background:rgba(255,255,255,0.08)}
        .cc-live{display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:8px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2)}
        .cc-msg{padding:8px 16px;border-radius:8px;font-size:14px;font-weight:500;animation:fi 0.3s ease}
        .cc-msg-ok{background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);color:#34d399}
        .cc-msg-err{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);color:#f87171}
        .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
        .stat{padding:14px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02)}
        .stat-l{font-size:13px;color:#8ea3bc;text-transform:uppercase;letter-spacing:0.08em;font-weight:600}
        .stat-v{font-size:28px;font-weight:600;color:#fff;margin-top:4px}
        .date-tabs{display:flex;gap:8px;margin-bottom:16px}
        .date-tab{padding:8px 20px;border-radius:8px;font-size:15px;font-weight:500;cursor:pointer;transition:all 0.2s;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);color:#b4c2d4}
        .date-tab:hover{background:rgba(255,255,255,0.04)}
        .date-tab.on{background:rgba(124,58,237,0.12);border-color:rgba(124,58,237,0.3);color:#a78bfa}
        .period-badge{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;padding:6px 14px;border-radius:6px;display:inline-block;margin-bottom:10px}
        .period-am{background:rgba(59,130,246,0.08);color:#60a5fa}
        .period-pm{background:rgba(245,158,11,0.08);color:#fbbf24}
        .room-grid{display:grid;gap:12px}
        .room-col{border-radius:12px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);overflow:hidden}
        .room-active{border-color:rgba(16,185,129,0.2)}
        .room-hdr{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.02)}
        .room-name{font-size:16px;font-weight:500;color:#fff}
        .room-count{font-size:13px;color:#8ea3bc}
        .sess-list{padding:8px}
        .sess{padding:14px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);margin-bottom:8px;transition:all 0.2s;position:relative}
        .sess:hover{background:rgba(255,255,255,0.04);border-color:rgba(255,255,255,0.1)}
        .sess.dragging{opacity:0.4;border-style:dashed}
        .sess.drag-over{border-color:rgba(124,58,237,0.5);background:rgba(124,58,237,0.08);box-shadow:0 0 0 2px rgba(124,58,237,0.2)}
        .sess.active-sess{border-color:rgba(16,185,129,0.3);background:rgba(16,185,129,0.05)}
        .sess.due-now{border-color:rgba(59,130,246,0.4);animation:pulse-border 2s ease-in-out infinite}
        .sess.overrun{border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.04)}
        @keyframes pulse-border{0%,100%{box-shadow:0 0 0 0 rgba(59,130,246,0.3)}50%{box-shadow:0 0 0 4px rgba(59,130,246,0.15)}}
        .timer-bar{position:absolute;top:0;left:0;right:0;height:3px;background:rgba(255,255,255,0.06);border-radius:10px 10px 0 0;overflow:hidden}
        .timer-fill{height:100%;background:linear-gradient(90deg,#10b981,#3b82f6);transition:width 1s linear;border-radius:10px 10px 0 0}
        .timer-overrun{background:linear-gradient(90deg,#ef4444,#f97316);animation:pulse-bar 1s ease-in-out infinite}
        @keyframes pulse-bar{0%,100%{opacity:1}50%{opacity:0.6}}
        .timer-badge{padding:3px 8px;border-radius:5px;font-size:13px;font-weight:600;font-family:'JetBrains Mono',monospace;background:rgba(16,185,129,0.12);color:#10b981;border:1px solid rgba(16,185,129,0.2)}
        .timer-badge-warn{background:rgba(245,158,11,0.12);color:#f59e0b;border-color:rgba(245,158,11,0.2);animation:pulse-bar 1.5s ease-in-out infinite}
        .timer-badge-overrun{background:rgba(239,68,68,0.12);color:#ef4444;border-color:rgba(239,68,68,0.2);animation:pulse-bar 1s ease-in-out infinite}
        .due-dot{width:8px;height:8px;border-radius:50%;background:#3b82f6;animation:pls 1.5s ease-in-out infinite;flex-shrink:0}
        .sess.swap-valid{border-color:rgba(16,185,129,0.4);background:rgba(16,185,129,0.06);box-shadow:0 0 0 1px rgba(16,185,129,0.15);cursor:pointer}
        .sess.swap-valid:hover{background:rgba(16,185,129,0.12);border-color:rgba(16,185,129,0.5)}
        .sess.swap-invalid{opacity:0.2}
        .sess.swap-source{border-color:rgba(124,58,237,0.5);background:rgba(124,58,237,0.08);box-shadow:0 0 0 2px rgba(124,58,237,0.25)}
        .swap-click-zone{position:absolute;inset:0;z-index:10;cursor:pointer;display:flex;align-items:center;justify-content:center;border-radius:10px;background:rgba(16,185,129,0.04);transition:background 0.2s}
        .swap-click-zone:hover{background:rgba(16,185,129,0.12)}
        .swap-click-label{padding:6px 16px;border-radius:6px;background:rgba(16,185,129,0.15);color:#10b981;font-size:14px;font-weight:500;border:1px solid rgba(16,185,129,0.3)}
        .sess.dragging{opacity:0.4;border-style:dashed;border-color:rgba(124,58,237,0.4)}
        .sess.drag-over{border-color:rgba(16,185,129,0.6);background:rgba(16,185,129,0.1);box-shadow:0 0 0 2px rgba(16,185,129,0.3);transform:scale(1.02)}
        .swap-btn{padding:4px 12px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#b4c2d4;transition:all 0.2s}
        .swap-btn:hover{background:rgba(124,58,237,0.1);border-color:rgba(124,58,237,0.3);color:#a78bfa}
        .swap-btn-active{background:rgba(124,58,237,0.15);border-color:rgba(124,58,237,0.4);color:#a78bfa}
        .sess-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
        .sess-team{font-size:17px;font-weight:500;color:#fff}
        .sess-meta{display:flex;justify-content:space-between;align-items:center;font-size:14px;color:#8ea3bc}
        .sess-time{font-family:'JetBrains Mono',monospace;font-size:15px}
        .sess-btns{display:flex;gap:6px;margin-top:10px}
        .btn-act{padding:7px 16px;border-radius:7px;font-size:14px;font-weight:500;cursor:pointer;border:none;transition:all 0.2s}
        .btn-go{background:#059669;color:#fff}.btn-go:hover{background:#10b981}
        .btn-done{background:#059669;color:#fff}
        .btn-delay{background:#d97706;color:#fff}
        .btn-cancel{background:#dc2626;color:#fff}

        /* Expanded card */
        .sess-expanded{margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06)}
        .exp-section{margin-bottom:12px}
        .exp-label{font-size:13px;color:#8ea3bc;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:6px}
        .exp-value{font-size:15px;color:#e2e8f0}
        .exp-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
        .exp-tag{padding:4px 10px;border-radius:6px;font-size:13px;font-weight:500}
        .tag-track{background:rgba(124,58,237,0.1);color:#a78bfa;border:1px solid rgba(124,58,237,0.2)}
        .tag-dept{background:rgba(59,130,246,0.1);color:#60a5fa;border:1px solid rgba(59,130,246,0.2)}
        .tag-org{background:rgba(255,255,255,0.04);color:#b4c2d4;border:1px solid rgba(255,255,255,0.08)}
        .exp-tools{display:flex;flex-wrap:wrap;gap:4px}
        .exp-tool{padding:3px 8px;border-radius:4px;font-size:13px;background:rgba(255,255,255,0.04);color:#b4c2d4;border:1px solid rgba(255,255,255,0.06)}
        .exp-judge{display:flex;justify-content:space-between;align-items:center;padding:5px 10px;border-radius:6px;background:rgba(255,255,255,0.03);margin-bottom:4px}
        .exp-judge-name{font-size:15px;color:#fff}
        .exp-judge-type{font-size:13px;color:#8ea3bc;text-transform:uppercase}
        .exp-add-judge{font-size:13px;color:#7c3aed;cursor:pointer;margin-top:6px;display:inline-block}
        .exp-add-judge:hover{color:#a78bfa}
        .exp-repl{border-radius:8px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);padding:10px;margin-top:6px}
        .exp-repl-row{display:flex;justify-content:space-between;align-items:center;padding:4px 4px;font-size:14px}
        .exp-repl-add{padding:4px 10px;border-radius:4px;background:#7c3aed;color:#fff;font-size:13px;cursor:pointer;border:none}
        .exp-bar{height:6px;border-radius:3px;background:rgba(255,255,255,0.06);overflow:hidden}
        .exp-bar-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,#7c3aed,#3b82f6)}

        /* Health */
        .health-panel{border-radius:10px;border:1px solid rgba(239,68,68,0.2);background:rgba(239,68,68,0.04);padding:14px;margin-bottom:16px}
        .health-title{font-size:15px;font-weight:600;color:#f87171;margin-bottom:8px}
        .health-row{display:flex;justify-content:space-between;padding:4px 0;font-size:14px}

        /* Swap dialog */
        .swap-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:50;display:flex;align-items:center;justify-content:center;animation:fi 0.2s ease}
        .swap-dialog{background:#111827;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:28px;width:480px;max-width:90vw}
        .swap-title{font-size:20px;font-weight:600;color:#fff;margin-bottom:20px;text-align:center}
        .swap-teams{display:flex;align-items:stretch;gap:12px;justify-content:center;margin-bottom:24px}
        .swap-card{padding:16px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);flex:1}
        .swap-card-name{font-size:17px;font-weight:500;color:#fff}
        .swap-card-project{font-size:14px;color:#a78bfa;margin-top:3px}
        .swap-card-time{font-size:14px;color:#8ea3bc;margin-top:6px}
        .swap-card-judges{font-size:13px;color:#8ea3bc;margin-top:4px}
        .swap-arrow{font-size:24px;color:#7c3aed;display:flex;align-items:center}
        .swap-options{display:flex;flex-direction:column;gap:10px}
        .swap-opt{padding:16px 20px;border-radius:12px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);cursor:pointer;transition:all 0.2s;text-align:left}
        .swap-opt:hover{background:rgba(124,58,237,0.08);border-color:rgba(124,58,237,0.3)}
        .swap-opt-title{font-size:16px;font-weight:500;color:#fff}
        .swap-opt-desc{font-size:14px;color:#8ea3bc;margin-top:4px;line-height:1.5}
        .swap-opt-rec{display:inline-block;padding:2px 8px;border-radius:4px;background:rgba(16,185,129,0.1);color:#10b981;font-size:12px;font-weight:600;margin-left:8px;text-transform:uppercase}
        .swap-cancel{text-align:center;margin-top:14px}
        .swap-cancel-btn{font-size:15px;color:#8ea3bc;cursor:pointer;background:none;border:none;padding:8px 16px}
        .swap-cancel-btn:hover{color:#fff}
        .drag-hint{font-size:14px;color:#8ea3bc;margin-bottom:10px}
      `}</style>

      {/* Header */}
      <div className="cc-hdr">
        <div>
          <h1>Command Centre</h1>
          <p className="cc-sub">{event?.name} {event?.status ? `- ${event.status}` : ''}</p>
        </div>
        <div className="cc-actions">
          {message && <div className={`cc-msg ${msgType === 'ok' ? 'cc-msg-ok' : 'cc-msg-err'}`}>{message}</div>}
          <button type="button" className="cc-btn" onClick={() => setMsgOpen(true)}>
            Message judges{unread.length > 0 ? ` (${unread.length})` : ''}
          </button>
          <button type="button" className="cc-btn" onClick={runHealthCheck}>Health check</button>
          <div style={{ padding: '6px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontFamily: 'JetBrains Mono, monospace', fontSize: 16, fontWeight: 500, color: '#fff' }}>
            {now.toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
          </div>
          <div className="cc-live"><div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', animation: 'pls 2s ease-in-out infinite' }} /><span style={{ fontSize: 15, color: '#10b981', fontWeight: 500 }}>Live</span></div>
        </div>
      </div>

      {/* Stats */}
      <div className="stats">
        <div className="stat"><div className="stat-l">Active</div><div className="stat-v" style={{ color: inProgress > 0 ? '#10b981' : '#fff' }}>{inProgress}</div></div>
        <div className="stat"><div className="stat-l">Upcoming</div><div className="stat-v" style={{ color: '#60a5fa' }}>{upcoming}</div></div>
        <div className="stat"><div className="stat-l">Completed</div><div className="stat-v" style={{ color: '#a78bfa' }}>{completed}</div></div>
        <div className="stat"><div className="stat-l">Delayed</div><div className="stat-v" style={{ color: delayed > 0 ? '#fbbf24' : '#fff' }}>{delayed}</div></div>
      </div>

      {/* Health issues */}
      {healthIssues.length > 0 && (
        <div className="health-panel">
          <div className="health-title">Issues found</div>
          {healthIssues.map((h: any) => (
            <div className="health-row" key={h.sessionId}>
              <span style={{ color: '#fff' }}>{h.teamName} - {h.roomName}</span>
              <span style={{ color: '#f87171' }}>{h.issues.join(', ')}</span>
            </div>
          ))}
        </div>
      )}

      {/* Date tabs */}
      <div className="date-tabs">
        {dates.map(d => (
          <div key={d} className={`date-tab ${activeDate === d ? 'on' : ''}`} onClick={() => setActiveDate(d)}>{d}</div>
        ))}
      </div>

      {activeDate && (
        <>
          {swapSource ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderRadius: 8, background: 'rgba(124,58,237,0.08)', border: '1px solid rgba(124,58,237,0.2)', marginBottom: 12 }}>
              <span style={{ fontSize: 15, color: '#a78bfa', fontWeight: 500 }}>
                Swapping: {sessions.find((s: any) => s.id === swapSource)?.teamName} — click a green card to swap with
              </span>
              <button type="button" onClick={cancelSwapSelection} style={{ fontSize: 14, color: '#8ea3bc', cursor: 'pointer', background: 'none', border: 'none', padding: '4px 12px' }}>Cancel</button>
            </div>
          ) : (
            <p className="drag-hint">Drag a card onto another to swap, or click "Swap" button then click a target.</p>
          )}
          <PeriodBlock period="AM" label="Morning (AM)" colorClass="period-am" />
          <PeriodBlock period="PM" label="Afternoon (PM)" colorClass="period-pm" />
        </>
      )}

      {/* Swap dialog */}
      {moveDialog && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50}} onClick={() => setMoveDialog(null)}>
          <div style={{background:"#1e1e2e",borderRadius:12,padding:24,width:480,maxHeight:"70vh",overflow:"auto",border:"1px solid rgba(255,255,255,0.1)"}} onClick={e => e.stopPropagation()}>
            <h3 style={{fontSize:17,fontWeight:500,color:"#fff",marginBottom:4}}>Move {moveDialog.teamName}</h3>
            <p style={{fontSize:14,color:"#b4c2d4",marginBottom:16}}>Select an empty slot</p>
            {moveDialog.slots.length === 0 ? <p style={{color:"#f59e0b",fontSize:14}}>No empty slots available</p> : (
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {moveDialog.slots.map((slot: any, i: number) => (
                  <button type="button" key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 14px",borderRadius:8,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",cursor:"pointer",color:"#fff",fontSize:14}} onClick={() => executeMove(moveDialog.sessionId, slot.slotId, slot.roomId)}>
                    <span style={{fontWeight:500}}>{slot.time}</span>
                    <span style={{color:"#b4c2d4"}}>{slot.roomName}</span>
                    <span style={{color:"#8ea3bc",fontSize:13}}>{slot.date}</span>
                  </button>
                ))}
              </div>
            )}
            <button type="button" style={{marginTop:16,padding:"8px 16px",borderRadius:8,background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.1)",color:"#fff",cursor:"pointer",fontSize:14}} onClick={() => setMoveDialog(null)}>Cancel</button>
          </div>
        </div>
      )}

      {swapDialog && (
        <div className="swap-overlay" onClick={() => setSwapDialog(null)}>
          <div className="swap-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="swap-title">Swap sessions</div>
            <div className="swap-teams">
              <div className="swap-card">
                <div className="swap-card-name">{swapDialog.source.teamName}</div>
                <div className="swap-card-project">{swapDialog.source.projectName || ''}</div>
                <div className="swap-card-time">{getTime(swapDialog.source)} - {swapDialog.source.roomName}</div>
                <div className="swap-card-judges">{(swapDialog.source.judges || []).map((j: any) => j.judgeName).join(', ')}</div>
              </div>
              <div className="swap-arrow">{'\u21C4'}</div>
              <div className="swap-card">
                <div className="swap-card-name">{swapDialog.target.teamName}</div>
                <div className="swap-card-project">{swapDialog.target.projectName || ''}</div>
                <div className="swap-card-time">{getTime(swapDialog.target)} - {swapDialog.target.roomName}</div>
                <div className="swap-card-judges">{(swapDialog.target.judges || []).map((j: any) => j.judgeName).join(', ')}</div>
              </div>
            </div>
            <div className="swap-options">
              <div className="swap-opt" onClick={() => executeSwap('teams')}>
                <div className="swap-opt-title">Swap teams only<span className="swap-opt-rec">Recommended</span></div>
                <div className="swap-opt-desc">Teams switch positions. Judges stay in their assigned rooms. No judge conflicts possible. Scorecards reassigned automatically.</div>
              </div>
              <div className="swap-opt" onClick={() => executeSwap('full')}>
                <div className="swap-opt-title">Swap everything</div>
                <div className="swap-opt-desc">Teams, judges, rooms, and time slots all swap. May fail if judges have scheduling conflicts in the target slot.</div>
              </div>
            </div>
            <div className="swap-cancel">
              <button type="button" className="swap-cancel-btn" onClick={() => setSwapDialog(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
