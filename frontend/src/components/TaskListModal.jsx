// AI task list — reads a folder (e.g. a "to respond" folder) via /ai/tasks and
// shows a prioritized to-do digest, grouped by client/project, each task carrying
// a one-line context detail and a link back to the source email. A "Copy" button
// exports the whole digest as Markdown so it can be pasted straight into Notion.
// A "Clients" editor lets the user maintain the legend that drives the grouping.
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

const PRIORITY = {
  high:   { label: 'High',   color: 'var(--red, #e03131)', md: '🔴' },
  medium: { label: 'Medium', color: 'var(--amber, #d9a520)', md: '🟡' },
  low:    { label: 'Low',    color: 'var(--text-tertiary)', md: '⚪' },
};
const RANK = { high: 0, medium: 1, low: 2 };

const LEGEND_PLACEHOLDER =
  'Falcon Enamelware: falconenamelware.com, falcon, kam\n' +
  'LOLO: lolo, abu dhabi, laurent\n' +
  'Another Country: anothercountry.co.uk, briar, catherine\n' +
  'Goldfinger: goldfinger, deborah, donate page';

// Group tasks by their `group`, keep priority order within a group, and order the
// groups by their most urgent task so the important clients float to the top.
function groupTasks(tasks) {
  const groups = new Map();
  tasks.forEach(t => {
    const key = t.group || 'General';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });
  const out = [...groups.entries()].map(([name, items]) => ({
    name,
    items,
    top: Math.min(...items.map(i => RANK[i.priority] ?? 1)),
  }));
  // Push "Other"/"General" catch-alls to the bottom, otherwise most-urgent first.
  const isCatchAll = n => /^(other|general)$/i.test(n);
  out.sort((a, b) =>
    (isCatchAll(a.name) ? 1 : 0) - (isCatchAll(b.name) ? 1 : 0) ||
    a.top - b.top || a.name.localeCompare(b.name));
  return out;
}

function toMarkdown(grouped, folderLabel) {
  const lines = [`# Task list${folderLabel ? ` — ${folderLabel}` : ''}`, ''];
  grouped.forEach(g => {
    lines.push(`## ${g.name}`);
    g.items.forEach(t => {
      const p = PRIORITY[t.priority] || PRIORITY.medium;
      const detail = t.detail ? ` — ${t.detail}` : '';
      lines.push(`- ${p.md} **${t.title}**${detail}`);
    });
    lines.push('');
  });
  return lines.join('\n').trim() + '\n';
}

export default function TaskListModal({ accountId, folder, folderLabel, onClose, onOpenEmail }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState([]);
  const [meta, setMeta] = useState({ scanned: 0, capped: false });
  const [copied, setCopied] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // Client-legend editor state.
  const [editing, setEditing] = useState(false);
  const [legend, setLegend] = useState('');
  const [legendLoaded, setLegendLoaded] = useState(false);
  const [savingLegend, setSavingLegend] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    api.aiTasks(accountId, folder)
      .then(data => {
        if (!alive) return;
        setTasks(Array.isArray(data.tasks) ? data.tasks : []);
        setMeta({ scanned: data.scanned || 0, capped: !!data.capped });
      })
      .catch(err => { if (alive) setError(err.message || 'Failed to generate the task list'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [accountId, folder, reloadToken]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { if (editing) setEditing(false); else onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  const grouped = useMemo(() => groupTasks(tasks), [tasks]);

  const openTask = (task) => {
    if (task.emailId && onOpenEmail) { onOpenEmail(task.emailId); onClose(); }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(grouped, folderLabel));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — silently ignore */ }
  };

  const openEditor = async () => {
    setEditing(true);
    if (!legendLoaded) {
      try {
        const data = await api.aiTaskLegend();
        setLegend(data.legend || '');
      } catch { /* leave blank */ }
      setLegendLoaded(true);
    }
  };

  const saveLegend = async () => {
    setSavingLegend(true);
    try {
      await api.aiSetTaskLegend(legend);
      setEditing(false);
      setReloadToken(x => x + 1);   // regenerate the digest with the new grouping
    } catch (err) {
      setError(err.message || 'Failed to save clients');
      setEditing(false);
    } finally {
      setSavingLegend(false);
    }
  };

  const iconBtn = (active) => ({
    display: 'flex', alignItems: 'center', gap: 6,
    background: active ? 'var(--accent-dim)' : 'none',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: 7, padding: '5px 10px', cursor: 'pointer',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    fontSize: 12, fontWeight: 500, transition: 'all 0.15s',
  });

  return (
    <div
      onClick={e => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 3000, padding: 24,
      }}
    >
      <div style={{
        background: 'var(--bg-secondary)', border: '1px solid var(--border)',
        borderRadius: 14, width: '100%', maxWidth: 620,
        boxShadow: 'var(--shadow-modal)', overflow: 'hidden',
        maxHeight: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 18px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/>
              <path d="M19 14.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>
            </svg>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              {editing
                ? t('tasks.clientsTitle', { defaultValue: 'Clients' })
                : t('tasks.title', { defaultValue: 'Task list' })}
            </span>
            {!editing && folderLabel && (
              <span style={{
                fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}>· {folderLabel}</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            {!editing && (
              <button onClick={openEditor} title={t('tasks.editClients', { defaultValue: 'Edit clients used for grouping' })} style={iconBtn(false)}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                {t('tasks.clients', { defaultValue: 'Clients' })}
              </button>
            )}
            {!editing && !loading && !error && tasks.length > 0 && (
              <button onClick={handleCopy} title={t('tasks.copy', { defaultValue: 'Copy as Markdown (for Notion)' })} style={iconBtn(copied)}>
                {copied ? (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    {t('tasks.copied', { defaultValue: 'Copied' })}
                  </>
                ) : (
                  <>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                    {t('tasks.copy', { defaultValue: 'Copy' })}
                  </>
                )}
              </button>
            )}
            <button
              onClick={onClose}
              aria-label={t('common.close', { defaultValue: 'Close' })}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 4, display: 'flex' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Client legend editor */}
        {editing && (
          <>
            <div style={{ overflowY: 'auto', padding: '14px 16px', flex: 1 }}>
              <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {t('tasks.clientsHelp', {
                  defaultValue: 'One client per line, then a colon and the terms that identify it — domains, people, or project/brand names. The task list groups every email under the matching client.',
                })}
              </p>
              <textarea
                value={legend}
                onChange={e => setLegend(e.target.value)}
                placeholder={LEGEND_PLACEHOLDER}
                spellCheck={false}
                style={{
                  width: '100%', boxSizing: 'border-box', minHeight: 240, resize: 'vertical',
                  padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)',
                  background: 'var(--bg-primary)', color: 'var(--text-primary)',
                  fontSize: 13, lineHeight: 1.6, outline: 'none',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              />
              <p style={{ margin: '8px 2px 0', fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                {t('tasks.clientsExample', {
                  defaultValue: 'Example — "LOLO: lolo, abu dhabi, laurent" files anything mentioning LOLO, Abu Dhabi or Laurent under the LOLO client.',
                })}
              </p>
            </div>
            <div style={{
              display: 'flex', justifyContent: 'flex-end', gap: 8,
              padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0,
            }}>
              <button
                onClick={() => setEditing(false)}
                style={{ padding: '7px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}
              >
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </button>
              <button
                onClick={saveLegend}
                disabled={savingLegend}
                style={{ padding: '7px 16px', borderRadius: 7, border: 'none', background: 'var(--accent)', color: 'var(--accent-text)', cursor: savingLegend ? 'default' : 'pointer', fontSize: 13, fontWeight: 500, opacity: savingLegend ? 0.7 : 1 }}
              >
                {savingLegend
                  ? t('tasks.savingClients', { defaultValue: 'Saving…' })
                  : t('tasks.saveClients', { defaultValue: 'Save & regenerate' })}
              </button>
            </div>
          </>
        )}

        {/* Task list body */}
        {!editing && (
          <div style={{ overflowY: 'auto', padding: '8px 12px 12px', flex: 1 }}>
            {loading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '22px 10px', color: 'var(--text-secondary)', fontSize: 13 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"
                  style={{ animation: 'spin 0.8s linear infinite' }}>
                  <path d="M21 12a9 9 0 11-6.219-8.56"/>
                </svg>
                {t('tasks.loading', { defaultValue: 'Claude is reading the full emails — the first run can take a minute…' })}
              </div>
            )}

            {!loading && error && (
              <div style={{ fontSize: 13, color: 'var(--red, #e03131)', padding: '12px', borderRadius: 8, background: 'rgba(224,49,49,0.08)', lineHeight: 1.5 }}>
                {error}
              </div>
            )}

            {!loading && !error && tasks.length === 0 && (
              <div style={{ padding: '26px 12px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
                {t('tasks.empty', { defaultValue: 'Nothing here needs an action — you’re clear. 🎉' })}
              </div>
            )}

            {!loading && !error && grouped.map((group) => (
              <div key={group.name} style={{ marginTop: 10 }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                  color: 'var(--text-tertiary)', padding: '4px 10px 6px',
                }}>
                  {group.name}
                </div>
                {group.items.map((task, i) => {
                  const p = PRIORITY[task.priority] || PRIORITY.medium;
                  const clickable = !!task.emailId;
                  return (
                    <div
                      key={i}
                      onClick={() => openTask(task)}
                      style={{
                        display: 'flex', gap: 11, padding: '10px 10px', borderRadius: 9,
                        cursor: clickable ? 'pointer' : 'default',
                      }}
                      onMouseEnter={e => { if (clickable) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span title={p.label} style={{
                        flexShrink: 0, marginTop: 5, width: 9, height: 9, borderRadius: '50%', background: p.color,
                      }} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                          {task.title}
                        </div>
                        {task.detail && (
                          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45 }}>
                            {task.detail}
                          </div>
                        )}
                        {clickable && (
                          <div style={{
                            fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 4,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {task.from} · {task.subject}
                          </div>
                        )}
                      </div>
                      {clickable && (
                        <span
                          title={t('tasks.openThread', { defaultValue: 'Open the email thread' })}
                          style={{ flexShrink: 0, alignSelf: 'center', display: 'flex', color: 'var(--text-tertiary)' }}
                          onMouseEnter={e => { e.currentTarget.style.color = 'var(--accent)'; }}
                          onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-tertiary)'; }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                            strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                          </svg>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        {!editing && !loading && !error && (
          <div style={{
            padding: '10px 16px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0,
            fontSize: 11.5, color: 'var(--text-tertiary)', display: 'flex', justifyContent: 'space-between',
          }}>
            <span>
              {t('tasks.footer', {
                defaultValue: '{{tasks}} task(s) from {{scanned}} email(s)',
                tasks: tasks.length, scanned: meta.scanned,
              })}
            </span>
            {meta.capped && (
              <span>{t('tasks.capped', { defaultValue: 'newest 120 scanned' })}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
