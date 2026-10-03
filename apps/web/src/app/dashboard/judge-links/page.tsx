'use client';
import { useState, useEffect } from 'react';
import { useQuery } from '@/lib/use-graphql';
import { EVENTS_QUERY } from '@/lib/queries';
import { useAuthStore } from '@/lib/auth-store';
import { createClient } from '@/lib/graphql-client';
import { useEventId } from '@/lib/event-store';

const JUDGE_LINKS_QUERY = `query JudgeLinks($eventId: String!) { judgeLinks(eventId: $eventId) { judgeId name email phone token link sessionCount } }`;

type NotifConfig = {
  provider: 'none' | 'ses' | 'sns' | 'both';
  sesRegion: string;
  sesFromEmail: string;
  snsRegion: string;
  configured: boolean;
};

export default function JudgeLinksPage() {
  const { data: evData } = useQuery<any>(EVENTS_QUERY);
  const selectedEventId = useEventId();
  const currentEvent =
    evData?.events?.find((e: any) => e.id === selectedEventId) ?? evData?.events?.[0];
  const eventId = currentEvent?.id;
  const eventName = currentEvent?.name || 'Hackathon';
  const token = useAuthStore((s) => s.token);
  const [links, setLinks] = useState<any[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(true);
  const [copied, setCopied] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<Set<string>>(new Set());

  const [config, setConfig] = useState<NotifConfig>({
    provider: 'none',
    sesRegion: 'ap-southeast-1',
    sesFromEmail: '',
    snsRegion: 'ap-southeast-1',
    configured: false,
  });

  useEffect(() => {
    const saved = localStorage.getItem('notif-config');
    if (saved) setConfig(JSON.parse(saved));
  }, []);

  const saveConfig = () => {
    const updated = { ...config, configured: config.provider !== 'none' && (config.provider === 'sns' || config.sesFromEmail.length > 0) };
    setConfig(updated);
    localStorage.setItem('notif-config', JSON.stringify(updated));
    setShowConfig(false);
  };

  useEffect(() => {
    if (!eventId || !token) return;
    // Reset before fetching so switching events does not briefly show the
    // previous event's links.
    setLoadingLinks(true);
    setLinks([]);
    const client = createClient(token);
    client.query(JUDGE_LINKS_QUERY, { eventId }).toPromise()
      .then(res => {
        setLinks(res.data?.judgeLinks || []);
      })
      .finally(() => setLoadingLinks(false));
  }, [eventId, token]);

  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const copyLink = (link: any) => {
    navigator.clipboard.writeText(baseUrl + link.link);
    setCopied(link.judgeId);
    setTimeout(() => setCopied(''), 2000);
  };

  const copyAll = () => {
    const allLinks = links.map(l => `${l.name} (${l.email})\n${baseUrl}${l.link}`).join('\n\n');
    navigator.clipboard.writeText(allLinks);
    setCopied('all');
    setTimeout(() => setCopied(''), 2000);
  };

  const sendNotification = async (link: any) => {
    if (!config.configured) {
      setShowConfig(true);
      return;
    }
    setSending(link.judgeId);

    try {
      const res = await fetch('/api/notify/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          judgeName: link.name,
          judgeEmail: link.email,
          judgePhone: link.phone || '',
          portalLink: baseUrl + link.link,
          eventName,
          channel: config.provider === 'both' ? 'both' : config.provider === 'sns' ? 'sns' : 'ses',
          sesFromEmail: config.sesFromEmail,
          sesRegion: config.sesRegion,
          snsRegion: config.snsRegion,
        }),
      });
      const result = await res.json();
      if (result.email?.success || result.sms?.success) {
        // success
      } else {
        console.error('Send failed:', result);
        return;
      }
    } catch (e: any) {
      console.error('Send error:', e);
      return;
    }

    setSentTo(prev => new Set([...prev, link.judgeId]));
    setSending(null);
  };

  const sendAll = async () => {
    if (!config.configured) {
      setShowConfig(true);
      return;
    }
    for (const link of links) {
      if (!sentTo.has(link.judgeId)) {
        await sendNotification(link);
      }
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Judge links & notifications</h1>
          <p className="text-sm text-slate-400 mt-1">Send each judge their personal schedule link</p>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setShowConfig(!showConfig)}
            className={`px-4 py-2 text-sm rounded-lg border transition-all ${
              config.configured
                ? 'bg-green-500/10 border-green-500/20 text-green-400'
                : 'bg-dark-700 border-dark-500 text-white hover:bg-dark-600'
            }`}>
            {config.configured ? `✓ ${config.provider.toUpperCase()} configured` : '⚙ Configure notifications'}
          </button>
          <button type="button" onClick={copyAll}
            className="px-4 py-2 bg-dark-700 hover:bg-dark-600 text-white text-sm rounded-lg border border-dark-500">
            {copied === 'all' ? '✓ Copied all' : 'Copy all links'}
          </button>
          {config.configured && (
            <button type="button" onClick={sendAll}
              className="px-4 py-2 bg-accent hover:bg-accent/90 text-white text-sm font-medium rounded-lg shadow-lg shadow-accent/20">
              Send to all judges
            </button>
          )}
        </div>
      </div>

      {/* Configuration panel */}
      {showConfig && (
        <div className="mb-6 rounded-xl border border-dark-600 bg-dark-800/80 p-6">
          <h3 className="text-sm font-semibold text-white mb-4">Notification configuration</h3>
          <p className="text-xs text-slate-400 mb-4">
            Configure AWS SES (email) and/or SNS (SMS) to send judge links automatically.
            These services are available when deployed on AWS with proper IAM roles.
          </p>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Provider selection */}
            <div>
              <label className="text-xs text-slate-400 uppercase tracking-wider font-medium">Notification method</label>
              <div className="mt-2 space-y-2">
                {[
                  { value: 'none', label: 'None (copy links manually)' },
                  { value: 'ses', label: 'Email via AWS SES' },
                  { value: 'sns', label: 'SMS via AWS SNS' },
                  { value: 'both', label: 'Both email + SMS' },
                ].map(opt => (
                  <label key={opt.value} className="flex items-center gap-3 cursor-pointer">
                    <input type="radio" name="provider" value={opt.value}
                      checked={config.provider === opt.value}
                      onChange={() => setConfig(prev => ({ ...prev, provider: opt.value as any }))}
                      className="accent-[#7c3aed]" />
                    <span className="text-sm text-white">{opt.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* SES config */}
            {(config.provider === 'ses' || config.provider === 'both') && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-400 uppercase tracking-wider font-medium">SES region</label>
                  <select value={config.sesRegion} onChange={(e) => setConfig(prev => ({ ...prev, sesRegion: e.target.value }))}
                    className="mt-1 w-full bg-dark-900/60 border border-dark-500 rounded-lg px-3 py-2 text-sm text-white outline-none">
                    <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                    <option value="us-east-1">us-east-1 (N. Virginia)</option>
                    <option value="eu-west-1">eu-west-1 (Ireland)</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 uppercase tracking-wider font-medium">From email (verified in SES)</label>
                  <input type="email" value={config.sesFromEmail}
                    onChange={(e) => setConfig(prev => ({ ...prev, sesFromEmail: e.target.value }))}
                    placeholder="noreply@yourdomain.com"
                    className="mt-1 w-full bg-dark-900/60 border border-dark-500 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 outline-none" />
                </div>
              </div>
            )}

            {/* SNS config */}
            {(config.provider === 'sns' || config.provider === 'both') && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-400 uppercase tracking-wider font-medium">SNS region</label>
                  <select value={config.snsRegion} onChange={(e) => setConfig(prev => ({ ...prev, snsRegion: e.target.value }))}
                    className="mt-1 w-full bg-dark-900/60 border border-dark-500 rounded-lg px-3 py-2 text-sm text-white outline-none">
                    <option value="ap-southeast-1">ap-southeast-1 (Singapore)</option>
                    <option value="us-east-1">us-east-1 (N. Virginia)</option>
                    <option value="eu-west-1">eu-west-1 (Ireland)</option>
                  </select>
                </div>
                <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3">
                  <p className="text-xs text-yellow-400">
                    SMS requires judge phone numbers. Add them via judge management or CSV import (column: phone).
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-3 mt-4 pt-4 border-t border-dark-600">
            <button type="button" onClick={saveConfig}
              className="px-4 py-2 bg-accent hover:bg-accent/90 text-white text-sm rounded-lg">
              Save configuration
            </button>
            <button type="button" onClick={() => setShowConfig(false)}
              className="px-4 py-2 bg-dark-700 hover:bg-dark-600 text-white text-sm rounded-lg border border-dark-500">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Email template */}
      <div className="mb-6 rounded-xl border border-dark-600 bg-dark-800/50 p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-white">Email / SMS template</h3>
          <button type="button" onClick={() => {
            const template = `Dear [Judge Name],\n\nYou have been invited to judge ${eventName}.\n\nYour personal schedule and scoring portal:\n[Judge Link]\n\nThis link contains your session times, room assignments, and team details. On event day, you will use this link to enter scores.\n\nPlease review your schedule before the event.\n\nThank you,\n${eventName} Team`;
            navigator.clipboard.writeText(template);
            setCopied('template');
            setTimeout(() => setCopied(''), 2000);
          }}
            className="text-xs text-slate-400 hover:text-white">
            {copied === 'template' ? '✓ Copied' : 'Copy template'}
          </button>
        </div>
        <div className="bg-dark-900/60 rounded-lg p-4 text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">
{`Dear [Judge Name],

You have been invited to judge ${eventName}.

Your personal schedule and scoring portal:
[Judge Link]

This link contains your session times, room assignments, and team details.
On event day, you will use this link to enter scores.

Please review your schedule before the event.

Thank you,
${eventName} Team`}
        </div>
      </div>

      {/* Judge list */}
      <div className="space-y-2">
        {links.map((link: any) => {
          const isSent = sentTo.has(link.judgeId);
          const isSending = sending === link.judgeId;

          return (
            <div key={link.judgeId} className={`rounded-xl border bg-dark-800/50 px-5 py-4 flex items-center justify-between ${
              isSent ? 'border-green-500/20' : 'border-dark-600'
            }`}>
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <p className="text-sm font-medium text-white">{link.name}</p>
                  {isSent && <span className="text-xs text-green-400">✓ Sent</span>}
                </div>
                <p className="text-xs mt-0.5">
                  <span className={link.sessionCount === 0 ? 'text-amber-400' : 'text-slate-500'}>
                    {link.sessionCount === 0
                      ? 'no sessions — this link opens an empty page'
                      : `${link.sessionCount} session${link.sessionCount === 1 ? '' : 's'}`}
                  </span>
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {link.email}
                  {link.phone ? (
                    <span className="ml-2 text-slate-500">{link.phone}</span>
                  ) : (
                    <span className="ml-2 text-slate-600">no phone</span>
                  )}
                </p>
                <p className="text-xs text-slate-600 font-mono mt-0.5">{baseUrl}{link.link}</p>
              </div>
              <div className="flex items-center gap-2">
                <a href={link.link} target="_blank" rel="noopener"
                  className="px-3 py-2 bg-dark-700 hover:bg-dark-600 text-white text-sm rounded-lg border border-dark-500">
                  Preview
                </a>
                <button type="button" onClick={() => copyLink(link)}
                  className="px-3 py-2 bg-dark-700 hover:bg-dark-600 text-white text-sm rounded-lg border border-dark-500">
                  {copied === link.judgeId ? '✓ Copied' : 'Copy'}
                </button>
                {config.configured && (
                  <button type="button" onClick={() => sendNotification(link)} disabled={isSending || isSent}
                    className={`px-3 py-2 text-sm rounded-lg transition-all ${
                      isSent ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                        : 'bg-accent hover:bg-accent/90 text-white shadow-lg shadow-accent/20'
                    } disabled:opacity-50`}>
                    {isSending ? 'Sending...' : isSent ? '✓ Sent' : config.provider === 'sns' ? 'Send SMS' : config.provider === 'both' ? 'Send both' : 'Send email'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {links.length === 0 && (
          <div className="rounded-xl border border-dark-600 bg-dark-800/50 py-12 text-center">
            {loadingLinks ? (
              <p className="text-sm text-slate-500">Loading judge links...</p>
            ) : (
              <>
                <p className="text-sm text-slate-400">
                  No judges on {eventName} yet.
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Import judges in Event Setup, then their links appear here.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {/* Stats footer */}
      {links.length > 0 && (
        <div className="mt-4 flex items-center gap-6 text-sm text-slate-400">
          <span>{links.length} judges</span>
          <span>{sentTo.size} notified</span>
          <span>{links.length - sentTo.size} pending</span>
        </div>
      )}
    </div>
  );
}
