// OMI (October Marketing Intelligence) PR panel — a modal opened from the reading-pane
// toolbar chip. On opening an email it looks the sender up in OMI (journalist/contact
// profile + recent coverage), lets you capture an unknown sender as a contact, and log
// the thread to a client's editorial log (OMI's Claude extraction fills in publication /
// issue date / story from the body). All calls are proxied server-side. The component
// stays mounted so the lookup runs and `onActiveChange` can tell the parent whether to
// show the toolbar chip; it renders nothing until `open` is set. Self-gates to nothing
// when OMI isn't configured.
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

const STATUS_OPTS = ['pitched', 'confirmed', 'published', 'declined'];

export default function OmiPrPanel({ message, bodyText, open, onClose, onActiveChange }) {
  const { t } = useTranslation();
  const email = (message?.from_email || '').trim();
  const senderName = message?.from_name || '';
  const subject = message?.subject || '';

  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);       // lookup result
  const [error, setError] = useState('');
  const [savingContact, setSavingContact] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [status, setStatus] = useState('pitched');
  const [storyUrl, setStoryUrl] = useState('');
  const [logging, setLogging] = useState(false);
  const [done, setDone] = useState(null);       // { kind: 'contact'|'log', text }

  // Is OMI configured at all? Checked once.
  useEffect(() => {
    let alive = true;
    api.omiStatus().then(s => { if (alive) setEnabled(!!s.enabled); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Look the sender up whenever the open email changes.
  useEffect(() => {
    if (!enabled || !email) { setData(null); return; }
    let alive = true;
    setLoading(true); setError(''); setData(null); setLogOpen(false); setDone(null);
    api.omiLookup(email)
      .then(d => { if (alive) setData(d); })
      .catch(err => { if (alive) setError(err.message || 'Lookup failed'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [enabled, email]);

  // Report to the parent whether OMI has anything to show for this message, so the
  // toolbar chip that opens this modal is only shown when it's useful.
  useEffect(() => { onActiveChange?.(enabled && !!email); }, [enabled, email, onActiveChange]);

  if (!enabled || !email || !open) return null;

  const clients = Array.isArray(data?.clients) ? data.clients : [];
  const matched = !!data?.matched;

  const addContact = async (segment) => {
    setSavingContact(true); setError('');
    try {
      await api.omiAddContact({ segment, email, name: senderName });
      setDone({ kind: 'contact', text: t('omi.contactAdded', { defaultValue: 'Contact added to OMI' }) });
      const d = await api.omiLookup(email).catch(() => null);
      if (d) setData(d);
    } catch (err) { setError(err.message || 'Failed to add contact'); }
    finally { setSavingContact(false); }
  };

  const submitLog = async () => {
    if (!clientId) return;
    setLogging(true); setError('');
    try {
      const r = await api.omiLogCoverage({
        client_id: clientId,
        email,
        press_contact: senderName,
        email_subject: subject,
        email_body: bodyText || '',
        status,
        story_url: storyUrl.trim() || undefined,
      });
      const ex = r?.extracted;
      const bits = ex ? [ex.publication, ex.story_title, ex.issue_date].filter(Boolean).join(' · ') : '';
      setDone({ kind: 'log', text: t('omi.logged', { defaultValue: 'Logged to editorial log' }) + (bits ? ` — ${bits}` : '') });
      setLogOpen(false);
    } catch (err) { setError(err.message || 'Failed to log'); }
    finally { setLogging(false); }
  };

  const btn = (primary) => ({
    padding: '5px 11px', borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: 'pointer',
    border: primary ? 'none' : '1px solid var(--border)',
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? 'var(--accent-text)' : 'var(--text-primary)',
  });

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 2100, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: '100%', maxWidth: 460, maxHeight: '85vh', overflow: 'auto',
        background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12,
        boxShadow: '0 12px 40px rgba(0,0,0,0.3)', fontSize: 13,
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: 'var(--accent-fg)', background: 'var(--accent-dim)', padding: '2px 6px', borderRadius: 5,
          }}>OMI</span>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {loading ? t('omi.looking', { defaultValue: 'Looking up sender…' })
              : matched ? (data.name || email)
              : t('omi.unknownSender', { defaultValue: 'Unknown sender' })}
          </span>
          {matched && data.strength_label && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{data.strength_label}</span>
          )}
          <button onClick={onClose} title={t('common.close', { defaultValue: 'Close' })}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', display: 'flex', padding: 2 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
          {error && <div style={{ color: 'var(--red, #e03131)', fontSize: 12 }}>{error}</div>}

          {matched && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-secondary)' }}>
              <div>
                {data.outlet && <strong style={{ color: 'var(--text-primary)' }}>{data.outlet}</strong>}
                {data.segment && <span style={{ marginLeft: data.outlet ? 6 : 0, fontSize: 11, textTransform: 'capitalize' }}>· {data.segment}</span>}
              </div>
              {Array.isArray(data.beats) && data.beats.length > 0 && (
                <div style={{ fontSize: 12 }}>{data.beats.slice(0, 6).join(', ')}</div>
              )}
              <div style={{ fontSize: 12 }}>
                {t('omi.published', { defaultValue: '{{n}} published', n: data.published || 0 })}
                {data.last_featured && ` · ${t('omi.lastFeatured', { defaultValue: 'last' })} ${new Date(data.last_featured).toISOString().slice(0, 10)}`}
              </div>
              {Array.isArray(data.recent) && data.recent.length > 0 && (
                <div style={{ marginTop: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {data.recent.slice(0, 3).map((r, i) => (
                    <div key={i} style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[r.client, r.title, r.status].filter(Boolean).join(' · ')}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!matched && !loading && (
            <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
              <span style={{ color: 'var(--text-tertiary)', fontSize: 12, marginRight: 'auto' }}>
                {t('omi.notInOmi', { defaultValue: 'Not in OMI yet' })}
              </span>
              <button disabled={savingContact} style={btn(false)} onClick={() => addContact('media')}>
                {t('omi.addMedia', { defaultValue: 'Add as press' })}
              </button>
              <button disabled={savingContact} style={btn(false)} onClick={() => addContact('commercial')}>
                {t('omi.addCommercial', { defaultValue: 'Add as commercial' })}
              </button>
            </div>
          )}

          {done && (
            <div style={{ fontSize: 12, color: 'var(--accent-fg)', background: 'var(--accent-dim)', padding: '6px 9px', borderRadius: 7 }}>
              ✓ {done.text}
            </div>
          )}

          {/* Log coverage */}
          {!logOpen ? (
            <div>
              <button style={btn(true)} onClick={() => setLogOpen(true)} disabled={!clients.length}>
                {t('omi.logCoverage', { defaultValue: 'Log coverage →' })}
              </button>
              {!clients.length && (
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 8 }}>
                  {t('omi.noClients', { defaultValue: 'no active clients' })}
                </span>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, borderTop: '1px solid var(--border-subtle)', paddingTop: 9 }}>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                <select value={clientId} onChange={e => setClientId(e.target.value)}
                  style={{ flex: '1 1 140px', padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 12 }}>
                  <option value="">{t('omi.pickClient', { defaultValue: 'Client…' })}</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <select value={status} onChange={e => setStatus(e.target.value)}
                  style={{ padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 12, textTransform: 'capitalize' }}>
                  {STATUS_OPTS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <input value={storyUrl} onChange={e => setStoryUrl(e.target.value)}
                placeholder={t('omi.storyUrl', { defaultValue: 'Story URL (optional)' })}
                style={{ padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 12 }} />
              <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginRight: 'auto' }}>
                  {t('omi.willExtract', { defaultValue: 'Claude fills in publication/date/story from the email' })}
                </span>
                <button style={btn(false)} onClick={() => setLogOpen(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</button>
                <button style={btn(true)} disabled={!clientId || logging} onClick={submitLog}>
                  {logging ? t('omi.logging', { defaultValue: 'Logging…' }) : t('omi.log', { defaultValue: 'Log' })}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
