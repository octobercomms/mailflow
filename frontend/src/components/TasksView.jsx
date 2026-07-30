// Native task list — a restricted Notion-style outline: two block kinds, "heading"
// (a client/section) and "task" (a checkbox item). Type straight into it: Enter makes
// a new task, Backspace on an empty block removes it, the checkbox ticks a task off.
// Persists per block via the /tasks API. The AI "refresh from mail" (this file's
// toolbar) and the daily cron write into the same store — generated tasks land under
// their client heading and carry a link back to the source email.
import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

// Grow a textarea to fit its content (Notion-style wrapping lines).
const autoSize = (el) => { if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } };

export default function TasksView() {
  const { t } = useTranslation();
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const inputRefs = useRef(new Map());        // id -> textarea element
  const focusRef = useRef(null);              // { id, atEnd } to focus after render
  const saveTimers = useRef(new Map());       // id -> debounce timer

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await api.tasksList();
      setBlocks(Array.isArray(data.tasks) ? data.tasks : []);
    } catch (e) { setError(e.message || 'Failed to load tasks'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Focus a freshly-created / navigated-to block after render.
  useEffect(() => {
    if (!focusRef.current) return;
    const { id, atEnd } = focusRef.current;
    const el = inputRefs.current.get(id);
    if (el) {
      el.focus();
      if (atEnd) { const v = el.value; el.setSelectionRange(v.length, v.length); }
    }
    focusRef.current = null;
  });

  // Size every textarea whenever the list changes (load, refresh, edits).
  useEffect(() => { inputRefs.current.forEach(autoSize); }, [blocks]);

  const patchLocal = (id, patch) => setBlocks(bs => bs.map(b => b.id === id ? { ...b, ...patch } : b));

  // Debounced text save.
  const saveText = (id, text) => {
    const timers = saveTimers.current;
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => {
      api.taskUpdate(id, { text }).catch(() => {});
      timers.delete(id);
    }, 500));
  };

  const onText = (id, text, el) => { patchLocal(id, { text }); saveText(id, text); autoSize(el); };

  const toggleDone = async (b) => {
    patchLocal(b.id, { done: !b.done });
    try { await api.taskUpdate(b.id, { done: !b.done }); } catch { patchLocal(b.id, { done: b.done }); }
  };

  const addBlock = async (kind, afterId) => {
    try {
      const created = await api.taskCreate({ kind, afterId });
      setBlocks(bs => {
        if (!afterId) return [...bs, created];
        const i = bs.findIndex(b => b.id === afterId);
        const copy = bs.slice();
        copy.splice(i + 1, 0, created);
        return copy;
      });
      focusRef.current = { id: created.id, atEnd: false };
    } catch (e) { setError(e.message || 'Failed to add'); }
  };

  const removeBlock = async (b, focusPrevId) => {
    setBlocks(bs => bs.filter(x => x.id !== b.id));
    if (focusPrevId) focusRef.current = { id: focusPrevId, atEnd: true };
    try { await api.taskDelete(b.id); } catch {}
  };

  const onKeyDown = (e, b, idx) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addBlock('task', b.id);          // Enter always starts a new task line
    } else if (e.key === 'Backspace' && e.target.value === '') {
      e.preventDefault();
      const prev = blocks[idx - 1];
      removeBlock(b, prev ? prev.id : null);
    } else if (e.key === 'ArrowUp' && blocks[idx - 1]) {
      const el = inputRefs.current.get(blocks[idx - 1].id);
      if (el) { e.preventDefault(); el.focus(); }
    } else if (e.key === 'ArrowDown' && blocks[idx + 1]) {
      const el = inputRefs.current.get(blocks[idx + 1].id);
      if (el) { e.preventDefault(); el.focus(); }
    }
  };

  const clearDone = async () => {
    await api.tasksClearDone().catch(() => {});
    load();
  };

  const refresh = async () => {
    setRefreshing(true); setRefreshMsg(''); setError('');
    try {
      const r = await api.tasksRefresh();
      await load();
      const bits = [];
      if (r.added) bits.push(t('tasksView.added', { count: r.added, defaultValue: `${r.added} new` }));
      if (r.completed) bits.push(t('tasksView.autoDone', { count: r.completed, defaultValue: `${r.completed} auto-completed` }));
      let msg = bits.length ? bits.join(' · ') : t('tasksView.upToDate', { defaultValue: 'Already up to date' });
      if (r.errors && r.errors.length) msg += ` · ${r.errors.length} folder(s) failed`;
      setRefreshMsg(msg);
    } catch (e) {
      setError(e.message || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  // Open the source email in a new tab (?m= resolves by Message-ID first, so it works
  // even after the email was moved). Keeps the task list open behind it.
  const openSource = (b) => {
    const id = b.source_ref;
    if (id) window.open(`/?m=${encodeURIComponent(id)}`, '_blank', 'noopener');
  };

  const setRef = (id) => (el) => {
    if (el) { inputRefs.current.set(id, el); autoSize(el); }
    else inputRefs.current.delete(id);
  };

  return (
    <div style={{ flex: 1, height: '100%', overflow: 'auto', background: 'var(--bg-primary)' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '28px 28px 120px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
            {t('tasksView.title', { defaultValue: 'Tasks' })}
          </h1>
          <button onClick={refresh} disabled={refreshing} style={btnStyle(true)} title={t('tasksView.refreshHint', { defaultValue: 'Read your mail folders and add tasks' })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px', marginRight: 5 }}>
              <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/>
            </svg>
            {refreshing ? t('tasksView.refreshing', { defaultValue: 'Reading mail…' }) : t('tasksView.refresh', { defaultValue: 'Refresh from mail' })}
          </button>
          <button onClick={() => setShowSettings(s => !s)} style={btnStyle(false)} title={t('tasksView.settings', { defaultValue: 'Task settings' })}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-3px' }}>
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </button>
          <button onClick={() => addBlock('heading', blocks.length ? blocks[blocks.length - 1].id : undefined)} style={btnStyle(false)}>
            + {t('tasksView.heading', { defaultValue: 'Client heading' })}
          </button>
          <button onClick={clearDone} style={btnStyle(false)}>
            {t('tasksView.clearDone', { defaultValue: 'Clear completed' })}
          </button>
        </div>

        {refreshMsg && <div style={{ color: 'var(--accent)', fontSize: 12.5, marginBottom: 12 }}>{refreshMsg}</div>}
        {error && <div style={{ color: 'var(--red, #e03131)', fontSize: 13, marginBottom: 12 }}>{error}</div>}

        {showSettings && <TaskSettings onClose={() => setShowSettings(false)} />}

        {loading ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 14 }}>…</div>
        ) : blocks.length === 0 ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 14, lineHeight: 1.6, marginTop: 12 }}>
            {t('tasksView.empty', { defaultValue: 'Your task list is empty.' })}
            <div style={{ marginTop: 12 }}>
              <button onClick={() => addBlock('task')} style={btnStyle(true)}>
                + {t('tasksView.firstTask', { defaultValue: 'Add a task' })}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            {blocks.map((b, idx) => b.kind === 'heading' ? (
              <div key={b.id} style={{ margin: idx === 0 ? '0 0 4px' : '22px 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <textarea
                  ref={setRef(b.id)}
                  rows={1}
                  value={b.text}
                  onChange={e => onText(b.id, e.target.value, e.target)}
                  onKeyDown={e => onKeyDown(e, b, idx)}
                  placeholder={t('tasksView.headingPh', { defaultValue: 'Client / section' })}
                  style={{
                    flex: 1, border: 'none', outline: 'none', background: 'transparent', resize: 'none',
                    fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                    color: 'var(--text-tertiary)', padding: '4px 0', lineHeight: 1.3, fontFamily: 'inherit',
                    overflow: 'hidden',
                  }}
                />
                <button onClick={() => removeBlock(b, blocks[idx - 1]?.id)} style={rowDel} title="Remove">×</button>
              </div>
            ) : (
              <div key={b.id} className="task-row"
                style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '5px 0', borderRadius: 6 }}>
                <button onClick={() => toggleDone(b)} aria-label="toggle"
                  style={{
                    marginTop: 3, width: 17, height: 17, flexShrink: 0, borderRadius: 5, cursor: 'pointer',
                    border: `1.5px solid ${b.done ? 'var(--accent)' : 'var(--border)'}`,
                    background: b.done ? 'var(--accent)' : 'transparent',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
                  }}>
                  {b.done && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent-text)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                </button>
                <textarea
                  ref={setRef(b.id)}
                  rows={1}
                  value={b.text}
                  onChange={e => onText(b.id, e.target.value, e.target)}
                  onKeyDown={e => onKeyDown(e, b, idx)}
                  placeholder={t('tasksView.taskPh', { defaultValue: 'Task…' })}
                  style={{
                    flex: 1, border: 'none', outline: 'none', background: 'transparent', resize: 'none',
                    fontSize: 14.5, lineHeight: 1.45, padding: '1px 0', fontFamily: 'inherit', overflow: 'hidden',
                    color: b.done ? 'var(--text-tertiary)' : 'var(--text-primary)',
                    textDecoration: b.done ? 'line-through' : 'none',
                  }}
                />
                {b.source === 'ai' && b.source_ref && (
                  <button onClick={() => openSource(b)} title={t('tasksView.openEmail', { defaultValue: 'Open source email' })}
                    style={{ marginTop: 2, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', flexShrink: 0, padding: '0 2px', fontSize: 12 }}>✉</button>
                )}
                <button onClick={() => removeBlock(b, blocks[idx - 1]?.id)} style={rowDel} title="Remove">×</button>
              </div>
            ))}
            <button onClick={() => addBlock('task', blocks[blocks.length - 1]?.id)}
              style={{ ...btnStyle(false), marginTop: 12 }}>
              + {t('tasksView.addTask', { defaultValue: 'Add task' })}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Task settings: which accounts + folders the AI refresh reads, and the client legend.
function TaskSettings({ onClose }) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState([]);
  const [sources, setSources] = useState({});     // { accountId: { enabled, folders: [] } }
  const [legend, setLegend] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [s, l] = await Promise.all([api.tasksSources(), api.aiTaskLegend()]);
        setAccounts(Array.isArray(s.accounts) ? s.accounts : []);
        setSources(s.sources || {});
        setLegend(l.legend || '');
      } catch (e) { setErr(e.message || 'Failed to load settings'); }
      finally { setLoading(false); }
    })();
  }, []);

  const cfgFor = (id) => sources[id] || { enabled: false, folders: [] };
  const setCfg = (id, patch) => setSources(s => ({ ...s, [id]: { ...cfgFor(id), ...patch } }));
  const toggleAccount = (id) => setCfg(id, { enabled: !cfgFor(id).enabled });
  const toggleFolder = (id, path) => {
    const cur = cfgFor(id).folders || [];
    const next = cur.includes(path) ? cur.filter(f => f !== path) : [...cur, path];
    setCfg(id, { folders: next, enabled: true });
  };

  const save = async () => {
    setSaving(true); setErr(''); setSaved(false);
    try {
      await Promise.all([api.tasksSaveSources(sources), api.aiSetTaskLegend(legend)]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 18, marginBottom: 20, background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
          {t('tasksView.settingsTitle', { defaultValue: 'What should Refresh read?' })}
        </div>
        <button onClick={onClose} style={rowDel} title="Close">×</button>
      </div>

      {loading ? <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>…</div> : (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12, lineHeight: 1.5 }}>
            {t('tasksView.settingsHelp', { defaultValue: 'Tick each account you want read, then choose its to-do folder(s). Refresh turns those emails into tasks; when you file an email out of the folder, its task auto-completes.' })}
          </div>

          {accounts.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No accounts.</div>}

          {accounts.map(a => {
            const cfg = cfgFor(a.id);
            return (
              <div key={a.id} style={{ marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
                  <input type="checkbox" checked={!!cfg.enabled} onChange={() => toggleAccount(a.id)} />
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{a.email}</span>
                </label>
                {cfg.enabled && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingLeft: 24 }}>
                    {a.folders.map(f => {
                      const on = (cfg.folders || []).includes(f.path);
                      return (
                        <button key={f.path} onClick={() => toggleFolder(a.id, f.path)}
                          style={{
                            fontSize: 12, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                            border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                            background: on ? 'var(--accent-dim)' : 'transparent',
                            color: on ? 'var(--accent)' : 'var(--text-secondary)',
                          }}>
                          {f.name || f.path}
                        </button>
                      );
                    })}
                    {a.folders.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No folders synced yet.</span>}
                  </div>
                )}
              </div>
            );
          })}

          {/* Client legend */}
          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
              {t('tasksView.legendTitle', { defaultValue: 'Client legend' })}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 6, lineHeight: 1.5 }}>
              {t('tasksView.legendHelp', { defaultValue: 'One client per line, e.g. "Eliza (Marylebone): eliza@…, marylebone". Groups tasks under real client names.' })}
            </div>
            <textarea
              value={legend}
              onChange={e => setLegend(e.target.value)}
              placeholder={'Eliza (Marylebone): eliza@example.com, marylebone\nLOLO – Abu Dhabi: lolo, abudhabi'}
              rows={5}
              style={{
                width: '100%', boxSizing: 'border-box', fontSize: 12.5, lineHeight: 1.5, padding: 8,
                border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-primary)',
                color: 'var(--text-primary)', resize: 'vertical', fontFamily: 'inherit',
              }}
            />
          </div>

          {err && <div style={{ color: 'var(--red, #e03131)', fontSize: 12.5, marginTop: 8 }}>{err}</div>}
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={save} disabled={saving} style={btnStyle(true)}>
              {saving ? t('common.saving', { defaultValue: 'Saving…' }) : t('common.save', { defaultValue: 'Save' })}
            </button>
            {saved && <span style={{ fontSize: 12.5, color: 'var(--accent)' }}>{t('common.saved', { defaultValue: 'Saved' })}</span>}
          </div>
        </>
      )}
    </div>
  );
}

const btnStyle = (primary) => ({
  padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
  border: primary ? 'none' : '1px solid var(--border)',
  background: primary ? 'var(--accent)' : 'transparent',
  color: primary ? 'var(--accent-text)' : 'var(--text-secondary)',
});
const rowDel = {
  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)',
  fontSize: 16, lineHeight: 1, padding: '0 2px', opacity: 0.5,
};
