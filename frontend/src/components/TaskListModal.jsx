// AI task list — reads a folder (e.g. a "to respond" folder) via /ai/tasks and
// shows a prioritized, de-duplicated to-do list. Each task links back to the
// email it came from. Display-only (v1): no filing into GTD/Todoist yet.
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

const PRIORITY = {
  high:   { label: 'High',   color: 'var(--red, #e03131)' },
  medium: { label: 'Medium', color: 'var(--amber, #d9a520)' },
  low:    { label: 'Low',    color: 'var(--text-tertiary)' },
};

export default function TaskListModal({ accountId, folder, folderLabel, onClose, onOpenEmail }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState([]);
  const [meta, setMeta] = useState({ scanned: 0, capped: false });

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
  }, [accountId, folder]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const openTask = (task) => {
    if (task.emailId && onOpenEmail) { onOpenEmail(task.emailId); onClose(); }
  };

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
        borderRadius: 14, width: '100%', maxWidth: 560,
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
              {t('tasks.title', { defaultValue: 'Task list' })}
            </span>
            {folderLabel && (
              <span style={{
                fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap',
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}>· {folderLabel}</span>
            )}
          </div>
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

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '10px 12px', flex: 1 }}>
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '22px 10px', color: 'var(--text-secondary)', fontSize: 13 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"
                style={{ animation: 'spin 0.8s linear infinite' }}>
                <path d="M21 12a9 9 0 11-6.219-8.56"/>
              </svg>
              {t('tasks.loading', { defaultValue: 'Claude is reading your emails…' })}
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

          {!loading && !error && tasks.map((task, i) => {
            const p = PRIORITY[task.priority] || PRIORITY.medium;
            const clickable = !!task.emailId;
            return (
              <div
                key={i}
                onClick={() => openTask(task)}
                style={{
                  display: 'flex', gap: 11, padding: '11px 10px', borderRadius: 9,
                  cursor: clickable ? 'pointer' : 'default',
                  borderBottom: i < tasks.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                }}
                onMouseEnter={e => { if (clickable) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span title={p.label} style={{
                  flexShrink: 0, marginTop: 5, width: 9, height: 9, borderRadius: '50%', background: p.color,
                }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1.4 }}>
                    {task.title}
                  </div>
                  {clickable && (
                    <div style={{
                      fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {task.from} · {task.subject}
                    </div>
                  )}
                </div>
                {clickable && (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2"
                    style={{ flexShrink: 0, alignSelf: 'center' }} strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"/>
                  </svg>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        {!loading && !error && (
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
