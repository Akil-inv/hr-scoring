'use client';

import { useEffect, useState } from 'react';

/**
 * Shows a PDF inside the app, over the page, with a download button. The PDF
 * is fetched with the sign-in token by `load`, so it never needs a public URL.
 */
export default function PdfViewer({
  title, subtitle, load, onClose,
}: {
  title: string;
  subtitle?: string;
  load: () => Promise<{ blob: Blob; name: string }>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [name, setName] = useState('report.pdf');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let href: string | null = null;
    let live = true;
    load()
      .then(({ blob, name: n }) => {
        if (!live) return;
        href = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        setUrl(href);
        setName(n);
      })
      .catch((e) => live && setError(e?.message ?? 'Could not load the report.'));
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => {
      live = false;
      window.removeEventListener('keydown', onKey);
      if (href) URL.revokeObjectURL(href);
    };
    // load is recreated by callers each render; the viewer loads once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-dark-600 bg-dark-800 shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-dark-600 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{title}</p>
            {subtitle && <p className="truncate text-xs text-slate-400">{subtitle}</p>}
            <p className="truncate text-xs text-slate-500">🔒 Opens with your document password, here and when downloaded.</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {url && (
              <a href={url} download={name}
                className="rounded-lg border border-dark-500 px-3 py-1.5 text-sm text-slate-200 hover:border-accent/60">Download</a>
            )}
            <button type="button" onClick={onClose} aria-label="Close"
              className="rounded-lg px-2.5 py-1.5 text-lg leading-none text-slate-400 hover:text-white">✕</button>
          </div>
        </div>
        <div className="flex-1 bg-[#525659]">
          {error ? (
            <p className="p-6 text-sm text-red-300">{error}</p>
          ) : url ? (
            <iframe src={`${url}#view=FitH`} title={title} className="h-full w-full" />
          ) : (
            <p className="p-6 text-sm text-slate-200">Preparing the report…</p>
          )}
        </div>
      </div>
    </div>
  );
}
