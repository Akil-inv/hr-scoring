'use client';

import { Fragment } from 'react';
import { BRAND } from '@/lib/brand';
import { CandidateRecord, ReviewData, decisionMeta, finalDecision } from '@/lib/review';

/**
 * A candidate assessment report: one A4 page (or more) that can be kept on
 * file for the person interviewed. Everything is as entered: every judge's
 * scores and comments, the consolidated score, and the HR admin's final
 * decision and comment. Printed from the browser to PDF.
 */

const DECISION_COLOUR: Record<string, string> = {
  SELECTED: '#0f7b4f',
  WAITLIST: '#a86206',
  NOT_SELECTED: '#5b6270',
};

function longDate(iso: string) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${iso}T00:00:00Z`));
}

function stamp(d: string | null, tz: string) {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d));
}

export function reportRef(r: CandidateRecord) {
  return `TD-${r.date.replace(/-/g, '').slice(2)}-${r.sessionId.slice(0, 6).toUpperCase()}`;
}

export const REPORT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=Inter:wght@400;500;600&display=swap');
@page { size: A4; margin: 14mm 14mm 16mm; }
html, body { background: #e9ebef !important; }
.rp-toolbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 12px; align-items: center; justify-content: center; padding: 12px; background: #1f2430; color: #e8edf5; font: 500 13px Inter, sans-serif; }
.rp-toolbar button { background: #7c3aed; color: #fff; border: 0; border-radius: 8px; padding: 8px 16px; font: 600 13px Inter, sans-serif; cursor: pointer; }
.rp-sheet { width: 210mm; min-height: 297mm; margin: 16px auto; background: #fff; color: #1d2230; padding: 14mm; box-shadow: 0 2px 14px rgba(0,0,0,.12); font: 400 10.5pt/1.55 Inter, -apple-system, sans-serif; }
.rp-sheet + .rp-sheet { margin-top: 24px; }
.rp-mono { font-family: 'IBM Plex Mono', ui-monospace, monospace; }
.rp-label { font: 500 7.5pt 'IBM Plex Mono', ui-monospace, monospace; letter-spacing: .18em; text-transform: uppercase; color: #6b7280; }
.rp-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #1d2230; padding-bottom: 10px; }
.rp-brand { font: 600 15pt 'Source Serif 4', Georgia, serif; }
.rp-ref { text-align: right; font: 400 8pt 'IBM Plex Mono', ui-monospace, monospace; color: #374151; }
.rp-ref .rp-tag { color: #0f7b4f; letter-spacing: .06em; }
.rp-hero { display: flex; justify-content: space-between; gap: 18px; padding: 18px 0 14px; border-bottom: 1px solid #d6d9df; }
.rp-name { font: 400 26pt/1.1 'Source Serif 4', Georgia, serif; margin: 0; }
.rp-sub { margin-top: 6px; color: #374151; }
.rp-meta { margin-top: 4px; font: 400 8.5pt 'IBM Plex Mono', ui-monospace, monospace; color: #6b7280; }
.rp-outcome { min-width: 150px; text-align: right; }
.rp-outcome .rp-decision { font: 400 18pt 'Source Serif 4', Georgia, serif; margin-top: 2px; }
.rp-outcome .rp-score { font: 400 9pt 'IBM Plex Mono', ui-monospace, monospace; color: #374151; }
.rp-badge { display: inline-block; margin-top: 6px; padding: 2px 8px; border: 1px solid currentColor; font: 500 7.5pt 'IBM Plex Mono', ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; }
.rp-section { padding-top: 16px; }
.rp-section > .rp-label { display: block; margin-bottom: 8px; }
.rp-rows { width: 100%; border-collapse: collapse; }
.rp-rows td { padding: 6px 0; border-bottom: 1px solid #eceef2; vertical-align: top; }
.rp-rows td.rp-num { text-align: right; white-space: nowrap; font-family: 'IBM Plex Mono', ui-monospace, monospace; width: 90px; }
.rp-bar { height: 4px; background: #eceef2; margin-top: 4px; }
.rp-bar > span { display: block; height: 4px; background: #1d2230; }
.rp-quote { white-space: pre-wrap; }
.rp-judge { border-top: 1px solid #d6d9df; padding-top: 8px; margin-top: 8px; }
.rp-judge h3, .rp-kv { break-inside: avoid; break-after: avoid; }
.rp-matrix { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
.rp-matrix th { text-align: left; font: 500 7.5pt 'IBM Plex Mono', ui-monospace, monospace; color: #6b7280; border-bottom: 1px solid #1d2230; padding: 4px 0 4px 6px; }
.rp-matrix th:first-child { padding-left: 0; }
.rp-matrix td { padding: 3px 0 3px 6px; border-bottom: 1px solid #f0f1f4; vertical-align: top; }
.rp-matrix td:first-child { padding-left: 0; }
.rp-matrix tr { break-inside: avoid; }
.rp-matrix .rp-num { text-align: right; white-space: nowrap; font-family: 'IBM Plex Mono', ui-monospace, monospace; width: 62px; }
.rp-matrix .rp-cat td { padding-top: 7px; font-weight: 600; color: #374151; border-bottom: 1px solid #d6d9df; }
.rp-matrix .rp-total td { border-top: 1px solid #1d2230; font-weight: 600; }
.rp-dim { color: #6b7280; }
.rp-notes { margin: 2px 0 0; padding-left: 16px; font-size: 9pt; }
.rp-notes li { margin: 2px 0; break-inside: avoid; }
.rp-judge h3 { display: flex; justify-content: space-between; margin: 0 0 4px; font: 600 11pt 'Source Serif 4', Georgia, serif; }
.rp-judge h3 span { font: 400 9pt 'IBM Plex Mono', ui-monospace, monospace; }
.rp-kv { display: grid; grid-template-columns: 150px 1fr; gap: 2px 12px; margin: 4px 0 6px; }
.rp-kv dt { color: #6b7280; font-size: 9pt; }
.rp-kv dd { margin: 0; }
.rp-crit { width: 100%; border-collapse: collapse; font-size: 9pt; }
.rp-crit td { padding: 3px 0; border-bottom: 1px solid #f0f1f4; vertical-align: top; }
.rp-crit .rp-cat td { padding-top: 7px; font-weight: 600; color: #374151; border-bottom: 0; }
.rp-crit .rp-num { text-align: right; white-space: nowrap; font-family: 'IBM Plex Mono', ui-monospace, monospace; width: 60px; }
.rp-crit .rp-c { display: block; color: #4b5563; font-style: italic; }
.rp-note { font-size: 8.5pt; color: #4b5563; }
.rp-foot { margin-top: 18px; padding-top: 8px; border-top: 1px solid #1d2230; text-align: center; font: 400 7.5pt 'IBM Plex Mono', ui-monospace, monospace; letter-spacing: .12em; text-transform: uppercase; color: #6b7280; }
@media print {
  html, body { background: #fff !important; }
  .rp-toolbar { display: none; }
  .rp-sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
  .rp-sheet + .rp-sheet { margin-top: 0; break-before: page; }
}
`;

export function CandidateReport({ data, r }: { data: ReviewData; r: CandidateRecord }) {
  const decided = finalDecision(r);
  const meta = decisionMeta(decided);
  const colour = decided ? DECISION_COLOUR[decided] : '#6d28d9';
  const parents = new Set(data.criteria.map((c) => c.parentId).filter(Boolean));
  const categories = data.criteria.filter((c) => !c.parentId && parents.has(c.id));
  const rowsOf = (id: string) => data.criteria.filter((c) => c.parentId === id);
  const scored = r.judges.filter((j) => j.submitted);
  const excused = r.judges.filter((j) => j.excused);
  const panel = r.judges.filter((j) => !j.excused).map((j) => j.name).join(', ');

  return (
    <article className="rp-sheet">
      <header className="rp-head">
        <div>
          <div className="rp-brand">{BRAND.name}</div>
          <div className="rp-label">Candidate assessment report</div>
        </div>
        <div className="rp-ref">
          <div>Ref {reportRef(r)}</div>
          <div className="rp-tag">{data.event.name.toUpperCase()}</div>
        </div>
      </header>

      <section className="rp-hero">
        <div>
          <h1 className="rp-name">{r.name}</h1>
          <div className="rp-sub">Interviewed {longDate(r.date)}, {r.start}–{r.end}</div>
          <div className="rp-meta">Panel · {panel || 'none'}</div>
        </div>
        <div className="rp-outcome">
          <div className="rp-label">HR decision</div>
          <div className="rp-decision" style={{ color: colour }}>{meta?.label ?? 'Pending'}</div>
          <div className="rp-score">consolidated {r.average ?? '—'} / {data.maxTotal}</div>
          <div className="rp-badge" style={{ color: colour }}>{decided ? 'Final' : r.state === 'READY' ? 'Awaiting HR decision' : `Scores ${r.submitted}/${r.expected}`}</div>
        </div>
      </section>

      <section className="rp-section">
        <span className="rp-label">Consolidated score</span>
        <table className="rp-rows">
          <tbody>
            {r.categoryAverages.map((c) => (
              <tr key={c.id}>
                <td>{c.name}<div className="rp-bar"><span style={{ width: `${c.average === null ? 0 : (c.average / c.maxScore) * 100}%` }} /></div></td>
                <td className="rp-num">{c.average ?? '—'} / {c.maxScore}</td>
              </tr>
            ))}
            <tr>
              <td><strong>Total</strong> <span className="rp-note">average of {scored.length} judge{scored.length === 1 ? '' : 's'}</span></td>
              <td className="rp-num"><strong>{r.average ?? '—'} / {data.maxTotal}</strong></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="rp-section">
        <span className="rp-label">HR assessment</span>
        {r.decision?.feedback
          ? <p className="rp-quote" style={{ margin: 0 }}>{r.decision.feedback}</p>
          : <p className="rp-note" style={{ margin: 0 }}>No HR comment recorded yet.</p>}
        {decided && (
          <p className="rp-meta">Decided by {r.decision?.decidedBy ?? 'unknown'} · {stamp(r.decision?.decidedAt ?? null, data.event.timezone)}</p>
        )}
      </section>

      <section className="rp-section">
        <span className="rp-label">Scores by criterion</span>
        <table className="rp-matrix">
          <thead>
            <tr>
              <th>Criterion</th>
              {r.judges.map((j) => <th key={j.judgeId} className="rp-num">{j.name}{j.excused ? '*' : ''}</th>)}
              <th className="rp-num">Average</th>
              <th className="rp-num">Max</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <Fragment key={cat.id}>
                <tr className="rp-cat"><td colSpan={r.judges.length + 3}>{cat.name}</td></tr>
                {rowsOf(cat.id).map((row) => {
                  const vals = scored.map((j) => j.scores[row.id]?.score).filter((v): v is number => typeof v === 'number');
                  const avg = vals.length ? Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 10) / 10 : null;
                  return (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      {r.judges.map((j) => <td key={j.judgeId} className="rp-num">{j.scores[row.id]?.score ?? '—'}</td>)}
                      <td className="rp-num"><strong>{avg ?? '—'}</strong></td>
                      <td className="rp-num rp-dim">{row.maxScore}</td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
            <tr className="rp-total">
              <td>Total</td>
              {r.judges.map((j) => <td key={j.judgeId} className="rp-num">{j.submitted ? j.total : '—'}</td>)}
              <td className="rp-num"><strong>{r.average ?? '—'}</strong></td>
              <td className="rp-num rp-dim">{data.maxTotal}</td>
            </tr>
          </tbody>
        </table>
        {excused.length > 0 && <p className="rp-note">* stepped out of this interview</p>}
      </section>

      <section className="rp-section">
        <span className="rp-label">Panel comments · {r.judges.length}</span>
        {r.judges.map((j) => {
          const notes = data.criteria.filter((c) => j.scores[c.id]?.comment);
          return (
            <div key={j.judgeId} className="rp-judge">
              <h3>{j.name}{j.excused ? ' (stepped out)' : ''}<span>{j.submitted ? `${j.total} / ${data.maxTotal}` : 'not submitted'}{j.submittedAt ? ` · ${stamp(j.submittedAt, data.event.timezone)}` : ''}</span></h3>
              <dl className="rp-kv">
                <dt>Strengths</dt><dd className="rp-quote">{j.strengths || '—'}</dd>
                <dt>Areas for improvement</dt><dd className="rp-quote">{j.areasForImprovement || '—'}</dd>
                <dt>Recommendation</dt><dd className="rp-quote">{j.recommendation || '—'}</dd>
              </dl>
              {notes.length > 0 && (
                <ul className="rp-notes">
                  {notes.map((c) => <li key={c.id}><span className="rp-dim">{c.name}</span> — “{j.scores[c.id]!.comment}”</li>)}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      <section className="rp-section">
        <span className="rp-label">Basis of assessment</span>
        <p className="rp-note" style={{ margin: 0 }}>
          Each judge scored the candidate independently against the rubric above; their scores and comments appear exactly as submitted.
          The consolidated score is the average of the {scored.length} submitted scorecard{scored.length === 1 ? '' : 's'}; category figures are averaged the same way.
          {excused.length > 0 && ` ${excused.map((j) => j.name).join(', ')} stepped out of this interview and ${excused.length === 1 ? 'is' : 'are'} not counted unless a scorecard was submitted.`}
          {' '}The HR decision is the reviewer&apos;s, taken with these scores and comments in view. Times are {data.event.timezone}.
        </p>
      </section>

      <footer className="rp-foot">
        {BRAND.name} · {reportRef(r)} · Confidential — for hiring decisions only · printed {stamp(new Date().toISOString(), data.event.timezone)}
      </footer>
    </article>
  );
}
