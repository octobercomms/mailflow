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
  const [brief, setBrief] = useState(null);   // { text, date, stale } | null
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefOpen, setBriefOpen] = useState(true);
  const [assist, setAssist] = useState({});   // taskId -> { loading, text, error }
  const [research, setResearch] = useState({}); // taskId -> { loading, answer, sources, webVerified, error }
  const [canResearch, setCanResearch] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());  // heading ids that are open (default: all collapsed)
  const [narrow, setNarrow] = useState(typeof window !== 'undefined' && window.innerWidth < 1000);
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

  useEffect(() => {
    api.tasksBriefGet().then(r => setBrief(r.brief || null)).catch(() => {});
    api.researchStatus().then(() => setCanResearch(true)).catch(() => {});
  }, []);

  // Approval-gated: only runs on this explicit click.
  const runResearch = async (b) => {
    setResearch(r => ({ ...r, [b.id]: { loading: true } }));
    try {
      const res = await api.research(b.text, '');
      setResearch(r => ({ ...r, [b.id]: { answer: res.answer, sources: res.sources || [], webVerified: res.webVerified } }));
    } catch (e) {
      setResearch(r => ({ ...r, [b.id]: { error: e.message || 'Research failed' } }));
    }
  };

  const briefMe = async () => {
    setBriefBusy(true);
    try {
      const r = await api.tasksBriefGenerate();
      setBrief({ text: r.brief, date: null, stale: false });
      setBriefOpen(true);
    } catch (e) { setError(e.message || 'Brief failed'); }
    finally { setBriefBusy(false); }
  };

  const toggleAssist = async (b) => {
    const cur = assist[b.id];
    if (cur && (cur.text || cur.loading)) { setAssist(a => ({ ...a, [b.id]: null })); return; }
    setAssist(a => ({ ...a, [b.id]: { loading: true } }));
    try {
      const r = await api.taskAssist(b.id);
      setAssist(a => ({ ...a, [b.id]: { text: r.suggestion, canDraft: r.canDraft, sourceRef: r.sourceRef } }));
    } catch (e) {
      setAssist(a => ({ ...a, [b.id]: { error: e.message || 'Failed' } }));
    }
  };

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

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1000);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleSection = (id) => setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const openSection = (id) => setExpanded(s => { if (s.has(id)) return s; const n = new Set(s); n.add(id); return n; });

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
      if (kind === 'heading') openSection(created.id);   // new sections start open so you can type
    } catch (e) { setError(e.message || 'Failed to add'); }
  };

  // Add a task as the last child of a section (keeps it under the heading, section open).
  const addTaskToSection = async (headingId, lastChildId) => {
    openSection(headingId);
    await addBlock('task', lastChildId || headingId);
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

  const refresh = async (rebuild = false) => {
    if (rebuild && !window.confirm(t('tasksView.rebuildConfirm', { defaultValue: 'Rebuild the list from your mail? This clears AI-generated tasks and regenerates them (your typed tasks and headings stay).' }))) return;
    setRefreshing(true); setRefreshMsg(''); setError('');
    try {
      await api.tasksRefresh(rebuild);                   // starts the background sweep
      // Poll until it finishes — a full sweep across folders can take minutes.
      const startedAt = Date.now();
      const MAX_MS = 12 * 60 * 1000;
      let status;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise(r => setTimeout(r, 3000));
        status = await api.tasksRefreshStatus();
        if (!status.running) break;
        if (Date.now() - startedAt > MAX_MS) {
          setRefreshMsg(t('tasksView.stillRunning', { defaultValue: 'Still working — check back in a moment.' }));
          setRefreshing(false);
          return;
        }
      }
      await load();
      if (status.error === 'NO_SOURCES') {
        setError(t('tasksView.noSources', { defaultValue: 'No task folders configured. Choose which accounts and folders to read in settings.' }));
      } else if (status.error) {
        setError(status.error);
      } else {
        const r = status.result || {};
        const bits = [];
        if (r.added) bits.push(t('tasksView.added', { count: r.added, defaultValue: `${r.added} new` }));
        if (r.completed) bits.push(t('tasksView.autoDone', { count: r.completed, defaultValue: `${r.completed} auto-completed` }));
        let msg = bits.length ? bits.join(' · ') : t('tasksView.upToDate', { defaultValue: 'Already up to date' });
        if (r.errors && r.errors.length) msg += ` · ${r.errors.length} folder(s) failed`;
        setRefreshMsg(msg);
        // Freshen the brief so the card reflects the just-refreshed list, not a cached
        // (possibly earlier-day) version. Best-effort — never block the refresh on it.
        api.tasksBriefGenerate().then(br => setBrief({ text: br.brief, date: null, stale: false })).catch(() => {});
      }
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

  // Group the flat block list into collapsible sections: each heading and the tasks
  // that follow it, plus any tasks typed before the first heading.
  const preTasks = [];
  const sections = [];
  {
    let cur = null;
    for (const b of blocks) {
      if (b.kind === 'heading') { cur = { heading: b, tasks: [] }; sections.push(cur); }
      else if (cur) cur.tasks.push(b);
      else preTasks.push(b);
    }
  }
  const flatIndexOf = (id) => blocks.findIndex(x => x.id === id);

  // One task row (checkbox + editable text + assist/email/remove), plus its expandable
  // assist/research panel. Shared by pre-heading tasks and section tasks.
  const taskRow = (b) => {
    const idx = flatIndexOf(b.id);
    return (
      <div key={b.id}>
        <div className="task-row"
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
          <button onClick={() => toggleAssist(b)} title={t('tasksView.assist', { defaultValue: 'How should I tackle this?' })}
            style={{ marginTop: 1, background: 'none', border: 'none', cursor: 'pointer', color: assist[b.id] ? 'var(--accent)' : 'var(--text-tertiary)', flexShrink: 0, padding: '0 2px', opacity: 0.75 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7c.6.5 1 1.3 1 2.1h6c0-.8.4-1.6 1-2.1A7 7 0 0012 2z"/></svg>
          </button>
          {b.source === 'ai' && b.source_ref && (
            <button onClick={() => openSource(b)} title={t('tasksView.openEmail', { defaultValue: 'Open source email' })}
              style={{ marginTop: 2, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', flexShrink: 0, padding: '0 2px', fontSize: 12 }}>✉</button>
          )}
          <button onClick={() => removeBlock(b, blocks[idx - 1]?.id)} style={rowDel} title="Remove">×</button>
        </div>
        {assist[b.id] && (
          <div style={{ margin: '2px 0 8px 27px', padding: '9px 12px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', fontSize: 13, lineHeight: 1.55, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
            {assist[b.id].loading ? t('tasksView.thinking', { defaultValue: 'Thinking…' })
              : assist[b.id].error ? <span style={{ color: 'var(--red, #e03131)' }}>{assist[b.id].error}</span>
              : (<>
                  {assist[b.id].text}
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {assist[b.id].canDraft && assist[b.id].sourceRef && (
                      <button onClick={() => window.open(`/?m=${encodeURIComponent(assist[b.id].sourceRef)}`, '_blank', 'noopener')} style={btnStyle(true)}>
                        {t('tasksView.openToDraft', { defaultValue: 'Open email to draft a reply' })}
                      </button>
                    )}
                    {canResearch && !research[b.id] && (
                      <button onClick={() => runResearch(b)} style={btnStyle(false)}>
                        {t('tasksView.researchThis', { defaultValue: 'Research this for me' })}
                      </button>
                    )}
                  </div>
                  {research[b.id] && (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-subtle)' }}>
                      {research[b.id].loading ? t('tasksView.researching', { defaultValue: 'Researching…' })
                        : research[b.id].error ? <span style={{ color: 'var(--red, #e03131)' }}>{research[b.id].error}</span>
                        : (<>
                            {!research[b.id].webVerified && (
                              <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 6 }}>
                                {t('tasksView.notWebVerified', { defaultValue: 'Not web-verified (no search provider configured) — from Claude\'s own knowledge.' })}
                              </div>
                            )}
                            <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>{research[b.id].answer}</div>
                            {research[b.id].sources?.length > 0 && (
                              <div style={{ marginTop: 8 }}>
                                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)', marginBottom: 3 }}>{t('tasksView.sources', { defaultValue: 'Sources' })}</div>
                                {research[b.id].sources.map((s, i) => (
                                  <div key={i} style={{ fontSize: 12, marginBottom: 2 }}>
                                    [{i + 1}] <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{s.title || s.url}</a>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>)}
                    </div>
                  )}
                </>)}
          </div>
        )}
      </div>
    );
  };

  // The task list body (sections + pre-heading tasks). Reused in both layouts.
  const taskListBody = loading ? (
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
    <div>
      {preTasks.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          {preTasks.map(taskRow)}
          <button onClick={() => addBlock('task', preTasks[preTasks.length - 1].id)} style={{ ...btnStyle(false), marginTop: 6, padding: '4px 10px', fontSize: 12 }}>
            + {t('tasksView.addTask', { defaultValue: 'Add task' })}
          </button>
        </div>
      )}
      {sections.map(sec => {
        const h = sec.heading;
        const open = expanded.has(h.id);
        const openCount = sec.tasks.filter(x => !x.done).length;
        const hIdx = flatIndexOf(h.id);
        return (
          <div key={h.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 0 10px 0' }}>
              <button onClick={() => toggleSection(h.id)} aria-label="collapse"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 0, display: 'flex', flexShrink: 0, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
              </button>
              <textarea
                ref={setRef(h.id)}
                rows={1}
                value={h.text}
                onChange={e => onText(h.id, e.target.value, e.target)}
                onKeyDown={e => onKeyDown(e, h, hIdx)}
                onFocus={() => openSection(h.id)}
                placeholder={t('tasksView.headingPh', { defaultValue: 'Client / section' })}
                style={{
                  flex: 1, border: 'none', outline: 'none', background: 'transparent', resize: 'none',
                  fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                  color: 'var(--text-secondary)', padding: '2px 0', lineHeight: 1.3, fontFamily: 'inherit', overflow: 'hidden', cursor: 'pointer',
                }}
              />
              {openCount > 0 && <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-tertiary)', background: 'var(--bg-secondary)', borderRadius: 999, padding: '1px 8px', flexShrink: 0 }}>{openCount}</span>}
              <button onClick={() => removeBlock(h, blocks[hIdx - 1]?.id)} style={rowDel} title="Remove section">×</button>
            </div>
            {open && (
              <div style={{ paddingBottom: 10, paddingLeft: 20 }}>
                {sec.tasks.length === 0
                  ? <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: '2px 0 8px' }}>{t('tasksView.sectionEmpty', { defaultValue: 'No tasks here yet.' })}</div>
                  : sec.tasks.map(taskRow)}
                <button onClick={() => addTaskToSection(h.id, sec.tasks[sec.tasks.length - 1]?.id)}
                  style={{ ...btnStyle(false), marginTop: 6, padding: '4px 10px', fontSize: 12 }}>
                  + {t('tasksView.addTask', { defaultValue: 'Add task' })}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const briefPanel = brief && brief.text && briefOpen ? (
    <div style={{ padding: '14px 16px', borderRadius: 12, background: 'var(--accent-dim, rgba(0,0,0,0.03))', border: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
        </svg>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', flex: 1 }}>
          {t('tasksView.today', { defaultValue: 'Your brief' })}
          {brief.stale && <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}> · {t('tasksView.briefStale', { defaultValue: 'from an earlier day — “Brief me” to refresh' })}</span>}
        </span>
        <button onClick={() => setBriefOpen(false)} style={rowDel} title="Hide">×</button>
      </div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6, color: 'var(--text-primary)' }}>{brief.text}</div>
    </div>
  ) : null;

  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
        {t('tasksView.title', { defaultValue: 'Tasks' })}
      </h1>
      <button onClick={() => refresh(false)} disabled={refreshing} style={{ ...btnStyle(true), display: 'inline-flex', alignItems: 'center', gap: 6 }} title={t('tasksView.refreshHint', { defaultValue: 'Read your mail folders and add new tasks' })}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/>
        </svg>
        {refreshing ? t('tasksView.refreshing', { defaultValue: 'Reading mail…' }) : t('tasksView.refresh', { defaultValue: 'Refresh from mail' })}
      </button>
      <button onClick={() => refresh(true)} disabled={refreshing} style={btnStyle(false)} title={t('tasksView.rebuildHint', { defaultValue: 'Clear AI tasks and regenerate the list from scratch' })}>
        {t('tasksView.rebuild', { defaultValue: 'Rebuild' })}
      </button>
      <button onClick={briefMe} disabled={briefBusy} style={btnStyle(false)} title={t('tasksView.briefHint', { defaultValue: 'Get your morning brief' })}>
        {briefBusy ? t('tasksView.briefing', { defaultValue: 'Briefing…' }) : t('tasksView.briefMe', { defaultValue: 'Brief me' })}
      </button>
      <button onClick={() => setShowSettings(s => !s)} style={{ ...btnStyle(showSettings), display: 'inline-flex', alignItems: 'center' }} title={t('tasksView.settings', { defaultValue: 'Task settings' })}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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
  );

  return (
    <div style={{ flex: 1, height: '100%', display: 'flex', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      {/* Left column: the brief (wide screens only) */}
      {!narrow && briefPanel && (
        <div style={{ width: 340, flexShrink: 0, height: '100%', overflow: 'auto', borderRight: '1px solid var(--border-subtle)', padding: '24px 18px' }}>
          {briefPanel}
        </div>
      )}

      {/* Center column: tasks */}
      <div style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'auto' }}>
        <div style={{ maxWidth: 780, margin: '0 auto', padding: '24px 28px 120px' }}>
          {toolbar}
          {refreshMsg && <div style={{ color: 'var(--accent)', fontSize: 12.5, marginBottom: 12 }}>{refreshMsg}</div>}
          {error && <div style={{ color: 'var(--red, #e03131)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
          {narrow && briefPanel && <div style={{ marginBottom: 18 }}>{briefPanel}</div>}
          {narrow && showSettings && <div style={{ marginBottom: 18 }}><TaskSettings onClose={() => setShowSettings(false)} /></div>}
          <div style={{ marginTop: 8 }}>{taskListBody}</div>
        </div>
      </div>

      {/* Right column: settings (wide screens only) */}
      {!narrow && showSettings && (
        <div style={{ width: 380, flexShrink: 0, height: '100%', overflow: 'auto', borderLeft: '1px solid var(--border-subtle)', padding: '24px 18px', background: 'var(--bg-primary)' }}>
          <TaskSettings onClose={() => setShowSettings(false)} embedded />
        </div>
      )}
    </div>
  );
}
// ── Task settings: which accounts + folders the AI refresh reads, and the client legend.
function TaskSettings({ onClose }) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState([]);
  const [sources, setSources] = useState({});     // { accountId: { enabled, folders: [] } }
  const [legend, setLegend] = useState('');
  const [auto, setAuto] = useState({ enabled: false, hour: 8, tz: null });
  const [autoDrafts, setAutoDrafts] = useState({ enabled: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })();

  useEffect(() => {
    (async () => {
      try {
        const [s, l] = await Promise.all([api.tasksSources(), api.aiTaskLegend()]);
        setAccounts(Array.isArray(s.accounts) ? s.accounts : []);
        setSources(s.sources || {});
        setAuto({ enabled: !!s.autoRefresh?.enabled, hour: Number.isInteger(s.autoRefresh?.hour) ? s.autoRefresh.hour : 8, tz: s.autoRefresh?.tz || null });
        setAutoDrafts({ enabled: !!s.autoDrafts?.enabled });
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
      const autoPayload = { ...auto, tz: auto.tz || browserTz || null };
      await Promise.all([api.tasksSaveSources(sources, autoPayload, autoDrafts), api.aiSetTaskLegend(legend)]);
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

          {/* Daily auto-refresh */}
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={auto.enabled} onChange={e => setAuto(a => ({ ...a, enabled: e.target.checked }))} />
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                {t('tasksView.autoTitle', { defaultValue: 'Refresh automatically every morning' })}
              </span>
            </label>
            {auto.enabled && (
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 8, paddingLeft: 24, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>{t('tasksView.autoAt', { defaultValue: 'Each day at' })}</span>
                <select value={auto.hour} onChange={e => setAuto(a => ({ ...a, hour: Number(e.target.value) }))}
                  style={{ fontSize: 12.5, padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                  ))}
                </select>
                <span style={{ color: 'var(--text-tertiary)' }}>{auto.tz || browserTz}</span>
              </div>
            )}
          </div>

          {/* Background auto-drafts */}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-subtle)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoDrafts.enabled} onChange={e => setAutoDrafts({ enabled: e.target.checked })} />
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                {t('tasksView.draftsTitle', { defaultValue: 'Draft replies for me in the background' })}
              </span>
            </label>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 6, paddingLeft: 24, lineHeight: 1.5 }}>
              {t('tasksView.draftsHelp', { defaultValue: 'Through the day, Claude drafts a reply (in your voice) to new mail in your task folders. A suggestion waits in the reading pane — nothing is ever sent until you review and send it.' })}
            </div>
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
