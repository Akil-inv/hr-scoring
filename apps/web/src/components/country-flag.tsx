'use client';

/**
 * Country flag for a use case.
 *
 * Rendered from the ISO code as an emoji — no assets, no licensing question,
 * and it works on every platform judges will actually use.
 *
 * The code is validated at import against the list below, because almost every
 * two-letter typo is a valid country somewhere. An unchecked "AN" renders the
 * Netherlands Antilles quite happily, and nobody notices until someone asks
 * why a team is flagged as a country that no longer exists.
 *
 * Placed at the top right of a card rather than beside the team name. It is a
 * property of the session, not part of the title, and putting it inline makes
 * team names of different lengths sit unevenly.
 */

export const COUNTRIES: Record<string, string> = {
  TH: 'Thailand',
  SG: 'Singapore',
  MY: 'Malaysia',
  ID: 'Indonesia',
  VN: 'Vietnam',
  HK: 'Hong Kong',
  CN: 'China',
};

/** Regional indicator symbols sit 127397 above ASCII uppercase. */
export function flagEmoji(code?: string | null): string {
  if (!code) return '';
  const upper = code.trim().toUpperCase();
  if (!COUNTRIES[upper]) return '';
  return String.fromCodePoint(
    ...[...upper].map((c) => 127397 + c.charCodeAt(0)),
  );
}

/** Everything outside Singapore presents by video, so the room needs VC. */
export function isRemote(code?: string | null): boolean {
  if (!code) return false;
  return code.trim().toUpperCase() !== 'SG';
}

export default function CountryFlag({
  code,
  size = 16,
  showVC = false,
}: {
  code?: string | null;
  /** Font size in pixels. 16 suits a card, 20 a heading. */
  size?: number;
  /** Show a VC marker for remote teams — Command Centre only, not the judge portal. */
  showVC?: boolean;
}) {
  const flag = flagEmoji(code);
  if (!flag) return null;

  const name = COUNTRIES[code!.trim().toUpperCase()];
  const remote = isRemote(code);

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5"
      title={remote ? `${name} — presenting by video` : name}
    >
      <span style={{ fontSize: size, lineHeight: 1 }} role="img" aria-label={name}>
        {flag}
      </span>
      {showVC && remote && (
        <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
          VC
        </span>
      )}
    </span>
  );
}
