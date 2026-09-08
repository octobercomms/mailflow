// ConversationView — a Gmail-style stacked conversation. Renders every message in a
// thread as a column of collapsible cards (older ones collapsed to a snippet, the newest
// expanded), so a user's sent reply appears at the bottom the moment the post-send
// refresh repopulates the thread. Reuses EmailBody for the body render and the shared
// composeFromMessage helpers for per-message reply/forward.
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { senderColor } from '../themes.js';
import { pendingMarkReadMap, completedMarkReadMap, setPending } from '../utils/pendingReads.js';
import { openReplyFromMessage, openForwardFromMessage } from '../utils/composeFromMessage.js';
import EmailBody from './EmailBody.jsx';

function fmtAddrList(raw) {
  try {
    const arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    return arr.map(a => a.name || a.email).filter(Boolean);
  } catch { return []; }
}

export default function ConversationView({ rootMessage, isMobile = false, defaultReplyAll = false }) {
  const { t } = useTranslation();
  const {
    threadMessages, setThreadMessages, loadingThread, setLoadingThread,
    selectedAccountId, selectedFolder, accounts, openCompose,
    updateMessage, decrementUnread, adjustCategoryCount,
  } = useStore();

  const tid = rootMessage.thread_id;
  const scrollRef = useRef(null);
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const prevNewestRef = useRef(null);
  const initialisedRef = useRef(false);

  const messages = useMemo(() => {
    const list = threadMessages[tid];
    if (!Array.isArray(list) || list.length === 0) return null;
    return [...list].sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [threadMessages, tid]);

  // Fetch the thread if it isn't already cached in the store.
  useEffect(() => {
    if (!tid) return;
    if (Array.isArray(threadMessages[tid])) return;
    let cancelled = false;
    const effectiveFolder = selectedAccountId ? selectedFolder : 'INBOX';
    setLoadingThread(tid);
    api.getThread(tid, effectiveFolder)
      .then(data => { if (!cancelled && Array.isArray(data.messages)) setThreadMessages(tid, data.messages); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingThread(null); });
    return () => { cancelled = true; };
  }, [tid]); // eslint-disable-line react-hooks/exhaustive-deps

  const markRead = useCallback((m) => {
    if (!m || m.is_read) return;
    const { markReadBehavior } = useStore.getState();
    if (markReadBehavior === 'manual') return;
    updateMessage(m.id, { is_read: true });
    decrementUnread(m.account_id);
    adjustCategoryCount(m.category, -1);
    setPending(m.id, m.account_id);
    api.bulkRead([m.id], true)
      .then(() => {
        pendingMarkReadMap.delete(m.id);
        completedMarkReadMap.set(m.id, m.account_id);
        setTimeout(() => completedMarkReadMap.delete(m.id), 10000);
      })
      .catch(() => { pendingMarkReadMap.delete(m.id); });
  }, [updateMessage, decrementUnread, adjustCategoryCount]);

  // Default expansion: newest message expanded. When a send (or sync) appends a newer
  // message, auto-expand it and mark it read so the user sees their reply land.
  useEffect(() => {
    if (!messages || messages.length === 0) return;
    const newest = messages[messages.length - 1];
    if (!initialisedRef.current) {
      initialisedRef.current = true;
      setExpandedIds(new Set([newest.id]));
      markRead(newest);
      prevNewestRef.current = newest.id;
      return;
    }
    if (prevNewestRef.current !== newest.id) {
      prevNewestRef.current = newest.id;
      setExpandedIds(prev => new Set(prev).add(newest.id));
      markRead(newest);
    }
  }, [messages, markRead]);

  const toggle = (m) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(m.id)) { next.delete(m.id); return next; }
      next.add(m.id);
      return next;
    });
    if (!expandedIds.has(m.id)) markRead(m);
  };

  const doReply = (m, replyAll) =>
    openReplyFromMessage(m, { accounts, openCompose, getMessageBody: api.getMessageBody, replyAll });
  const doForward = (m) =>
    openForwardFromMessage(m, { openCompose, getMessageBody: api.getMessageBody });

  const subject = (() => {
    const s = rootMessage.subject;
    return (s && s !== '(no subject)') ? s : t('message.noSubject');
  })();

  return (
    <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', background: 'var(--bg-primary)' }}>
      <div style={{ padding: isMobile ? '12px 0 24px' : '24px 28px' }}>
        {/* Thread subject */}
        <div style={{
          fontSize: 19, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.3,
          fontFamily: 'var(--font-display)', padding: isMobile ? '0 16px 14px' : '0 0 16px',
        }}>
          {subject}
          {messages && messages.length > 1 && (
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-tertiary)', marginLeft: 8 }}>
              {messages.length}
            </span>
          )}
        </div>

        {loadingThread === tid && !messages && (
          <div style={{ padding: '20px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="skeleton-line" style={{ height: 13, width: '62%', borderRadius: 4 }} />
            <div className="skeleton-line" style={{ height: 13, width: '88%', borderRadius: 4 }} />
            <div className="skeleton-line" style={{ height: 13, width: '75%', borderRadius: 4 }} />
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(messages || []).map((m) => {
            const expanded = expandedIds.has(m.id);
            const toArr = fmtAddrList(m.to_addresses);
            const ccArr = fmtAddrList(m.cc_addresses);
            return (
              <div key={m.id} style={{
                background: 'var(--bg-secondary)',
                borderRadius: isMobile ? 0 : 10,
                border: isMobile ? 'none' : '1px solid var(--border-subtle)',
                borderBottom: '1px solid var(--border-subtle)',
                borderLeft: m.account_color ? `3px solid ${m.account_color}` : undefined,
                overflow: 'hidden',
                opacity: m.is_read ? 1 : undefined,
              }}>
                {/* Card header — always visible; click to collapse/expand */}
                <div onClick={() => toggle(m)} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', cursor: 'pointer',
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                    background: senderColor(m.from_email || m.from_name),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 15, fontWeight: 700, color: 'white',
                  }}>
                    {(m.from_name || m.from_email || '?')[0].toUpperCase()}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: m.is_read ? 600 : 700, color: 'var(--text-primary)' }}>
                        {m.from_name || m.from_email}
                      </span>
                      {expanded && m.from_name && (
                        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>&lt;{m.from_email}&gt;</span>
                      )}
                    </div>
                    {expanded ? (
                      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
                        <span>{t('message.to')} </span>
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {toArr.length > 0 ? toArr.join(', ') : (m.account_email || m.account_name || '')}
                          {ccArr.length > 0 ? `, Cc ${ccArr.join(', ')}` : ''}
                        </span>
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {m.snippet || ''}
                      </div>
                    )}
                  </div>
                  <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                    {m.date ? format(new Date(m.date), isMobile ? 'MMM d' : 'MMM d, h:mm a') : ''}
                  </div>
                </div>

                {/* Expanded body + per-message actions */}
                {expanded && (
                  <div style={{ padding: '0 16px 14px' }}>
                    <EmailBody messageId={m.id} message={m} isMobile={isMobile} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                      <button onClick={() => doReply(m, defaultReplyAll)} style={cardBtn(true)}>
                        {defaultReplyAll ? t('message.replyAll') : t('message.reply')}
                      </button>
                      <button onClick={() => doReply(m, !defaultReplyAll)} style={cardBtn(false)}>
                        {defaultReplyAll ? t('message.reply') : t('message.replyAll')}
                      </button>
                      <button onClick={() => doForward(m)} style={cardBtn(false)}>
                        {t('message.forward')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function cardBtn(primary) {
  return {
    padding: '6px 14px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer',
    border: primary ? 'none' : '1px solid var(--border)',
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? 'var(--accent-text)' : 'var(--text-primary)',
  };
}
