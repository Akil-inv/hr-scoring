'use client';
import { useState, useRef } from 'react';
import { useQuery } from '@/lib/use-graphql';
import { useAuthStore } from '@/lib/auth-store';
import { EVENTS_QUERY, TEAMS_QUERY } from '@/lib/queries';
import StatusBadge from '@/components/status-badge';
import DataTable from '@/components/data-table';

export default function TeamsPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const event = evData?.events?.[0];
  const eventId = event?.id;
  const { data: teamData, loading } = useQuery<any>(TEAMS_QUERY, eventId ? { eventId } : undefined);
  const token = useAuthStore((s) => s.token);
  const teams = teamData?.teams || [];

  const [showUpload, setShowUpload] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [groupBy, setGroupBy] = useState<string>('all');
  const fileRef = useRef<HTMLInputElement>(null);

  const expectedColumns = [
    { key: 'team_name', label: 'Team name', required: true },
    { key: 'project_name', label: 'Project name', required: true },
    { key: 'team_lead_name', label: 'Team lead name', required: false },
    { key: 'team_lead_email', label: 'Team lead email', required: true },
    { key: 'track_name', label: 'Track / Category', required: false },
    { key: 'department', label: 'Department / BU', required: false },
    { key: 'organisation', label: 'Organisation', required: false },
    { key: 'use_case_title', label: 'Use case title', required: false },
    { key: 'tech_stack', label: 'Tech stack', required: false },
    { key: 'vendor_tools', label: 'Vendor tools', required: false },
    { key: 'country', label: 'Country', required: false },
  ];

  const parseCSV = (text: string) => {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return { headers: [], rows: [] };
    const hdrs = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_').replace(/['"]/g, ''));
    const rows = lines.slice(1).map(line => {
      const values = line.split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
      const row: Record<string, string> = {};
      hdrs.forEach((h, i) => { row[h] = values[i] || ''; });
      return row;
    });
    return { headers: hdrs, rows };
  };

  const handleFile = (f: File) => {
    setFile(f);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers: hdrs, rows } = parseCSV(text);
      setHeaders(hdrs);
      setPreview(rows.slice(0, 5));
    };
    reader.readAsText(f);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.name.endsWith('.csv') || f.type === 'text/csv')) handleFile(f);
  };

  const uploadCSV = async () => {
    if (!file || !eventId) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('eventId', eventId);
      const res = await fetch('/api/import/teams', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json();
      setResult(data);
      if (data.imported > 0) {
        setTimeout(() => window.location.reload(), 2000);
      }
    } catch (e: any) {
      setResult({ error: e.message });
    }
    setUploading(false);
  };

  // Group and filter
  const uniqueDepts = [...new Set(teams.map((t: any) => t.department || t.organisation || 'Unassigned'))].filter(Boolean);
  const uniqueTracks = [...new Set(teams.map((t: any) => t.trackName || 'Unassigned'))].filter(Boolean);

  const filteredTeams = groupBy === 'all' ? teams : teams.filter((t: any) => {
    if (groupBy.startsWith('dept:')) return (t.department || t.organisation) === groupBy.slice(5);
    if (groupBy.startsWith('track:')) return t.trackName === groupBy.slice(6);
    return true;
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-white">Teams</h1>
          <p className="text-sm text-slate-400 mt-0.5">{teams.length} teams loaded</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}
            className="bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-sm text-white outline-none">
            <option value="all">All teams ({teams.length})</option>
            <optgroup label="By department">
              {uniqueDepts.map(d => <option key={d} value={`dept:${d}`}>{d}</option>)}
            </optgroup>
            <optgroup label="By track">
              {uniqueTracks.map(t => <option key={t} value={`track:${t}`}>{t}</option>)}
            </optgroup>
          </select>
          <button type="button" onClick={() => setShowUpload(!showUpload)}
            className="px-4 py-2 bg-accent hover:bg-accent/90 text-white text-sm font-medium rounded-lg shadow-lg shadow-accent/20">
            {showUpload ? 'Close upload' : '+ Upload CSV'}
          </button>
        </div>
      </div>

      {/* Upload panel */}
      {showUpload && (
        <div className="mb-6 rounded-xl border border-dark-600 bg-dark-800/80 p-6">
          <h3 className="text-sm font-semibold text-white mb-3">Import teams from CSV</h3>

          {/* Expected columns */}
          <div className="mb-4">
            <p className="text-xs text-slate-400 mb-2">Expected CSV columns:</p>
            <div className="flex flex-wrap gap-2">
              {expectedColumns.map(col => (
                <span key={col.key} className={`px-2 py-1 rounded text-xs font-mono ${
                  col.required ? 'bg-accent/10 border border-accent/20 text-accent' : 'bg-dark-700 border border-dark-500 text-slate-400'
                }`}>
                  {col.key}{col.required ? ' *' : ''}
                </span>
              ))}
            </div>
          </div>

          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
              dragOver ? 'border-accent bg-accent/5' : 'border-dark-500 hover:border-dark-400'
            }`}>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
            {file ? (
              <div>
                <p className="text-sm text-white font-medium">{file.name}</p>
                <p className="text-xs text-slate-400 mt-1">{(file.size / 1024).toFixed(1)} KB · {preview.length} rows previewed</p>
              </div>
            ) : (
              <div>
                <p className="text-sm text-slate-400">Drop a CSV file here or click to browse</p>
                <p className="text-xs text-slate-500 mt-1">Maximum recommended: 200 teams per upload</p>
              </div>
            )}
          </div>

          {/* Preview */}
          {preview.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-400">Preview (first {preview.length} rows)</p>
                <div className="flex gap-2">
                  {headers.map(h => {
                    const expected = expectedColumns.find(c => c.key === h);
                    return (
                      <span key={h} className={`px-2 py-0.5 rounded text-xs ${
                        expected ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400'
                      }`}>
                        {h} {expected ? '✓' : '?'}
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className="overflow-x-auto rounded-lg border border-dark-600">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-dark-600 bg-dark-700/50">
                      {headers.map(h => <th key={h} className="px-3 py-2 text-left text-slate-400 font-medium">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => (
                      <tr key={i} className="border-b border-dark-600/50">
                        {headers.map(h => <td key={h} className="px-3 py-2 text-white">{row[h] || '—'}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Upload button */}
          {file && (
            <div className="mt-4 flex items-center gap-3">
              <button type="button" onClick={uploadCSV} disabled={uploading}
                className="px-4 py-2 bg-accent hover:bg-accent/90 text-white text-sm font-medium rounded-lg disabled:opacity-50">
                {uploading ? 'Uploading...' : `Import ${preview.length}+ teams`}
              </button>
              <button type="button" onClick={() => { setFile(null); setPreview([]); setHeaders([]); setResult(null); }}
                className="px-4 py-2 bg-dark-700 hover:bg-dark-600 text-white text-sm rounded-lg border border-dark-500">
                Clear
              </button>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className={`mt-4 rounded-lg p-4 text-sm ${
              result.error ? 'bg-red-500/10 border border-red-500/20 text-red-400' : 'bg-green-500/10 border border-green-500/20 text-green-400'
            }`}>
              {result.error ? result.error : `Imported ${result.imported} teams. ${result.skipped || 0} skipped.`}
              {result.errors?.length > 0 && (
                <div className="mt-2 space-y-1">
                  {result.errors.slice(0, 5).map((err: any, i: number) => (
                    <p key={i} className="text-xs text-red-300">Row {err.row}: {err.message}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Download template */}
          <div className="mt-4 pt-4 border-t border-dark-600">
            <button type="button" onClick={() => {
              const csv = expectedColumns.map(c => c.key).join(',') + '\nTeam Alpha,Smart Onboarding,John Doe,john@example.com,Customer Experience,Retail Banking,Group Retail,AI Onboarding,Python Azure,Microsoft Azure,Singapore';
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = 'teams_template.csv'; a.click();
            }} className="text-xs text-accent hover:text-accent/80">
              Download CSV template
            </button>
          </div>
        </div>
      )}

      {/* Team list */}
      <DataTable
        loading={loading}
        emptyMessage="No teams yet. Upload a CSV to get started."
        columns={[
          { key: 'name', label: 'Team', render: (t: any) => (
            <div>
              <p className="font-medium text-white">{t.name}</p>
              <p className="text-xs text-slate-400">{t.projectName}</p>
            </div>
          )},
          { key: 'trackName', label: 'Track', render: (t: any) => t.trackName ? <StatusBadge status={t.trackName} /> : <span className="text-slate-500">—</span> },
          { key: 'department', label: 'Department', render: (t: any) => <span className="text-sm">{t.department || t.organisation || '—'}</span> },
          { key: 'techStack', label: 'Tools', render: (t: any) => (
            <div className="flex flex-wrap gap-1 max-w-[200px]">
              {(t.techStack || t.vendorTools || '').split(',').filter(Boolean).slice(0, 3).map((tool: string, i: number) => (
                <span key={i} className="px-1.5 py-0.5 rounded bg-dark-700 border border-dark-500 text-xs text-slate-300">{tool.trim()}</span>
              ))}
            </div>
          )},
          { key: 'status', label: 'Status', render: (t: any) => <StatusBadge status={t.status} /> },
          { key: 'teamLeadEmail', label: 'Contact', render: (t: any) => <span className="text-xs text-slate-400">{t.teamLeadEmail}</span> },
        ]}
        data={filteredTeams}
      />
    </div>
  );
}
