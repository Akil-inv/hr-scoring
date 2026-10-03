'use client';

/**
 * Platform chip.
 *
 * A text label rather than a vendor logo — the marks are trademarked, and a
 * coloured chip carries the same information without the licensing question.
 *
 * The colours are borrowed loosely from each vendor's own palette so they are
 * recognisable at a glance across a dense planner: someone scanning for the
 * AWS block should not have to read every chip. Internal is deliberately grey,
 * since it means "no external platform" and therefore no vendor to invite.
 *
 * Used on the schedule builder and Command Centre. Not on the judge portal —
 * a judge does not need to know which vendor is in the room, and showing it
 * would only invite the thought that this session is somehow different.
 */

const PLATFORM_STYLES: Record<string, { bg: string; fg: string; border: string }> = {
  'AWS':           { bg: 'rgba(255,153,0,0.12)',  fg: '#ffb84d', border: 'rgba(255,153,0,0.3)' },
  'GCP':           { bg: 'rgba(66,133,244,0.12)', fg: '#7aa7f7', border: 'rgba(66,133,244,0.3)' },
  'CLOUDERA':      { bg: 'rgba(240,84,56,0.12)',  fg: '#f5836b', border: 'rgba(240,84,56,0.3)' },
  'QLIK SENSE':    { bg: 'rgba(0,158,84,0.12)',   fg: '#43c98a', border: 'rgba(0,158,84,0.3)' },
  'PURPLE FABRIC': { bg: 'rgba(147,51,234,0.12)', fg: '#c084fc', border: 'rgba(147,51,234,0.3)' },
  'INTERNAL':      { bg: 'rgba(148,163,184,0.1)', fg: '#94a3b8', border: 'rgba(148,163,184,0.25)' },
  'OTHER':         { bg: 'rgba(148,163,184,0.1)', fg: '#94a3b8', border: 'rgba(148,163,184,0.25)' },
};

/** Short forms, because a planner card has no room for "PURPLE FABRIC". */
const SHORT: Record<string, string> = {
  'PURPLE FABRIC': 'P.FABRIC',
  'QLIK SENSE': 'QLIK',
  'CLOUDERA': 'CLOUDERA',
  'INTERNAL': 'INTERNAL',
};

export function platformColor(platform?: string | null) {
  if (!platform) return null;
  return PLATFORM_STYLES[platform.trim().toUpperCase()] ?? PLATFORM_STYLES['OTHER'];
}

export default function PlatformChip({
  platform,
  size = 'sm',
}: {
  platform?: string | null;
  size?: 'xs' | 'sm';
}) {
  if (!platform) return null;

  const key = platform.trim().toUpperCase();
  const style = PLATFORM_STYLES[key] ?? PLATFORM_STYLES['OTHER'];
  const label = SHORT[key] ?? key;

  return (
    <span
      style={{
        background: style.bg,
        color: style.fg,
        border: `0.5px solid ${style.border}`,
        fontSize: size === 'xs' ? 9 : 10,
        padding: size === 'xs' ? '1px 5px' : '2px 6px',
        borderRadius: 4,
        fontWeight: 500,
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
      }}
      title={platform}
    >
      {label}
    </span>
  );
}
