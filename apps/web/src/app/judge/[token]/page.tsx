'use client';
import { useState, useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import DriftMetronome from '@/components/drift-metronome';
import QuadrantView from '@/components/quadrant-view';
import { platformColor } from '@/components/platform-chip';
import UseCasePanel from '@/components/use-case-panel';


/**
 * How a message should look.
 *
 * The banner used to turn red only for text containing "Error" or "required",
 * so `Score for "Test 1" must be between 0 and 25 (got -5)` — a refusal —
 * rendered in the same green as "Draft saved". A judge skimming between
 * presentations reads the colour before the words, and a refusal that looks
 * like a confirmation is how a score is believed to be saved when it is not.
 *
 * Matched on meaning rather than on keywords, so a new message gets a sensible
 * colour without anyone remembering to add it to a list.
 */
type Tone = 'bad' | 'warn' | 'good';

const MESSAGE_TONE: Record<Tone, string> = {
  bad: 'bg-red-500/10 text-red-700 border border-red-200',
  warn: 'bg-amber-500/10 text-amber-900 border border-amber-200',
  good: 'bg-green-500/10 text-emerald-700 border border-emerald-200',
};

function toneOf(message: string): Tone {
  const m = message.toLowerCase();
  if (
    m.startsWith('error') ||
    m.includes('not submitted') ||
    m.includes('must be between') ||
    m.includes('is required') ||
    m.includes('could not') ||
    m.includes('failed') ||
    m.includes('not saved') ||
    m.includes('already submitted')
  ) return 'bad';

  if (
    m.includes('another device') ||
    m.includes('reload') ||
    m.includes('check your entries') ||
    m.includes('behind the current rubric')
  ) return 'warn';

  return 'good';
}

export default function JudgePortalPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const token = params.token as string;
  const eventId = searchParams.get('event') || '';
  const [schedule, setSchedule] = useState<any>(null);
  const [scorecards, setScorecards] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [infoSessionId, setInfoSessionId] = useState<string | null>(null);
  const [activeScorecard, setActiveScorecard] = useState<any>(null);
  const [scores, setScores] = useState<Record<string, { score: number | null; comment: string }>>({});
  // What the server held when this scorecard was loaded, and what we last
  // successfully sent. Together these let a save carry only what changed and
  // refuse to overwrite work done on another device (CONCUR-3, CONCUR-4).
  /**
   * Whether to mark what is missing.
   *
   * A fresh scorecard shows nothing in red. Eleven red boxes on a card a judge
   * has just opened reads as eleven errors rather than eleven questions, and
   * the judge has done nothing wrong yet.
   *
   * It turns on when they engage — score anything, or press Submit once. From
   * then on the page points at what is outstanding, and the submit button
   * locks until it is not.
   */
  const [engaged, setEngaged] = useState(false);
  const [serverUpdatedAt, setServerUpdatedAt] = useState<string | null>(null);
  const [savedScores, setSavedScores] = useState<Record<string, { score: number | null; comment: string }>>({});
  const [strengths, setStrengths] = useState('');
  const [improvements, setImprovements] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  // Whether there is unsaved work, and when it was last written. Both are shown
  // to the judge — a scorecard that says nothing about its state invites the
  // assumption that it saved.
  const [dirty, setDirty] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  const apiUrl = typeof window !== 'undefined' ? window.location.origin.replace(':3000', ':4000') : '';

  const fetchData = async () => {
    if (!token || !eventId) return;
    try {
      const [schedRes, scRes] = await Promise.all([
        fetch(`${apiUrl}/api/judge-portal/${token}?event=${eventId}`),
        fetch(`${apiUrl}/api/judge-portal/${token}/scorecards?event=${eventId}`),
      ]);
      if (!schedRes.ok) throw new Error('Invalid link');
      const schedData = await schedRes.json();
      const scData = scRes.ok ? await scRes.json() : [];
      setSchedule(schedData);
      setScorecards(scData);
      setLastUpdated(new Date());
    } catch (e: any) { setError(e.message); }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [token, eventId]);
  // Suspended while a scorecard is open. A background refetch of the very card
  // a judge is filling in is a data-loss bug waiting for the right refactor.
  useEffect(() => {
    if (!token || !eventId || activeScorecard) return;
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [token, eventId, activeScorecard]);

  /**
   * Opens a scorecard from the server, and only from the server.
   *
   * There used to be a sessionStorage mirror here, restored ahead of the
   * server's copy on the reasoning that a tab reclaimed between autosaves
   * would otherwise lose work. It restored whole entries with Object.assign,
   * so a cached `{score: 7, comment: ''}` overwrote a stored
   * `{score: 7, comment: '…'}` — the score matched and the comment was wiped.
   * A judge would reopen a scorecard and find their comments gone while their
   * scores remained, with the text sitting safely in the database the whole
   * time.
   *
   * A page that shows something other than what is stored is worse than one
   * that is slower to load. The autosave already puts work on the server
   * within twenty seconds and on every tab hide, which is the protection that
   * matters; the mirror only added a second, quieter source of truth.
   */
  // Flush any unsaved work before leaving or switching a scorecard. Navigating
  // away used to just drop in-memory scores that the 20s autosave had not yet
  // persisted, so a judge who scored, switched teams, and came back found the
  // card blank. Saving-on-exit closes that gap.
  const leaveScorecard = async (then?: () => void) => {
    if (activeScorecard && dirty && !saving) {
      await saveOrSubmit(false, true);
    }
    if (then) then();
    else setActiveScorecard(null);
  };

  const openScorecard = (sc: any) => {
    setActiveScorecard(sc);
    const scoreMap: Record<string, { score: number | null; comment: string }> = {};
    sc.criterionScores?.forEach((cs: any) => {
      scoreMap[cs.criterionId] = { score: cs.score, comment: cs.comment || '' };
    });

    setServerUpdatedAt(sc.updatedAt ?? null);
    // The baseline for change detection is exactly what was loaded.
    setSavedScores({ ...scoreMap });

    // A scorecard with anything already scored is engaged: the judge has been
    // here before, so marking what is still missing is fair from the start.
    setEngaged(Object.values(scoreMap).some(v => v.score !== null && v.score !== undefined));
    setDirty(false);
    setLastSaved(null);
    setScores(scoreMap);
    setStrengths(sc.overallStrengths || '');
    setImprovements(sc.areasForImprovement || '');
    setRecommendation(sc.recommendation || '');
    setMessage('');
  };

  // Autosave twenty seconds after the last change. Long enough not to fight the
  // judge mid-sentence, short enough that little is at stake.
  useEffect(() => {
    if (!activeScorecard || !dirty || saving) return;
    const t = setTimeout(() => { saveOrSubmit(false, true); }, 20000);
    return () => clearTimeout(t);
  }, [scores, strengths, improvements, recommendation, dirty, activeScorecard, saving]);

  // And immediately when the page is hidden. On a phone this fires when the
  // screen locks or the judge switches app — precisely when the tab is most
  // likely to be evicted.
  useEffect(() => {
    if (!activeScorecard) return;
    const onHide = () => {
      if (document.visibilityState === 'hidden' && dirty) {
        saveOrSubmit(false, true);
      }
    };

    // Coming back to a device after working on another one. With nothing
    // unsaved the server's copy is simply better, so take it. With unsaved work
    // the judge is told rather than having either version silently win
    // (CONCUR-1, CONCUR-2).
    const onShow = async () => {
      if (document.visibilityState !== 'visible' || !activeScorecard) return;
      try {
        const res = await fetch(
          `${apiUrl}/api/judge-portal/${token}/scorecards?event=${eventId}`,
        );
        if (!res.ok) return;
        const list = await res.json();
        const mine = list.find((c: any) => c.id === activeScorecard.id);
        if (!mine) return;
        if (mine.updatedAt === serverUpdatedAt) return;

        if (dirty) {
          setMessage(
            'This scorecard was also updated on another device. Check your ' +
            'entries before saving — saving now will be refused until you reload.',
          );
          return;
        }
        openScorecard(mine);
        setMessage('Refreshed from your other device.');
      } catch { /* offline; the existing save paths still apply */ }
    };
    document.addEventListener('visibilitychange', onHide);
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('pagehide', onHide);
    };
  }, [activeScorecard, dirty, scores, strengths, improvements, recommendation, serverUpdatedAt]);

  /**
   * What still stands between this scorecard and a submission.
   *
   * The rules are the server's, restated: every leaf criterion scored, and a
   * comment wherever one is required. They are restated rather than inferred
   * because a judge should be told what is missing before they press the
   * button, not after — and a refusal that names nothing leaves them pressing
   * it again.
   *
   * The server keeps its own check regardless. This is a courtesy, not a
   * guard: if the two ever disagree the server is right, and the judge sees a
   * message rather than a silent failure.
   */
  const outstanding = useMemo(() => {
    if (!activeScorecard) return { missingScores: [], missingComments: [] };

    const rows = (activeScorecard.criterionScores || [])
      .filter((cs: any) => !!cs.parentId)
      .sort((a: any, b: any) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

    const missingScores: string[] = [];
    const missingComments: string[] = [];

    for (const cs of rows) {
      const s = scores[cs.criterionId] || { score: null, comment: '' };
      const outOfRange =
        s.score !== null && s.score !== undefined &&
        (s.score < 0 || s.score > cs.maxScore);
      if (s.score === null || s.score === undefined || outOfRange) {
        missingScores.push(cs.criterionName || cs.name || 'a criterion');
      } else if (cs.requiresComment && !(s.comment || '').trim()) {
        missingComments.push(cs.criterionName || cs.name || 'a criterion');
      }
    }

    return { missingScores, missingComments };
  }, [activeScorecard, scores]);

  const canSubmit =
    outstanding.missingScores.length === 0 &&
    outstanding.missingComments.length === 0;

  /** A sentence a judge can act on, naming everything at once. */
  const outstandingText = useMemo(() => {
    const { missingScores, missingComments } = outstanding;
    if (!missingScores.length && !missingComments.length) return '';

    const list = (names: string[]) =>
      names.length <= 3
        ? names.join(', ')
        : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;

    const parts: string[] = [];
    if (missingScores.length) {
      parts.push(
        `${missingScores.length} ${missingScores.length > 1 ? 'criteria' : 'criterion'} ` +
        `not yet scored: ${list(missingScores)}`,
      );
    }
    if (missingComments.length) {
      parts.push(
        `${missingComments.length} comment${missingComments.length > 1 ? 's' : ''} ` +
        `required: ${list(missingComments)}`,
      );
    }
    return parts.join('. ');
  }, [outstanding]);

  // A last line of defence for a deliberate close with work outstanding.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const saveOrSubmit = async (submit: boolean, auto = false) => {
    if (!activeScorecard) return;
    if (auto && !dirty) return;
    setSaving(true);
    try {
      // Only what changed since the last successful save (CONCUR-3). A tab
      // left open on another device then has nothing to send, so it cannot
      // quietly overwrite work done elsewhere. A submit sends everything, so
      // the server validates against a complete picture.
      const changed = Object.entries(scores).filter(([criterionId, s]) => {
        if (submit) return s.score !== null;
        const was = savedScores[criterionId];
        return !was || was.score !== s.score || (was.comment || '') !== (s.comment || '');
      });

      if (auto && changed.length === 0 && !dirty) { setSaving(false); return; }

      // Refuse locally with a specific reason. The server refuses too, and its
      // message names only the first failing criterion; this names all of them,
      // and does so without a round trip.
      if (submit && !canSubmit) {
        // The press that cannot succeed is the press that explains itself: it
        // turns on the highlighting and then the button locks.
        setEngaged(true);
        setMessage(`Not submitted. ${outstandingText}`);
        setSaving(false);
        return;
      }

      /**
       * Send each field only when the judge changed it.
       *
       * The payload used to carry `score: s.score` unconditionally, so a save
       * that only touched a comment sent `score: null` for that criterion and
       * the server wrote the null over a stored score. Comments were spared
       * because they went out as `comment || undefined`, which Prisma leaves
       * alone — an asymmetry with nothing behind it, and the field it erased
       * is the one the ranking is built from.
       *
       * Omitting a field now means "not changing this". Clearing one means
       * sending it explicitly as null, which only happens when the judge
       * empties the box.
       */
      const body = {
        scorecardId: activeScorecard.id,
        scores: changed.map(([criterionId, s]) => {
          const was = savedScores[criterionId];
          const entry: any = { criterionId };

          const scoreChanged = !was || was.score !== s.score;
          const commentChanged = !was || (was.comment || '') !== (s.comment || '');

          // On submit the server validates against everything it holds, so it
          // is sent whole rather than as a diff.
          if (submit || scoreChanged) entry.score = s.score;
          if (submit || commentChanged) entry.comment = s.comment || null;

          return entry;
        }),
        overallStrengths: strengths || undefined,
        areasForImprovement: improvements || undefined,
        recommendation: recommendation || undefined,
        submit,
        expectedUpdatedAt: serverUpdatedAt || undefined,
      };
      const res = await fetch(`${apiUrl}/api/judge-portal/${token}/score?event=${eventId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      // 409: this scorecard changed on another device. Never merge silently —
      // reload and let the judge see what is actually stored (CONCUR-2).
      if (res.status === 409) {
        setMessage(
          'This scorecard was updated on another device. Reloading — your ' +
          'unsaved changes are still on screen, check them before saving again.',
        );
        const fresh = await fetch(
          `${apiUrl}/api/judge-portal/${token}/scorecards?event=${eventId}`,
        );
        if (fresh.ok) {
          const list = await fresh.json();
          const mine = list.find((c: any) => c.id === activeScorecard.id);
          if (mine) {
            setServerUpdatedAt(mine.updatedAt ?? null);
            const serverMap: Record<string, { score: number | null; comment: string }> = {};
            mine.criterionScores?.forEach((cs: any) => {
              serverMap[cs.criterionId] = { score: cs.score, comment: cs.comment || '' };
            });
            setSavedScores(serverMap);
          }
        }
        setSaving(false);
        return;
      }

      if (data.error || data.message?.startsWith('Error') || !res.ok) {
        // An autosave that fails must not be silent — the judge would carry on
        // believing their work was safe.
        setMessage(data.message || data.error ||
          (auto ? 'Autosave failed — press Save draft' : 'Error saving'));
      } else {
        setDirty(false);
        setLastSaved(new Date());
        if (data.updatedAt) setServerUpdatedAt(data.updatedAt);
        setSavedScores({ ...scores });
        if (data.ignoredCriterionIds?.length) {
          setMessage(
            `${data.ignoredCriterionIds.length} entry(ies) were not saved because ` +
            'this page is behind the current rubric. Reload before continuing.',
          );
        }
        setMessage(submit ? 'Scorecard submitted!' : auto ? '' : 'Draft saved');
        if (submit) {
          setActiveScorecard(null);
          fetchData();
        }
      }
    } catch (e: any) { setMessage('Error: ' + e.message); }
    setSaving(false);
  };

  if (loading) return (
    <main className="min-h-screen bg-[#f4f6fa] flex items-center justify-center">
      <p className="text-slate-600 text-xl">Loading your schedule...</p>
    </main>
  );
  if (error) return (
    <main className="min-h-screen bg-[#f4f6fa] flex items-center justify-center">
      <p className="text-red-400 text-xl font-semibold">Invalid Link</p>
    </main>
  );

  const judge = schedule?.judge;
  const sessions = schedule?.sessions || [];
  const scored = scorecards.filter((s: any) => ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(s.status)).length;
  const totalScore = Object.values(scores).reduce((sum, s) => sum + (s.score || 0), 0);

  // Group by date
  const byDate: Record<string, any[]> = {};
  sessions.forEach((s: any) => {
    const d = new Date(s.date).toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'long' });
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(s);
  });

  return (
    <main className="min-h-screen bg-[#f4f6fa] flex flex-col">
      {/* Header */}
      <div className="shrink-0 bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 sm:gap-4 min-w-0">
              {/* The avatar is decoration, and a judge who opened their own
                  link knows who they are. It goes on narrow screens. */}
              <div className="hidden sm:flex w-14 h-14 rounded-2xl bg-slate-900/10 border border-slate-300 items-center justify-center text-3xl text-slate-700 font-bold">
                {judge?.name?.[0]}
              </div>
              <div className="min-w-0">
                <h1 className="text-xl sm:text-2xl font-bold text-slate-900 truncate">{judge?.name}</h1>
                <p className="text-sm sm:text-base text-slate-600 truncate">{judge?.judgeType} Judge · {judge?.organisation}</p>
              </div>
            </div>
            {lastUpdated && (
              <div className="text-right">
                <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" /><span className="text-sm text-slate-500">Live</span></div>
                <p className="text-sm text-slate-500 mt-0.5">Updated {lastUpdated.toLocaleTimeString()}</p>
              </div>
            )}
          </div>
          {/* The quadrants already carry these three counts. Two summaries of
              the same thing is one too many. */}
        </div>
      </div>

      {/* A message a judge can only see on one screen is a message that gets
          missed, so it floats above everything — including an open scorecard,
          which is where they spend most of their time. */}
      {schedule?.message && (
        <div className="fixed inset-x-0 bottom-0 z-[70] p-3 sm:p-4">
          <div className="mx-auto flex max-w-3xl items-start gap-3 rounded-2xl border border-slate-300 bg-white p-4 shadow-2xl">
            <div className="min-w-0 flex-1">
              {/* Wraps to as many lines as it needs. The previous version
                  truncated, which lost the half of the sentence that mattered. */}
              <p className="text-base leading-relaxed text-slate-900 break-words">
                {schedule.message.body}
              </p>
              <p className="mt-1 text-sm text-slate-500">— {schedule.message.sentByName}</p>
            </div>
            <button type="button"
              onClick={async () => {
                await fetch(`${apiUrl}/api/judge-portal/${token}/dismiss-message?event=${eventId}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ messageId: schedule.message.id }),
                });
                fetchData();
              }}
              className="shrink-0 rounded-xl bg-slate-900 px-5 py-2.5 text-base font-medium text-white hover:bg-slate-800"
            >Got it</button>
          </div>
        </div>
      )}

      {infoSessionId && (() => {
        const s = sessions.find((x: any) => x.sessionId === infoSessionId);
        if (!s) return null;
        return (
          <UseCasePanel
            data={{
              teamName: s.team.name,
              projectName: s.team.projectName,
              useCaseTitle: s.team.useCaseTitle,
              problemStatement: s.team.problemStatement,
              solutionSummary: s.team.solutionSummary,
              techStack: s.team.techStack,
              country: s.team.country,
              track: s.team.track,
              organisation: s.team.organisation,
              room: s.room,
              startTime: s.startTime,
            }}
            onClose={() => setInfoSessionId(null)}
          />
        );
      })()}

      <div
        style={schedule?.message ? { paddingBottom: 132 } : undefined}
        className={`w-full max-w-5xl mx-auto px-4 py-5 sm:px-6 sm:py-8 ${
        activeScorecard ? '' : 'flex-1 flex flex-col'
      }`}>
        {/* Scoring form overlay */}
        {activeScorecard && (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-[#f4f6fa] p-4 sm:static sm:z-auto sm:overflow-visible sm:mb-6 sm:rounded-xl sm:border sm:border-slate-300 sm:bg-white sm:p-6">
            <div className="flex items-start justify-between mb-4 gap-3">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Score: {activeScorecard.teamName}</h2>
                <p className="text-base text-slate-700">{activeScorecard.projectName}</p>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-3xl font-bold text-slate-900">{totalScore}</p>
                  <p className="text-sm text-slate-500">of 100</p>
                </div>
                <button type="button"
                  onClick={async () => {
                    const next = !activeScorecard.flaggedForReview;
                    setActiveScorecard({ ...activeScorecard, flaggedForReview: next });
                    await fetch(`${apiUrl}/api/judge-portal/${token}/flag?event=${eventId}`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ scorecardId: activeScorecard.id, flagged: next }),
                    });
                    fetchData();
                  }}
                  title={activeScorecard.flaggedForReview ? 'Remove from Revisit' : 'Mark for a second look'}
                  className={`mr-3 rounded-lg border px-3.5 py-2 text-base font-medium ${
                    activeScorecard.flaggedForReview
                      ? 'border-teal-400 bg-teal-50 text-teal-800'
                      : 'border-slate-300 bg-white text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {activeScorecard.flaggedForReview ? 'Flagged' : 'Flag for review'}
                </button>
                <button type="button" onClick={() => leaveScorecard()} className="text-slate-500 hover:text-slate-900 text-2xl">✕</button>
              </div>
            </div>

            {message && (
              <div className={`mb-4 px-4 py-2 rounded-lg text-base ${MESSAGE_TONE[toneOf(message)]}`}>
                {message}
              </div>
            )}

            <div className="space-y-4">
              {(() => {
                // Categories group the questions; they are not questions
                // themselves. Filtering them here means a scorecard created
                // before the rubric became two-level cannot show one as
                // scoreable.
                const rows = (activeScorecard.criterionScores || [])
                  .filter((cs: any) => !!cs.parentId)
                  .sort((a: any, b: any) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

                // Running subtotal per category, so a judge can see how much
                // of each section is used without adding it up themselves.
                const subtotals: Record<string, number> = {};
                for (const cs of rows) {
                  if (!cs.parentId) continue;
                  subtotals[cs.parentId] =
                    (subtotals[cs.parentId] || 0) + (scores[cs.criterionId]?.score || 0);
                }

                let lastCategory: string | null = null;

                return rows.map((cs: any) => {
                const showHeader = !!cs.parentId && cs.parentId !== lastCategory;
                if (cs.parentId) lastCategory = cs.parentId;
                const catUsed = cs.parentId ? subtotals[cs.parentId] || 0 : 0;
                const catDone = cs.categoryMaxScore ? catUsed === cs.categoryMaxScore : false;

                const s = scores[cs.criterionId] || { score: null, comment: '' };
                const isLocked = ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(activeScorecard.status);
                // Only marked once the judge has engaged — see `engaged`.
                const scoreMissing = engaged && (s.score === null || s.score === undefined);
                const commentMissing =
                  engaged && cs.requiresComment && !(s.comment || '').trim();

                return (
                  <div key={cs.criterionId}>
                  {showHeader && (
                    <div className="flex items-center justify-between rounded-xl bg-slate-800 px-5 py-3 mt-6 mb-3">
                      <span className="text-base font-semibold uppercase tracking-wider text-white">
                        {cs.categoryName}
                      </span>
                      <span className={`rounded-lg px-3 py-1 text-base font-semibold tabular-nums ${
                        catDone ? 'bg-emerald-400 text-emerald-950' : 'bg-white/15 text-white'
                      }`}>
                        {catUsed} / {cs.categoryMaxScore}
                      </span>
                    </div>
                  )}
                  <div className="rounded-xl border border-slate-200 bg-[#f4f6fa] p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <span className="text-base font-semibold text-slate-900">{cs.criterionName}</span>
                        {cs.requiresComment && <span className="ml-2 text-sm px-1.5 py-0.5 rounded bg-yellow-500/10 text-amber-700 border border-yellow-500/20">Comment required</span>}
                      </div>
                      <span className="text-sm text-slate-600">Max: {cs.maxScore}</span>
                    </div>
                    {cs.guidanceText && cs.guidanceText.trim() && (
                      <div className="text-sm text-slate-600 mb-3">
                        {cs.guidanceText
                          .split(/[;\n]+/)
                          .map((line) => line.trim())
                          .filter(Boolean)
                          .map((line, i) => (
                            <div key={i}>{line}</div>
                          ))}
                      </div>
                    )}

                    <div className="flex items-center gap-4 mb-2">
                      <input type="range" min="0" max={cs.maxScore} step="1" value={s.score ?? 0} disabled={isLocked}
                      style={{ height: 28 }}
                        onChange={(e) => { setDirty(true); setEngaged(true); setScores(prev => ({ ...prev, [cs.criterionId]: { ...prev[cs.criterionId], score: parseInt(e.target.value) } })); }}
                        className="flex-1 h-2 bg-slate-100 rounded-full appearance-none cursor-pointer accent-[#7c3aed] disabled:opacity-50" />
                      <input type="number" min="0" max={cs.maxScore} value={s.score ?? ''} disabled={isLocked}
                        onChange={(e) => { setDirty(true); setEngaged(true); setScores(prev => ({ ...prev, [cs.criterionId]: { ...prev[cs.criterionId], score: e.target.value === '' ? null : Math.max(0, Math.min(parseInt(e.target.value) || 0, cs.maxScore)) } })); }}
                        className={`w-16 bg-[#f4f6fa] border rounded-lg px-3 py-1.5 text-center text-base font-mono text-slate-900 outline-none disabled:opacity-50 ${
                          scoreMissing ? 'border-2 border-red-500 bg-red-50' : 'border-slate-300'
                        }`} />
                      <span className="text-sm text-slate-500">/ {cs.maxScore}</span>
                    </div>

                    {scoreMissing && (
                      <p className="mb-2 text-sm text-red-700">Not yet scored.</p>
                    )}

                    {/* Score bar */}
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mb-3">
                      <div className={`h-full rounded-full transition-all ${(s.score || 0) / cs.maxScore > 0.7 ? 'bg-green-500' : (s.score || 0) / cs.maxScore > 0.4 ? 'bg-slate-900' : 'bg-yellow-500'}`}
                        style={{ width: `${((s.score || 0) / cs.maxScore) * 100}%` }} />
                    </div>

                    {/* Anchors */}
                    {cs.scoringAnchors && (
                      <div className="flex gap-2 mb-3 flex-wrap">
                        {(typeof cs.scoringAnchors === 'string' ? JSON.parse(cs.scoringAnchors) : cs.scoringAnchors)?.map((anchor: any, ai: number) => {
                          const isActive = s.score !== null && s.score >= anchor.min && s.score <= anchor.max;
                          return (
                            <span key={ai} className={`text-sm px-2 py-1 rounded-md border ${isActive ? 'border-slate-900/20 bg-slate-900/5 text-slate-700' : 'border-slate-300 bg-slate-50 text-slate-500'}`}>
                              {anchor.min}-{anchor.max}: {anchor.label}
                            </span>
                          );
                        })}
                      </div>
                    )}

                    <textarea value={s.comment || ''} disabled={isLocked}
                      onChange={(e) => { setDirty(true); setScores(prev => ({ ...prev, [cs.criterionId]: { ...prev[cs.criterionId], comment: e.target.value } })); }}
                      placeholder={cs.requiresComment ? 'Why this score? Required.' : 'Optional comment...'}
                      rows={2}
                      className={`w-full bg-slate-50 rounded-lg px-4 py-3 text-base text-slate-900 placeholder-slate-500 outline-none resize-none disabled:opacity-50 border-2 focus:bg-white ${
                        commentMissing ? 'border-red-500 bg-red-50' : 'border-slate-200 focus:border-slate-400'
                      } focus:border-slate-900`} />
                    {commentMissing && (
                      <p className="mt-1.5 text-sm text-red-700">
                        A comment is required before this scorecard can be submitted.
                      </p>
                    )}
                  </div>
                  </div>
                );
                });
              })()}

              {/* Overall assessment */}
              <div className="rounded-xl border border-slate-200 bg-[#f4f6fa] p-4 space-y-3">
                <h3 className="text-base font-semibold text-slate-900">Overall assessment</h3>
                <textarea value={strengths} onChange={(e) => { setDirty(true); setStrengths(e.target.value); }} placeholder="Strengths..." rows={2}
                  disabled={['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(activeScorecard.status)}
                  className="w-full bg-slate-50 border-2 border-slate-200 rounded-lg px-4 py-3 text-base text-slate-900 placeholder-slate-500 outline-none resize-none disabled:opacity-50 focus:bg-white focus:border-slate-400" />
                <textarea value={improvements} onChange={(e) => { setDirty(true); setImprovements(e.target.value); }} placeholder="Areas for improvement..." rows={2}
                  disabled={['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(activeScorecard.status)}
                  className="w-full bg-slate-50 border-2 border-slate-200 rounded-lg px-4 py-3 text-base text-slate-900 placeholder-slate-500 outline-none resize-none disabled:opacity-50 focus:bg-white focus:border-slate-400" />
              </div>
            </div>

            {/* What is still outstanding, before the judge presses anything. */}
            {!['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(activeScorecard.status) &&
              engaged && !canSubmit && (
                <div
                  id="submit-outstanding"
                  className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
                >
                  <span className="font-semibold">Not ready to submit. </span>
                  {outstandingText}
                </div>
              )}

            {/* Action buttons */}
            <div className="flex flex-col gap-4 mt-4 pt-4 border-t border-slate-200 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="h-2 flex-1 sm:w-48 sm:flex-none bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-slate-900 rounded-full transition-all" style={{ width: `${totalScore}%` }} />
                </div>
                <span className="text-base font-bold text-slate-900">{totalScore}/100</span>
              </div>
              {!['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(activeScorecard.status) ? (
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  <button type="button" onClick={() => saveOrSubmit(false)} disabled={saving}
                    className="w-full sm:w-auto px-5 py-3.5 sm:py-2 bg-slate-100 hover:bg-slate-200 text-slate-900 text-base rounded-lg disabled:opacity-50">
                    {saving ? 'Saving...' : 'Save draft'}
                  </button>
                  {/*
                    Disabled only once the judge has engaged and the page is
                    showing them what is missing. Disabling it on arrival would
                    leave a judge with a dead button and nothing to read; this
                    way the first press turns on the highlighting, and from then
                    on the button is locked and the reason is on screen.
                  */}
                  <button type="button" onClick={() => saveOrSubmit(true)}
                    disabled={saving || (engaged && !canSubmit)}
                    aria-describedby={canSubmit ? undefined : 'submit-outstanding'}
                    title={canSubmit ? undefined : outstandingText}
                    className={`w-full sm:w-auto px-5 py-3.5 sm:py-2 text-base font-medium rounded-lg disabled:cursor-not-allowed ${
                      canSubmit
                        ? 'bg-slate-900 hover:bg-slate-800 text-white'
                        : 'bg-slate-200 text-slate-500'
                    }`}>
                    {saving
                      ? 'Submitting...'
                      : canSubmit
                        ? 'Submit scorecard'
                        : `Submit scorecard (${
                            outstanding.missingScores.length + outstanding.missingComments.length
                          } left)`}
                  </button>
                </div>
              ) : (
                <span className="text-base text-emerald-700">✓ Submitted {activeScorecard.submittedAt ? new Date(activeScorecard.submittedAt).toLocaleString() : ''}</span>
              )}
            </div>
          </div>
        )}

        {/* Schedule cards */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1" />
          <DriftMetronome scorecards={scorecards} sessions={sessions} />
        </div>
        {sessions.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white py-16 text-center">
            <p className="text-slate-500">No sessions assigned yet. This page auto-refreshes.</p>
          </div>
        ) : (
          <QuadrantView
            sessions={sessions}
            onInfo={(sessionId: string) => setInfoSessionId(sessionId)}
            onBreak={['L2', 'L3', 'L4'].includes(schedule?.judge?.judgeTier) ? async (sessionId: string, on: boolean) => {
              if (on && !confirm(
                'Step out of this session?\n\n' +
                'Anything you have entered will be discarded, and this team will ' +
                'be scored by the other two judges.'
              )) return;
              const res = await fetch(`${apiUrl}/api/judge-portal/${token}/break?event=${eventId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, onBreak: on }),
              });
              if (!res.ok) {
                // Refusals here are meaningful — the other IG judge has already
                // stepped out, or this scorecard is already submitted. Showing
                // nothing would leave the judge believing they had stepped out.
                const err = await res.json().catch(() => ({}));
                setMessage(err.message || 'Could not update your break status.');
                return;
              }
              fetchData();
            } : undefined}

            scorecards={scorecards}
            onScore={(sessionId: string) => {
              const sc = scorecards.find((c: any) => c.sessionId === sessionId);
              if (sc) leaveScorecard(() => openScorecard(sc));
            }}
            onOpen={(sessionId: string) => {
              const sc = scorecards.find((c: any) => c.sessionId === sessionId);
              if (sc) leaveScorecard(() => openScorecard(sc));
            }}
          />
        )}
      </div>
    </main>
  );
}
