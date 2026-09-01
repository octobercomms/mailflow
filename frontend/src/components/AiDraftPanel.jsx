// Reading-pane panel for auto-drafts. When Claude has drafted a reply to the open
// email (background sweep, opt-in), it waits here: read it, then "Edit & send" opens
// the normal composer prefilled so you review and send — nothing goes out on its own.
// If there's no draft yet, a quiet button drafts one on demand.
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

// Plain-text draft → safe HTML for the composer (escape, keep line breaks).
const toHtml = (text) => String(text || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\r?\n/g, '<br>');

export default function AiDraftPanel({ message, aiEnabled, onUseDraft }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(null);      // { id, body, subject } | null
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false);

  const messageId = message?.message_id;

  const load = useCallback(async () => {
    if (!messageId) return;
    setLoading(true); setError(''); setDismissed(false);
    try {
      const r = await api.aiDraftFor(messageId);
      setDraft(r.draft || null);
    } catch { setDraft(null); }
    finally { setLoading(false); }
  }, [messageId]);

  useEffect(() => { setDraft(null); load(); }, [load]);

  const generate = async () => {
    setGenerating(true); setError('');
    try {
      const r = await api.aiDraftGenerate(messageId);
      setDraft(r.draft || null);
    } catch (e) { setError(e.message || 'Could not draft a reply'); }
    finally { setGenerating(false); }
  };

  const use = async () => {
    if (!draft) return;
    onUseDraft?.(toHtml(draft.body));
    api.aiDraftSetStatus(draft.id, 'used').catch(() => {});
  };

  const dismiss = async () => {
    if (draft) api.aiDraftSetStatus(draft.id, 'dismissed').catch(() => {});
    setDismissed(true); setDraft(null);
  };

  // Sender is me / no AI configured / nothing to show → render nothing.
  if (!aiEnabled || !messageId) return null;
  if (loading) return null;
  if (dismissed) return null;

  const spark = (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z"/>
    </svg>
  );

  // No draft waiting → an unobtrusive "draft one" affordance.
  if (!draft) {
    return (
      <div style={wrap}>
        <button onClick={generate} disabled={generating} style={ghostBtn} title={t('aiDraft.generateHint', { defaultValue: 'Have Claude draft a reply in your voice' })}>
          {spark}
          <span>{generating ? t('aiDraft.drafting', { defaultValue: 'Drafting…' }) : t('aiDraft.generate', { defaultValue: 'Draft a reply with Claude' })}</span>
        </button>
        {error && <span style={{ color: 'var(--red, #e03131)', fontSize: 12 }}>{error}</span>}
      </div>
    );
  }

  return (
    <div style={{ ...wrap, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--accent-fg)', fontSize: 12.5, fontWeight: 600 }}>
        {spark}
        <span>{t('aiDraft.waiting', { defaultValue: 'Suggested reply' })}</span>
        <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>· {t('aiDraft.reviewNote', { defaultValue: 'review before sending' })}</span>
      </div>
      <div style={{
        whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-primary)',
        background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)', borderRadius: 8,
        padding: '10px 12px', maxHeight: 260, overflow: 'auto',
      }}>{draft.body}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={use} style={primaryBtn}>{t('aiDraft.edit', { defaultValue: 'Edit & send' })}</button>
        <button onClick={generate} disabled={generating} style={ghostBtn}>
          {generating ? t('aiDraft.redrafting', { defaultValue: 'Redrafting…' }) : t('aiDraft.redraft', { defaultValue: 'Redraft' })}
        </button>
        <button onClick={dismiss} style={ghostBtn}>{t('aiDraft.dismiss', { defaultValue: 'Dismiss' })}</button>
      </div>
      {error && <span style={{ color: 'var(--red, #e03131)', fontSize: 12 }}>{error}</span>}
    </div>
  );
}

const wrap = {
  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
  margin: '10px 0', padding: '10px 12px', borderRadius: 10,
  background: 'var(--accent-dim, rgba(0,0,0,0.03))', border: '1px solid var(--border-subtle)',
};
const primaryBtn = {
  padding: '6px 14px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  border: 'none', background: 'var(--accent)', color: 'var(--accent-text)',
};
const ghostBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 12px', borderRadius: 8, fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
};
