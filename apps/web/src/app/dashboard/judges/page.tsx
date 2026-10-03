'use client';
import { useState, useRef } from 'react';
import { useQuery } from '@/lib/use-graphql';
import { useAuthStore } from '@/lib/auth-store';
import { EVENTS_QUERY, JUDGES_QUERY } from '@/lib/queries';
import StatusBadge from '@/components/status-badge';
import DataTable from '@/components/data-table';

export default function JudgesPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const event = evData?.events?.[0];
  const eventId = event?.id;
  const { data: judgeData, loading } = useQuery<any>(JUDGES_QUERY, eventId ? { eventId } : undefined);
  const token = useAuthStore((s) => s.token);
  const judges = judgeData?.judges || [];

  const [showUpload, setShowUpload] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [filterAffil, setFilterAffil] = useState<string>('all');
  const fileRef = useRef<HTMLInputElement>(null);

  const expectedColumns = [
    { key: 'name', label: 'Full name', required: true },
    { key: 'email', label: 'Email', required: true },
    { key: 'phone', label: 'Phone (+65...)', required: false },
    { key: 'designation', label: 'Job title', required: false },
    { key: 'judge_type', label: 'Judge type', required: true },
    { key: 'affiliation_type', label: 'BU / IG / VENDOR', required: true },
    { key: 'affiliation_name', label: 'Affiliation name', required: true },
    { key: 'max_sessions', label: 'Max sessions', required: false },
  ];

  const judgeTypes = ['TECHNICAL', 'BUSINESS', 'DOMAIN', 'INNOVATION', 'EXECUTIVE'];
  const affiliationTypes = ['BU', 'IG', 'VENDOR'];

  const affiliationColors: Record<string, string> = {
    'BU': 'bg-blue-500/10 border-blue-500/20 text-blue-400',
    'IG': 'bg-purple-500/10 border-purple-500/20 text-purple-400',
    'VENDOR': 'bg-green-500/10 border-green-500/20 text-green-400',
  };

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
      const res = await fetch('/api/import/judges', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json();
      setResult(data);
      if (data.imported > 0) setTimeout(() => window.location.reload(), 2000);
    } catch (e: any) { setResult({ error: e.message }); }
    setUploading(false);
  };

  // Parse affiliation from organisation field (format: "TYPE:NAME")
  const getAffil = (j: any) => {
    const org = j.organisation || '';
    if (org.includes(':')) {
      const [type, name] = org.split(':').map((s: string) => s.trim());
      return { type: type.toUpperCase(), name };
    }
    // Fall back to department/organisation
    return { type: (j as any).department ? 'BU' : 'OTHER', name: (j as any).department || org || '—' };
  };

  // Unique affiliations for filter
  const allAffils = judges.map((j: any) => getAffil(j));
  const uniqueAffilTypes = [...new Set(allAffils.map((a: any) => a.type))].filter(Boolean);
  const uniqueAffilNames = [...new Set(allAffils.map((a: any) => `${a.type}:${a.name}`))].filter(Boolean);

  // Filter
  let filteredJudges = judges;
  if (filterType !== 'all') filteredJudges = filteredJudges.filter((j: any) => j.judgeType === filterType);
  if (filterAffil !== 'all') {
    if (affiliationTypes.includes(filterAffil)) {
      filteredJudges = filteredJudges.filter((j: any) => getAffil(j).type === filterAffil);
    } else {
      filteredJudges = filteredJudges.filter((j: any) => {
        const a = getAffil(j);
        return `${a.type}:${a.name}` === filterAffil;
      });
    }
  }

  // Stats
  const byType: Record<string, number> = {};
  judges.forEach((j: any) => { byType[j.judgeType] = (byType[j.judgeType] || 0) + 1; });
  const byAffilType: Record<string, number> = {};
  allAffils.forEach((a: any) => { byAffilType[a.type] = (byAffilType[a.type] || 0) + 1; });

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-white">Judges</h1>
          <p className="text-sm text-slate-400 mt-0.5">{judges.length} judges loaded</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={filterType} onChange={(e) => setFilterType(e.target.value)}
            className="bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-sm text-white outline-none">
            <option value="all">All types ({judges.length})</option>
            {judgeTypes.map(t => <option key={t} value={t}>{t} ({byType[t] || 0})</option>)}
          </select>
          <select value={filterAffil} onChange={(e) => setFilterAffil(e.target.value)}
            className="bg-dark-700 border border-dark-500 rounded-lg px-3 py-2 text-sm text-white outline-none">
            <option value="all">All affiliations</option>
            <optgroup label="By type">
              {affiliationTypes.map(t => <option key={t} value={t}>{t} ({byAffilType[t] || 0})</option>)}
            </optgroup>
            <optgroup label="By name">
              {uniqueAffilNames.map(n => <option key={n} value={n}>{n.replace(':', ' · ')}</option>)}
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
          <h3 className="text-sm font-semibold text-white mb-3">Import judges from CSV</h3>

          <div className="mb-4">
            <p className="text-xs text-slate-400 mb-2">Expected CSV columns:</p>
            <div className="flex flex-wrap gap-2">
              {expectedColumns.map(col => (
                <span key={col.key} className={`px-2 py-1 rounded text-xs font-mono ${
                  col.required ? 'bg-accent/10 border border-accent/20 text-accent' : 'bg-dark-700 border border-dark-500 text-slate-400'
                }`}>{col.key}{col.required ? ' *' : ''}</span>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
              <div className="rounded-lg bg-dark-900/60 p-3">
                <p className="font-semibold text-white mb-1">judge_type</p>
                <p className="text-slate-400">{judgeTypes.join(', ')}</p>
              </div>
              <div className="rounded-lg bg-dark-900/60 p-3">
                <p className="font-semibold text-white mb-1">affiliation_type</p>
                <div className="space-y-1">
                  <p className="text-blue-400">BU — Business Unit (GRB, GWB, Group Risk)</p>
                  <p className="text-purple-400">IG — Interest Group (Innovation Guild)</p>
                  <p className="text-green-400">VENDOR — External (AWS, Google, Microsoft)</p>
                </div>
              </div>
              <div className="rounded-lg bg-dark-900/60 p-3">
                <p className="font-semibold text-white mb-1">affiliation_name</p>
                <p className="text-slate-400">The specific BU, IG, or vendor company name</p>
              </div>
            </div>
          </div>

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
              <p className="text-sm text-slate-400">Drop a CSV file here or click to browse</p>
            )}
          </div>

          {preview.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-400">Preview</p>
                <div className="flex gap-2 flex-wrap">
                  {headers.map(h => {
                    const expected = expectedColumns.find(c => c.key === h);
                    return <span key={h} className={`px-2 py-0.5 rounded text-xs ${expected ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400'}`}>{h} {expected ? '✓' : '?'}</span>;
                  })}
                </div>
              </div>
              <div className="overflow-x-auto rounded-lg border border-dark-600">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-dark-600 bg-dark-700/50">
                    {headers.map(h => <th key={h} className="px-3 py-2 text-left text-slate-400 font-medium">{h}</th>)}
                  </tr></thead>
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

          {file && (
            <div className="mt-4 flex items-center gap-3">
              <button type="button" onClick={uploadCSV} disabled={uploading}
                className="px-4 py-2 bg-accent hover:bg-accent/90 text-white text-sm font-medium rounded-lg disabled:opacity-50">
                {uploading ? 'Uploading...' : `Import ${preview.length}+ judges`}
              </button>
              <button type="button" onClick={() => { setFile(null); setPreview([]); setHeaders([]); setResult(null); }}
                className="px-4 py-2 bg-dark-700 hover:bg-dark-600 text-white text-sm rounded-lg border border-dark-500">Clear</button>
            </div>
          )}

          {result && (
            <div className={`mt-4 rounded-lg p-4 text-sm ${result.error ? 'bg-red-500/10 border border-red-500/20 text-red-400' : 'bg-green-500/10 border border-green-500/20 text-green-400'}`}>
              {result.error ? result.error : `Imported ${result.imported} judges. ${result.skipped || 0} skipped.`}
            </div>
          )}

          <div className="mt-4 pt-4 border-t border-dark-600">
            <button type="button" onClick={() => {
              const csv = 'name,email,phone,designation,judge_type,affiliation_type,affiliation_name,max_sessions\nDr. Sarah Kim,sarah.kim@uob.com,+6591234567,VP Technology,TECHNICAL,BU,GRB,8\nJames Tan,james.tan@uob.com,+6598765432,Director Innovation,INNOVATION,IG,Innovation Guild,6\nMike Chen,mike@aws.com,+6587654321,Solutions Architect,TECHNICAL,VENDOR,AWS,4';
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = 'judges_template.csv'; a.click();
            }} className="text-xs text-accent hover:text-accent/80">
              Download CSV template with examples
            </button>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-8 gap-3 mb-5">
        {judgeTypes.map(type => (
          <div key={type} className="rounded-lg border border-dark-600 bg-dark-800/50 px-3 py-2 text-center">
            <p className="text-lg font-bold text-white">{byType[type] || 0}</p>
            <StatusBadge status={type} />
          </div>
        ))}
        <div className="col-span-3 rounded-lg border border-dark-600 bg-dark-800/50 px-4 py-2 flex items-center justify-around">
          {affiliationTypes.map(t => (
            <div key={t} className="text-center">
              <p className="text-lg font-bold text-white">{byAffilType[t] || 0}</p>
              <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${affiliationColors[t]}`}>{t}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Judge list */}
      <DataTable
        loading={loading}
        emptyMessage="No judges yet. Upload a CSV to get started."
        columns={[
          { key: 'name', label: 'Name', render: (j: any) => (
            <div>
              <p className="font-medium text-white">{j.name}</p>
              <p className="text-xs text-slate-400">{j.email}</p>
            </div>
          )},
          { key: 'judgeType', label: 'Type', render: (j: any) => <StatusBadge status={j.judgeType} /> },
          { key: 'affiliation', label: 'Affiliation', render: (j: any) => {
            const a = getAffil(j);
            const color = affiliationColors[a.type] || 'bg-dark-700 border-dark-500 text-slate-400';
            return (
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded text-xs font-semibold border ${color}`}>{a.type}</span>
                <span className="text-sm text-white">{a.name}</span>
              </div>
            );
          }},
          { key: 'designation', label: 'Designation', render: (j: any) => (
            <span className="text-sm text-slate-300">{j.designation || '—'}</span>
          )},
          { key: 'maxSessions', label: 'Capacity', render: (j: any) => (
            <span className="text-sm font-mono">{j.maxSessions} max</span>
          )},
          { key: 'conflicts', label: 'Conflicts', render: (j: any) => (
            j.conflictCount > 0
              ? <span className="text-sm text-yellow-400">{j.conflictCount}</span>
              : <span className="text-sm text-slate-500">—</span>
          )},
          { key: 'status', label: 'Status', render: (j: any) => <StatusBadge status={j.status} /> },
        ]}
        data={filteredJudges}
      />
    </div>
  );
}
