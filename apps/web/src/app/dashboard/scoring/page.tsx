'use client';
import { useState } from 'react';
import { useQuery } from '@/lib/use-graphql';
import { useAuthStore } from '@/lib/auth-store';
import { createClient } from '@/lib/graphql-client';
import { EVENTS_QUERY, SCORECARDS_BY_EVENT_QUERY, SCORING_TEMPLATES_QUERY, SESSIONS_QUERY } from '@/lib/queries';
import { useEventId } from '@/lib/event-store';

const REOPEN_MUTATION = `mutation R($id: String!, $reason: String!) { reopenScorecard(scorecardId: $id, reason: $reason) { id status } }`;

export default function ScoringPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const selectedEventId = useEventId();
  const event =
    evData?.events?.find((e: any) => e.id === selectedEventId) ?? evData?.events?.[0];
  const eventId = event?.id;
  const token = useAuthStore((s) => s.token);

  const { data: scData } = useQuery<any>(SCORECARDS_BY_EVENT_QUERY, eventId ? { eventId } : undefined);
  const { data: tmplData } = useQuery<any>(SCORING_TEMPLATES_QUERY, eventId ? { eventId } : undefined);
  /**
   * Sessions, for the break state alone.
   *
   * A break does not delete the scorecard, so counting scorecards counts a
   * judge who has excused themselves as still owing a score — every team with
   * someone stepped out sat at "2 of 3 submitted" indefinitely, reading
   * exactly like a judge who was late.
   */
  const { data: sessData } = useQuery<any>(SESSIONS_QUERY, eventId ? { eventId } : undefined);

  const scorecards = scData?.scorecardsByEvent || [];

  // Judges who stepped out, keyed by team, so a scorecard can be recognised as
  // one nobody is waiting on.
  const steppedOutByTeam = new Map<string, Set<string>>();
  for (const sess of sessData?.sessions || []) {
    const out = new Set<string>(
      (sess.judges || [])
        .filter((j: any) => j.onBreak)
        .map((j: any) => j.judgeName),
    );
    if (out.size) steppedOutByTeam.set(sess.teamId, out);
  }
  const isSteppedOut = (sc: any) =>
    steppedOutByTeam.get(sc.teamId)?.has(sc.judgeName) ?? false;
  const template = tmplData?.scoringTemplates?.[0];
  const criteria = template?.criteria || [];

  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const show = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };

  // Group scorecards by team
  const teamMap = new Map<string, { teamId: string; teamName: string; projectName: string; trackName: string; scorecards: any[] }>();
  for (const sc of scorecards) {
    const key = sc.teamId || sc.team?.id;
    if (!teamMap.has(key)) {
      teamMap.set(key, {
        teamId: key,
        teamName: sc.teamName || sc.team?.name || 'Unknown',
        projectName: sc.projectName || sc.team?.projectName || '',
        trackName: sc.trackName || '',
        scorecards: [],
      });
    }
    teamMap.get(key)!.scorecards.push(sc);
  }
  const teams = Array.from(teamMap.values()).sort((a, b) => a.teamName.localeCompare(b.teamName));

  // Stats
  const expectedScorecards = scorecards.filter((s: any) => !isSteppedOut(s));
  const totalScorecards = expectedScorecards.length;
  const submitted = expectedScorecards.filter((s: any) => ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(s.status)).length;
  const drafts = expectedScorecards.filter((s: any) => s.status === 'DRAFT').length;
  const notStarted = expectedScorecards.filter((s: any) => s.status === 'NOT_STARTED').length;
  const steppedOutCount = scorecards.length - totalScorecards;

  // Selected team detail
  const selTeam = selectedTeam ? teamMap.get(selectedTeam) : null;

  const getStatusColor = (status: string) => {
    const m: Record<string, { bg: string; text: string }> = {
      SUBMITTED: { bg: 'rgba(16,185,129,0.12)', text: '#10b981' },
      RESUBMITTED: { bg: 'rgba(16,185,129,0.12)', text: '#10b981' },
      LOCKED: { bg: 'rgba(107,122,144,0.12)', text: '#6b7a90' },
      DRAFT: { bg: 'rgba(245,158,11,0.12)', text: '#f59e0b' },
      NOT_STARTED: { bg: 'rgba(239,68,68,0.08)', text: '#ef4444' },
      REOPENED: { bg: 'rgba(124,58,237,0.12)', text: '#a78bfa' },
    };
    return m[status] || m.NOT_STARTED;
  };

  const reopenScorecard = async (id: string) => {
    const reason = prompt('Reason for reopening:');
    if (!reason) return;
    const client = createClient(token);
    const res = await client.mutation(REOPEN_MUTATION, { id, reason }).toPromise();
    if (res.error) { show('Error: ' + res.error.message.split('] ').pop()); return; }
    show('Scorecard reopened');
    setTimeout(() => window.location.reload(), 800);
  };

  const getTeamProgress = (team: any) => {
    // A judge who stepped out is not expected to score, so they are not part
    // of the total. Counting them leaves the team short forever.
    const expected = team.scorecards.filter((s: any) => !isSteppedOut(s));
    const total = expected.length;
    const done = expected.filter((s: any) => ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(s.status)).length;
    const steppedOut = team.scorecards.length - total;
    return { total, done, steppedOut, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
  };

  const getTeamAvgScore = (team: any) => {
    const submitted = team.scorecards.filter((s: any) => ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(s.status));
    if (submitted.length === 0) return null;
    const total = submitted.reduce((sum: number, sc: any) => {
      const scScore = (sc.criterionScores || []).reduce((s: number, cs: any) => s + (cs.score || 0), 0);
      return sum + scScore;
    }, 0);
    return Math.round(total / submitted.length);
  };

  return (
    <div>
      <style>{`
        .sc-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
        .sc-hdr h1{font-size:22px;font-weight:600;color:#fff}
        .sc-sub{font-size:14px;color:#94a3b8;margin-top:2px}
        .sc-msg{position:fixed;top:16px;right:16px;z-index:50;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#34d399}
        .sc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
        .sc-stat{padding:14px 16px;border-radius:10px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.06)}
        .sc-stat-val{font-size:22px;font-weight:600;color:#fff}
        .sc-stat-lbl{font-size:12px;color:#6b7a90;margin-top:2px}
        .sc-layout{display:grid;grid-template-columns:380px 1fr;gap:16px;min-height:calc(100vh - 200px)}
        .sc-teams{border-radius:12px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);overflow:hidden}
        .sc-teams-hdr{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:13px;color:#6b7a90;font-weight:600;text-transform:uppercase;letter-spacing:0.08em}
        .sc-teams-list{overflow-y:auto;max-height:calc(100vh - 280px)}
        .sc-team{padding:12px 16px;cursor:pointer;border-bottom:0.5px solid rgba(255,255,255,0.04);transition:background 0.15s}
        .sc-team:hover{background:rgba(255,255,255,0.03)}
        .sc-team.active{background:rgba(124,58,237,0.08);border-left:3px solid #7c3aed}
        .sc-team-name{font-size:14px;font-weight:500;color:#fff}
        .sc-team-proj{font-size:12px;color:#6b7a90;margin-top:1px}
        .sc-team-bar{height:4px;border-radius:2px;background:rgba(255,255,255,0.06);margin-top:6px;overflow:hidden}
        .sc-team-fill{height:100%;border-radius:2px;transition:width 0.3s}
        .sc-detail{border-radius:12px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);overflow:hidden}
        .sc-detail-hdr{padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06)}
        .sc-detail-body{padding:16px 20px}
        .sc-judge{padding:14px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.02);margin-bottom:10px}
        .sc-judge-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
        .sc-judge-name{font-size:14px;font-weight:500;color:#fff}
        .sc-judge-score{font-size:18px;font-weight:600}
        .sc-crit{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px}
        .sc-crit-name{color:#94a3b8}
        .sc-crit-score{color:#fff;font-weight:500}
        .sc-crit-bar{height:3px;border-radius:1.5px;background:rgba(255,255,255,0.06);margin-top:2px;overflow:hidden}
        .sc-crit-fill{height:100%;border-radius:1.5px;background:#7c3aed}
        .sc-badge{display:inline-block;padding:3px 10px;border-radius:5px;font-size:11px;font-weight:500}
        .sc-actions{display:flex;gap:6px;margin-top:8px}
        .sc-btn{padding:5px 12px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid;transition:all 0.15s}
      `}</style>

      {msg && <div className="sc-msg">{msg}</div>}

      <div className="sc-hdr">
        <div>
          <h1>Scoring progress</h1>
          <p className="sc-sub">{event?.name || 'Loading...'}</p>
        </div>
      </div>

      {/* Stats */}
      <div className="sc-stats">
        <div className="sc-stat">
          <div className="sc-stat-val">{totalScorecards}</div>
          <div className="sc-stat-lbl">
            Total scorecards
            {steppedOutCount > 0 && (
              <span style={{ color: '#f59e0b' }}>
                {' '}· {steppedOutCount} excluded
              </span>
            )}
          </div>
        </div>
        <div className="sc-stat">
          <div className="sc-stat-val" style={{color:'#10b981'}}>{submitted}</div>
          <div className="sc-stat-lbl">Submitted</div>
        </div>
        <div className="sc-stat">
          <div className="sc-stat-val" style={{color:'#f59e0b'}}>{drafts}</div>
          <div className="sc-stat-lbl">Drafts</div>
        </div>
        <div className="sc-stat">
          <div className="sc-stat-val" style={{color:'#ef4444'}}>{notStarted}</div>
          <div className="sc-stat-lbl">Not started</div>
        </div>
      </div>

      <div className="sc-layout">
        {/* Left: Team list */}
        <div className="sc-teams">
          <div className="sc-teams-hdr">Teams ({teams.length})</div>
          <div className="sc-teams-list">
            {teams.map(team => {
              const prog = getTeamProgress(team);
              const avg = getTeamAvgScore(team);
              const allDone = prog.done === prog.total;
              return (
                <div key={team.teamId} className={`sc-team ${selectedTeam === team.teamId ? 'active' : ''}`}
                  onClick={() => setSelectedTeam(team.teamId)}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div>
                      <div className="sc-team-name">{team.teamName}</div>
                      <div className="sc-team-proj">{team.projectName}</div>
                    </div>
                    <div style={{textAlign:'right'}}>
                      <div style={{fontSize:13,fontWeight:500,color: allDone ? '#10b981' : '#fff'}}>{prog.done}/{prog.total}</div>
                      {avg !== null && <div style={{fontSize:11,color:'#6b7a90'}}>{avg}/100</div>}
                    </div>
                  </div>
                  <div className="sc-team-bar">
                    <div className="sc-team-fill" style={{width:`${prog.pct}%`, background: allDone ? '#10b981' : prog.pct > 0 ? '#f59e0b' : '#ef4444'}} />
                  </div>
                </div>
              );
            })}
            {teams.length === 0 && <div style={{padding:20,textAlign:'center',color:'#6b7a90',fontSize:13}}>No scorecards yet. Start judging sessions first.</div>}
          </div>
        </div>

        {/* Right: Team detail */}
        <div className="sc-detail">
          {selTeam ? (
            <>
              <div className="sc-detail-hdr">
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <div>
                    <div style={{fontSize:18,fontWeight:500,color:'#fff'}}>{selTeam.teamName}</div>
                    <div style={{fontSize:13,color:'#94a3b8'}}>{selTeam.projectName}</div>
                    {selTeam.trackName && <span className="sc-badge" style={{background:'rgba(124,58,237,0.1)',color:'#a78bfa',marginTop:4}}>{selTeam.trackName}</span>}
                  </div>
                  <div style={{textAlign:'right'}}>
                    {(() => { const avg = getTeamAvgScore(selTeam); const prog = getTeamProgress(selTeam); return (
                      <>
                        {avg !== null && <div style={{fontSize:24,fontWeight:600,color:'#fff'}}>{avg}<span style={{fontSize:14,color:'#6b7a90'}}>/100</span></div>}
                        <div style={{fontSize:12,color:'#6b7a90'}}>
                          {prog.done} of {prog.total} judges submitted
                          {prog.steppedOut > 0 && (
                            <span style={{color:'#f59e0b'}}>
                              {' '}· {prog.steppedOut} stepped out
                            </span>
                          )}
                        </div>
                      </>
                    ); })()}
                  </div>
                </div>
              </div>
              <div className="sc-detail-body">
                {selTeam.scorecards.map((sc: any) => {
                  const scStatus = getStatusColor(sc.status);
                  const isSubmitted = ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(sc.status);
                  const scTotal = (sc.criterionScores || []).reduce((s: number, cs: any) => s + (cs.score || 0), 0);
                  return (
                    <div className="sc-judge" key={sc.id}>
                      <div className="sc-judge-hdr">
                        <div>
                          <span className="sc-judge-name">{sc.judgeName || sc.judge?.name || 'Judge'}</span>
                          <span style={{fontSize:12,color:'#6b7a90',marginLeft:8}}>{sc.judgeType || ''}</span>
                        </div>
                        <div style={{display:'flex',alignItems:'center',gap:10}}>
                          {isSubmitted && <span className="sc-judge-score" style={{color:'#10b981'}}>{scTotal}</span>}
                          <span className="sc-badge" style={{background: scStatus.bg, color: scStatus.text}}>{sc.status}</span>
                        </div>
                      </div>

                      {/* Show criteria scores if submitted */}
                      {isSubmitted && (sc.criterionScores || []).length > 0 && (
                        <div style={{marginTop:4}}>
                          {(sc.criterionScores || []).map((cs: any) => {
                            const maxScore = criteria.find((c: any) => c.id === cs.criterionId)?.maxScore || cs.maxScore || 20;
                            return (
                              <div key={cs.criterionId} style={{marginBottom:4}}>
                                <div className="sc-crit">
                                  <span className="sc-crit-name">{cs.criterionName || cs.criterion?.name || 'Criterion'}</span>
                                  <span className="sc-crit-score">{cs.score}<span style={{color:'#6b7a90',fontWeight:400}}>/{maxScore}</span></span>
                                </div>
                                <div className="sc-crit-bar">
                                  <div className="sc-crit-fill" style={{width:`${maxScore > 0 ? (cs.score / maxScore) * 100 : 0}%`}} />
                                </div>
                                {cs.comment && <div style={{fontSize:12,color:'#6b7a90',marginTop:2,fontStyle:'italic'}}>{cs.comment}</div>}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="sc-actions">
                        {isSubmitted && sc.status !== 'LOCKED' && (
                          <button type="button" className="sc-btn" style={{background:'rgba(245,158,11,0.08)',borderColor:'rgba(245,158,11,0.2)',color:'#f59e0b'}}
                            onClick={() => reopenScorecard(sc.id)}>Reopen</button>
                        )}
                        {sc.status === 'NOT_STARTED' && (
                          <button type="button" className="sc-btn" style={{background:'rgba(124,58,237,0.08)',borderColor:'rgba(124,58,237,0.2)',color:'#a78bfa'}}
                            onClick={() => show('Reminder sent (notification system pending)')}>Send reminder</button>
                        )}
                        {sc.status === 'DRAFT' && (
                          <button type="button" className="sc-btn" style={{background:'rgba(245,158,11,0.08)',borderColor:'rgba(245,158,11,0.2)',color:'#f59e0b'}}
                            onClick={() => show('Reminder sent (notification system pending)')}>Nudge to submit</button>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Team score summary if all submitted */}
                {(() => {
                  const prog = getTeamProgress(selTeam);
                  if (prog.done < prog.total || prog.total === 0) return null;
                  const avg = getTeamAvgScore(selTeam);
                  return (
                    <div style={{marginTop:16,padding:16,borderRadius:10,background:'rgba(16,185,129,0.06)',border:'1px solid rgba(16,185,129,0.15)'}}>
                      <div style={{fontSize:13,color:'#10b981',fontWeight:500,marginBottom:4}}>All judges submitted</div>
                      <div style={{fontSize:13,color:'#94a3b8'}}>
                        Average score: <span style={{color:'#fff',fontWeight:500}}>{avg}/100</span> from {prog.total} judges
                      </div>
                    </div>
                  );
                })()}
              </div>
            </>
          ) : (
            <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100%',color:'#6b7a90',fontSize:14}}>
              Select a team to view scoring details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
