// Clients — the knowledge layer. A living one-page brief per client that the AI keeps
// up to date from your mail, and that you can hand-edit. These briefs feed back into
// the task list and (later) reply drafting, so the assistant understands each client
// the way a colleague would. The client roster comes from the Tasks → client legend.
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

export default function ClientsView() {
  const { t } = useTranslation();
  const [clients, setClients] = useState([]);
  const [selected, setSelected] = useState(null);   // client name
  const [brief, setBrief] = useState('');
  const [meta, setMeta] = useState({ auto: true, updatedAt: null, refreshedAt: null });
  const [loadingList, setLoadingList] = useState(true);
  const [loadingBrief, setLoadingBrief] = useState(false);
  const [busy, setBusy] = useState('');             // 'save' | 'regen' | ''
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const dirty = useRef(false);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const r = await api.clientsList();
      setClients(Array.isArray(r.clients) ? r.clients : []);
      if (!selected && r.clients?.length) openClient(r.clients[0].client);
    } catch (e) { setError(e.message || 'Failed to load clients'); }
    finally { setLoadingList(false); }
  }, [selected]);

  useEffect(() => { loadList(); /* eslint-disable-next-line */ }, []);

  const openClient = async (name) => {
    setSelected(name); setLoadingBrief(true); setError(''); setNote(''); dirty.current = false;
    try {
      const r = await api.clientBriefGet(name);
      setBrief(r.brief || '');
      setMeta({ auto: r.auto, updatedAt: r.updatedAt, refreshedAt: r.refreshedAt });
    } catch (e) { setError(e.message || 'Failed to load brief'); }
    finally { setLoadingBrief(false); }
  };

  const save = async () => {
    if (!selected) return;
    setBusy('save'); setError(''); setNote('');
    try {
      const r = await api.clientBriefSave(selected, brief);
      setMeta({ auto: r.auto, updatedAt: r.updatedAt, refreshedAt: r.refreshedAt });
      dirty.current = false;
      setNote(t('clients.saved', { defaultValue: 'Saved' }));
      setTimeout(() => setNote(''), 2000);
      loadList();
    } catch (e) { setError(e.message || 'Save failed'); }
    finally { setBusy(''); }
  };

  const regenerate = async (force = false) => {
    if (!selected) return;
    setBusy('regen'); setError(''); setNote('');
    try {
      const r = await api.clientBriefRegenerate(selected, force);
      setBrief(r.brief || '');
      setMeta({ auto: r.auto, updatedAt: r.updatedAt, refreshedAt: r.refreshedAt });
      dirty.current = false;
      setNote(t('clients.regenerated', { count: r.mailScanned || 0, defaultValue: `Rebuilt from ${r.mailScanned || 0} emails` }));
      setTimeout(() => setNote(''), 3000);
      loadList();
    } catch (e) {
      if (e.status === 409 || /hand-edited/i.test(e.message || '')) {
        if (window.confirm(t('clients.overwriteConfirm', { defaultValue: 'You hand-edited this brief. Overwrite it with a fresh AI version from your mail?' }))) {
          return regenerate(true);
        }
      } else setError(e.message || 'Regenerate failed');
    } finally { setBusy(''); }
  };

  const onBriefChange = (v) => { setBrief(v); dirty.current = true; };

  return (
    <div style={{ flex: 1, height: '100%', display: 'flex', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      {/* Roster */}
      <div style={{ width: 240, flexShrink: 0, borderRight: '1px solid var(--border-subtle)', overflow: 'auto', padding: '18px 10px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', padding: '0 8px 8px' }}>
          {t('rail.clients', { defaultValue: 'Clients' })}
        </div>
        {loadingList ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: 8 }}>…</div>
        ) : clients.length === 0 ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5, padding: 8, lineHeight: 1.5 }}>
            {t('clients.emptyList', { defaultValue: 'No clients yet. Add them to the client legend in Tasks → settings.' })}
          </div>
        ) : clients.map(c => {
          const active = c.client === selected;
          return (
            <button key={c.client} onClick={() => openClient(c.client)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                padding: '7px 8px', borderRadius: 8, border: 'none', cursor: 'pointer', marginBottom: 2,
                background: active ? 'var(--accent-dim)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-primary)',
              }}>
              <span style={{ flex: 1, fontSize: 13.5, fontWeight: active ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.client}</span>
              <span title={c.hasBrief ? 'Brief ready' : 'No brief yet'} style={{
                width: 7, height: 7, borderRadius: 999, flexShrink: 0,
                background: c.hasBrief ? 'var(--accent)' : 'var(--border)',
              }} />
            </button>
          );
        })}
      </div>

      {/* Brief editor */}
      <div style={{ flex: 1, overflow: 'auto', padding: '24px 28px 80px' }}>
        {!selected ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>
            {t('clients.pick', { defaultValue: 'Pick a client to see their brief.' })}
          </div>
        ) : (
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
              <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>{selected}</h1>
              <button onClick={() => regenerate(false)} disabled={!!busy} style={btn(true)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: 5 }}>
                  <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/>
                </svg>
                {busy === 'regen' ? t('clients.rebuilding', { defaultValue: 'Reading mail…' }) : t('clients.regenerate', { defaultValue: 'Rebuild from mail' })}
              </button>
              <button onClick={save} disabled={!!busy} style={btn(false)}>
                {busy === 'save' ? t('common.saving', { defaultValue: 'Saving…' }) : t('common.save', { defaultValue: 'Save' })}
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 14 }}>
              {meta.auto === false
                ? t('clients.handEdited', { defaultValue: 'Hand-edited — Rebuild will ask before overwriting.' })
                : meta.refreshedAt
                  ? t('clients.autoMaintained', { defaultValue: 'AI-maintained from your mail.' })
                  : t('clients.notYet', { defaultValue: 'No brief yet — Rebuild from mail to create one, or type your own.' })}
              {note && <span style={{ color: 'var(--accent)', marginLeft: 8 }}>· {note}</span>}
            </div>

            {error && <div style={{ color: 'var(--red, #e03131)', fontSize: 13, marginBottom: 10 }}>{error}</div>}

            {loadingBrief ? (
              <div style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>…</div>
            ) : (
              <textarea
                value={brief}
                onChange={e => onBriefChange(e.target.value)}
                placeholder={t('clients.briefPh', { defaultValue: 'This client\'s brief — who they are, key people, current projects, open threads, preferences, key dates. Rebuild from mail to have Claude draft it for you.' })}
                style={{
                  width: '100%', boxSizing: 'border-box', minHeight: 420, resize: 'vertical',
                  fontSize: 14, lineHeight: 1.6, padding: 16, borderRadius: 12,
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const btn = (primary) => ({
  padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
  border: primary ? 'none' : '1px solid var(--border)',
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? 'var(--accent-text)' : 'var(--text-secondary)',
});
