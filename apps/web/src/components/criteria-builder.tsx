'use client';

import { useMemo, useState } from 'react';

/**
 * Two-level scoring criteria builder.
 *
 * Categories carry a points budget; the rows beneath them spend it. Both are
 * set upfront rather than derived, so at every moment the editor knows what is
 * still unallocated and can cap inputs to it — you cannot type a category that
 * overshoots 100, or a row that overshoots its category.
 *
 * Imbalance is shown, not blocked. Lowering a category below its rows is a
 * legitimate mid-edit state: you lower the category, then lower the rows. The
 * step stays amber until it settles rather than refusing the first half of the
 * change.
 *
 * A criterion with no parent is a category; one with a parent is a row. That is
 * the whole model. Criteria created before this existed have no parent and
 * render as categories with no rows — accurate, if a little odd.
 */

/**
 * Split scoring guidance into display lines. Organizers may separate points
 * either with newlines or with ';' — both are treated as line breaks so a
 * banding like "<200K score <5; 200-400K score 5-8" shows one band per line.
 * Rendered as plain text by the caller, so '<' and '>' are safe.
 */
export function guidanceLines(text?: string | null): string[] {
  if (!text) return [];
  return text
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type Criterion = {
  id: string;
  name: string;
  description?: string | null;
  maxScore: number;
  displayOrder: number;
  guidanceText?: string | null;
  requiresComment: boolean;
  parentId?: string | null;
};

type Props = {
  criteria: Criterion[];
  maxTotal?: number;
  busy?: boolean;
  /** Empty state only — offers to populate from the standard rubric. */
  onLoadRubric: () => Promise<void> | void;
  onAddCategory: (name: string, maxScore: number) => Promise<void> | void;
  onAddRow: (
    parentId: string,
    name: string,
    maxScore: number,
    guidanceText: string,
    requiresComment: boolean,
  ) => Promise<void> | void;
  onUpdate: (id: string, changes: Partial<Criterion>) => Promise<void> | void;
  onRemove: (id: string, name: string) => Promise<void> | void;
  /**
   * The template's own status, which is not the same thing as the criteria
   * being complete.
   *
   * A rubric can total 100, balance perfectly, and still be a DRAFT — and
   * judges cannot score against a draft. Nothing on this page used to say so,
   * so a coordinator would finish the rubric, see a green tick, and learn from
   * a judge that scoring was refused.
   */
  status?: 'DRAFT' | 'ACTIVE' | 'LOCKED';
  /** Marks the rubric finished so judges can score against it. */
  onActivate?: () => Promise<void> | void;
};

const AMBER = '#f59e0b';
const GREEN = '#10b981';
const RED = '#f87171';
const MUTED = '#6b7a90';
const SUB = '#94a3b8';

export default function CriteriaBuilder({
  criteria,
  maxTotal = 100,
  busy = false,
  onLoadRubric,
  onAddCategory,
  onAddRow,
  onUpdate,
  onRemove,
  status,
  onActivate,
}: Props) {
  const tree = useMemo(() => {
    const categories = criteria
      .filter((c) => !c.parentId)
      .sort((a, b) => a.displayOrder - b.displayOrder);

    return categories.map((cat) => {
      const rows = criteria
        .filter((c) => c.parentId === cat.id)
        .sort((a, b) => a.displayOrder - b.displayOrder);
      const used = rows.reduce((s, r) => s + r.maxScore, 0);
      return { cat, rows, used, remaining: cat.maxScore - used };
    });
  }, [criteria]);

  const allocated = tree.reduce((s, t) => s + t.cat.maxScore, 0);
  const unallocated = maxTotal - allocated;
  const balanced = allocated === maxTotal && tree.every((t) => t.remaining === 0);

  const [newCat, setNewCat] = useState({ name: '', maxScore: 0 });
  const [openRowForm, setOpenRowForm] = useState<string | null>(null);
  const [newRow, setNewRow] = useState({ name: '', maxScore: 0, guidance: '', comment: false });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; maxScore: number }>({ name: '', maxScore: 0 });

  const startEdit = (c: Criterion) => {
    setEditing(c.id);
    setDraft({ name: c.name, maxScore: c.maxScore });
  };

  const commitEdit = async (c: Criterion) => {
    const name = draft.name.trim();
    if (name && (name !== c.name || draft.maxScore !== c.maxScore)) {
      await onUpdate(c.id, { name, maxScore: draft.maxScore });
    }
    setEditing(null);
  };

  // ── empty ──
  if (criteria.length === 0) {
    return (
      <div>
        <div
          style={{
            padding: 16,
            borderRadius: 8,
            background: 'rgba(124,58,237,0.06)',
            border: '0.5px solid rgba(124,58,237,0.2)',
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 14, color: '#fff', marginBottom: 4 }}>
            Start from the standard rubric
          </div>
          <div style={{ fontSize: 12, color: SUB, marginBottom: 10, lineHeight: 1.5 }}>
            Five categories, twelve scoring rows, totalling 100 points. Everything it creates is
            editable afterwards.
          </div>
          <button type="button" className="btn btn-pri btn-sm" disabled={busy} onClick={() => onLoadRubric()}>
            Load standard rubric
          </button>
        </div>
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>
          Or build your own — add a category, then the rows beneath it.
        </div>
        <CategoryForm
          value={newCat}
          onChange={setNewCat}
          remaining={unallocated}
          busy={busy}
          onAdd={async () => {
            if (!newCat.name.trim() || newCat.maxScore < 1) return;
            await onAddCategory(newCat.name.trim(), newCat.maxScore);
            setNewCat({ name: '', maxScore: 0 });
          }}
        />
      </div>
    );
  }

  return (
    <div>
      {tree.map(({ cat, rows, used, remaining }) => {
        const catBalanced = remaining === 0 && rows.length > 0;
        const over = remaining < 0;
        const isEditing = editing === cat.id;

        return (
          <div
            key={cat.id}
            style={{
              marginBottom: 10,
              borderRadius: 8,
              border: '0.5px solid rgba(255,255,255,0.08)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                background: 'rgba(255,255,255,0.03)',
              }}
            >
              {isEditing ? (
                <>
                  <input
                    className="inp"
                    style={{ flex: 1 }}
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                  <input
                    type="number"
                    className="inp"
                    style={{ width: 70 }}
                    value={draft.maxScore}
                    onChange={(e) => setDraft({ ...draft, maxScore: Number(e.target.value) })}
                  />
                  <button type="button" className="btn btn-pri btn-sm" onClick={() => commitEdit(cat)}>
                    Save
                  </button>
                  <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: '#fff' }}>
                    {cat.name}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: over ? RED : catBalanced ? GREEN : AMBER,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {used} / {cat.maxScore}
                    {remaining > 0 && ` · ${remaining} left`}
                    {over && ` · ${-remaining} over`}
                  </span>
                  <button type="button" className="btn btn-sec btn-sm" onClick={() => startEdit(cat)}>
                    Edit
                  </button>
                  <button type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => onRemove(cat.id, cat.name)}
                  >
                    Remove
                  </button>
                </>
              )}
            </div>

            {rows.map((r) => {
              const rowEditing = editing === r.id;
              return (
                <div
                  key={r.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '9px 12px 9px 28px',
                    borderTop: '0.5px solid rgba(255,255,255,0.05)',
                  }}
                >
                  {rowEditing ? (
                    <>
                      <input
                        className="inp"
                        style={{ flex: 1 }}
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                      <input
                        type="number"
                        className="inp"
                        style={{ width: 70 }}
                        value={draft.maxScore}
                        onChange={(e) => setDraft({ ...draft, maxScore: Number(e.target.value) })}
                      />
                      <button type="button" className="btn btn-pri btn-sm" onClick={() => commitEdit(r)}>
                        Save
                      </button>
                      <button type="button" className="btn btn-sec btn-sm" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: '#e2e8f0' }}>
                          {r.name}
                          {r.requiresComment && (
                            <span
                              style={{
                                marginLeft: 8,
                                fontSize: 10,
                                color: AMBER,
                                padding: '1px 6px',
                                borderRadius: 3,
                                background: 'rgba(245,158,11,0.1)',
                              }}
                            >
                              comment required
                            </span>
                          )}
                        </div>
                        {guidanceLines(r.guidanceText).length > 0 && (
                          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                            {guidanceLines(r.guidanceText).map((line, i) => (
                              <div key={i}>{line}</div>
                            ))}
                          </div>
                        )}
                      </div>
                      <span
                        style={{
                          fontSize: 14,
                          color: '#a78bfa',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {r.maxScore}
                      </span>
                      <button type="button" className="btn btn-sec btn-sm" onClick={() => startEdit(r)}>
                        Edit
                      </button>
                      <button type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => onRemove(r.id, r.name)}
                      >
                        Remove
                      </button>
                    </>
                  )}
                </div>
              );
            })}

            {openRowForm === cat.id ? (
              <div
                style={{
                  padding: '10px 12px 12px 28px',
                  borderTop: '0.5px solid rgba(255,255,255,0.05)',
                  background: 'rgba(255,255,255,0.015)',
                }}
              >
                <input
                  className="inp"
                  placeholder="Guiding question — what the judge is answering"
                  value={newRow.name}
                  onChange={(e) => setNewRow({ ...newRow, name: e.target.value })}
                />
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
                  <input
                    type="number"
                    className="inp"
                    style={{ width: 70 }}
                    placeholder="Pts"
                    max={Math.max(remaining, 0)}
                    value={newRow.maxScore || ''}
                    onChange={(e) =>
                      setNewRow({
                        ...newRow,
                        maxScore: Math.min(Number(e.target.value), Math.max(remaining, 0)),
                      })
                    }
                  />
                  <span style={{ fontSize: 11, color: MUTED }}>
                    {remaining > 0 ? `${remaining} left in this category` : 'category is full'}
                  </span>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 12,
                      color: SUB,
                      cursor: 'pointer',
                      marginLeft: 'auto',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={newRow.comment}
                      onChange={(e) => setNewRow({ ...newRow, comment: e.target.checked })}
                    />
                    Comment req.
                  </label>
                </div>
                <textarea
                  className="inp"
                  placeholder="Scoring guidance — one point per line, or separate with ';'  e.g.  <200K score <5;  200-400K score 5-8;  >400K score >8"
                  value={newRow.guidance}
                  onChange={(e) => setNewRow({ ...newRow, guidance: e.target.value })}
                  rows={3}
                  style={{ marginTop: 6, resize: 'vertical', fontFamily: 'inherit' }}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button type="button"
                    className="btn btn-pri btn-sm"
                    disabled={busy || !newRow.name.trim() || newRow.maxScore < 1}
                    onClick={async () => {
                      await onAddRow(
                        cat.id,
                        newRow.name.trim(),
                        newRow.maxScore,
                        newRow.guidance.trim(),
                        newRow.comment,
                      );
                      setNewRow({ name: '', maxScore: 0, guidance: '', comment: false });
                    }}
                  >
                    Add row
                  </button>
                  <button type="button" className="btn btn-sec btn-sm" onClick={() => setOpenRowForm(null)}>
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ padding: '8px 12px 8px 28px', borderTop: '0.5px solid rgba(255,255,255,0.05)' }}>
                <button type="button"
                  className="btn btn-sec btn-sm"
                  onClick={() => {
                    setOpenRowForm(cat.id);
                    setNewRow({ name: '', maxScore: Math.max(remaining, 0), guidance: '', comment: false });
                  }}
                >
                  + Add row
                </button>
                {rows.length === 0 && (
                  <span style={{ fontSize: 11, color: AMBER, marginLeft: 10 }}>
                    no rows yet — judges cannot score this category
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}

      {unallocated !== 0 && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            background: unallocated < 0 ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
            border: `1px solid ${unallocated < 0 ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)'}`,
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 13, color: unallocated < 0 ? RED : AMBER }}>
            {unallocated > 0
              ? `${unallocated} of ${maxTotal} points still to allocate`
              : `Categories total ${allocated} — ${-unallocated} over ${maxTotal}`}
          </span>
        </div>
      )}

      {balanced && (
        <div style={{ fontSize: 12, color: GREEN, marginBottom: 8 }}>
          Every category balances and the total is {maxTotal}.
        </div>
      )}

      {/*
        Whether judges can actually use this rubric.
        Shown whenever a status is known, balanced or not: a coordinator who
        has not finished should still be able to see what finishing means, and
        one who has should not have to guess why nothing is happening.
      */}
      {status && onActivate && status === 'DRAFT' && (
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, flexWrap: 'wrap', padding: '10px 12px', borderRadius: 8,
            background: balanced ? 'rgba(16,185,129,0.08)' : 'rgba(148,163,184,0.10)',
            border: `1px solid ${balanced ? 'rgba(16,185,129,0.25)' : 'rgba(148,163,184,0.25)'}`,
            marginBottom: 8,
          }}
        >
          <span style={{ fontSize: 13, color: balanced ? GREEN : MUTED }}>
            {balanced
              ? 'Judges cannot score yet. Mark the rubric done to open scoring.'
              : `Judges cannot score until the rubric totals ${maxTotal} and every category balances.`}
          </span>
          <button
            type="button"
            className="btn btn-pri btn-sm"
            disabled={!balanced || busy}
            title={balanced ? undefined : 'The rubric does not balance yet'}
            onClick={() => onActivate()}
          >
            Mark rubric done
          </button>
        </div>
      )}

      {status === 'ACTIVE' && (
        <div style={{ fontSize: 12, color: GREEN, marginBottom: 8 }}>
          Rubric is live — judges can score against it. Wording can still be
          corrected; scores and structure cannot once judging has begun.
        </div>
      )}

      {status === 'LOCKED' && (
        <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
          Rubric is locked. Scores have been submitted against it.
        </div>
      )}

      {unallocated > 0 && (
        <CategoryForm
          value={newCat}
          onChange={setNewCat}
          remaining={unallocated}
          busy={busy}
          onAdd={async () => {
            if (!newCat.name.trim() || newCat.maxScore < 1) return;
            await onAddCategory(newCat.name.trim(), newCat.maxScore);
            setNewCat({ name: '', maxScore: 0 });
          }}
        />
      )}
    </div>
  );
}

function CategoryForm({
  value,
  onChange,
  remaining,
  busy,
  onAdd,
}: {
  value: { name: string; maxScore: number };
  onChange: (v: { name: string; maxScore: number }) => void;
  remaining: number;
  busy: boolean;
  onAdd: () => void;
}) {
  return (
    <div
      style={{
        padding: 12,
        borderRadius: 8,
        background: 'rgba(255,255,255,0.02)',
        border: '0.5px solid rgba(255,255,255,0.06)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: MUTED,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 600,
          marginBottom: 8,
        }}
      >
        Add category
      </div>
      <div className="fg">
        <input
          className="inp"
          placeholder="Category name, e.g. Business Impact"
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            className="inp"
            style={{ width: 70 }}
            placeholder="Pts"
            max={remaining}
            value={value.maxScore || ''}
            onChange={(e) =>
              onChange({ ...value, maxScore: Math.min(Number(e.target.value), remaining) })
            }
          />
          <span style={{ fontSize: 11, color: MUTED, whiteSpace: 'nowrap' }}>
            {remaining} left
          </span>
        </div>
      </div>
      <button type="button"
        className="btn btn-pri btn-sm"
        style={{ marginTop: 8 }}
        disabled={busy || !value.name.trim() || value.maxScore < 1}
        onClick={onAdd}
      >
        Add category
      </button>
    </div>
  );
}
