// EmailBody — self-contained renderer for a single message's body. Extracted from
// MessagePane so a Gmail-style stacked conversation (ConversationView) can mount one
// per message. Owns its own body fetch (with LRU cache + retry), the iframe/div render,
// auto-height sizing, scale-to-fit, remote-image blocking, and attachments. It renders
// only the body — the sender card, subject, toolbar and unsubscribe/AI-classify banners
// stay with the parent.
import { useEffect, useLayoutEffect, useState, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';

const USE_DIV_RENDER = import.meta.env.VITE_EMAIL_DIV_RENDER === 'true';

// Lazy-load the div-renderer utilities so PostCSS is excluded from the flag-off bundle
// (mirrors MessagePane). Rollup strips these when USE_DIV_RENDER compiles to false.
let prepareEmailHtml  = null;
let injectEmailStyles = null;
let removeEmailStyles = null;
if (USE_DIV_RENDER) {
  ({ prepareEmailHtml }                    = await import('../utils/scopeEmailCss.js'));
  ({ injectEmailStyles, removeEmailStyles } = await import('../utils/emailStyleRegistry.js'));
}

// Module-level shared body cache + "load images once" set, so revisiting a message is
// instant and the opt-in survives a card unmount/remount. Shared across every EmailBody
// instance (matching the single cache MessagePane used to keep).
const bodyCache = {};       // messageId -> body
const bodyCacheOrder = [];  // insertion order, for LRU eviction (cap 50)
const imagesRequested = new Set();

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(type) {
  const t = (type || '').toLowerCase();
  const p = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75 };
  if (t.startsWith('image/')) return (
    <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
  );
  if (t === 'application/pdf') return (
    <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
  );
  if (t.includes('word') || t.includes('document')) return (
    <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
  );
  if (t.includes('sheet') || t.includes('excel') || t.includes('csv')) return (
    <svg {...p}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="10" y1="13" x2="10" y2="17"/><line x1="8" y1="15" x2="12" y2="15"/></svg>
  );
  if (t.includes('zip') || t.includes('compressed') || t.includes('archive')) return (
    <svg {...p}><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="11" x2="16" y2="11"/></svg>
  );
  if (t.startsWith('video/')) return (
    <svg {...p}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
  );
  if (t.startsWith('audio/')) return (
    <svg {...p}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
  );
  return (
    <svg {...p}><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
  );
}

function linkifyText(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.replace(
    /https?:\/\/[^\s<>"']+/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:inherit">${url}</a>`
  );
}

// props:
//   messageId  — the message to render (required)
//   message    — the message row (for the remote-image banner allow-sender/domain)
//   isMobile   — layout flag
//   onBodyLoaded(body) — optional, fires when the fetch resolves (html/text/attachments)
export default function EmailBody({ messageId, message, isMobile = false, onBodyLoaded }) {
  const { t } = useTranslation();
  const { blockRemoteImages, imageWhitelist, addToImageWhitelist, addNotification } = useStore();

  const [body, setBody] = useState(null);
  const [bodyError, setBodyError] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const [loadingBody, setLoadingBody] = useState(false);
  const [downloadingPart, setDownloadingPart] = useState(null);
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [savingAllow, setSavingAllow] = useState(false);

  const iframeRef = useRef(null);
  const roRef = useRef(null);
  const outerRef = useRef(null);
  const scaleRef = useRef(null);
  const innerRef = useRef(null);
  const emailScaleRef = useRef(1);
  const prevBlockingPolicyRef = useRef(null);
  const onBodyLoadedRef = useRef(onBodyLoaded);
  onBodyLoadedRef.current = onBodyLoaded;

  const prepared = useMemo(() => {
    if (!USE_DIV_RENDER || !body?.html) return null;
    return prepareEmailHtml(body.html, String(messageId ?? 'preview'));
  }, [body?.html, messageId]);

  // Flush the shared cache when the image-blocking policy changes (tighten → evict
  // unblocked; loosen → evict blocked), mirroring MessagePane's behaviour.
  useEffect(() => {
    const prev = prevBlockingPolicyRef.current;
    const curr = {
      blockRemoteImages,
      addrCount: (imageWhitelist?.addresses || []).length,
      domainCount: (imageWhitelist?.domains || []).length,
    };
    prevBlockingPolicyRef.current = curr;
    if (!prev) return;

    const tightened =
      (!prev.blockRemoteImages && curr.blockRemoteImages) ||
      prev.addrCount > curr.addrCount ||
      prev.domainCount > curr.domainCount;
    const loosenedGlobally = prev.blockRemoteImages && !curr.blockRemoteImages;
    const loosenedViaWhitelist = !tightened && (
      curr.addrCount > prev.addrCount || curr.domainCount > prev.domainCount
    );

    let evicted = false;
    if (tightened) {
      for (const id of Object.keys(bodyCache)) {
        if (!bodyCache[id]?.hasBlockedRemoteImages) {
          delete bodyCache[id];
          imagesRequested.delete(id);
          evicted = true;
        }
      }
    }
    if (loosenedGlobally || loosenedViaWhitelist) {
      for (const id of Object.keys(bodyCache)) {
        if (bodyCache[id]?.hasBlockedRemoteImages) {
          delete bodyCache[id];
          evicted = true;
        }
      }
    }
    if (evicted) {
      bodyCacheOrder.splice(0, bodyCacheOrder.length, ...bodyCacheOrder.filter(id => bodyCache[id]));
      setRetryKey(k => k + 1);
    }
  }, [blockRemoteImages, imageWhitelist]);

  // Body fetch + cache + auto-retry.
  useLayoutEffect(() => {
    if (!messageId) { setBody(null); setBodyError(null); setLoadingBody(false); return; }

    const wantsImages = imagesRequested.has(messageId);
    const cached = bodyCache[messageId];
    if (cached && (cached.html || cached.text)) {
      if (!wantsImages || !cached.hasBlockedRemoteImages) {
        setBody(cached); setBodyError(null); setLoadingBody(false);
        onBodyLoadedRef.current?.(cached);
        return;
      }
      delete bodyCache[messageId];
    }

    setBody(null);
    setBodyError(null);
    setLoadingBody(true);

    let cancelled = false;

    const fetchWithRetry = async (id, attemptsLeft = 2, delay = 500) => {
      try {
        return await api.getMessageBody(id, imagesRequested.has(id));
      } catch (err) {
        const isNotFound = /not found/i.test(err.message);
        const isTransient = /Command failed|Command canceled|timed out|ECONNRESET|socket hang up|EPIPE/i.test(err.message);
        if ((isNotFound || isTransient) && attemptsLeft > 0 && !cancelled) {
          await new Promise(r => setTimeout(r, delay));
          if (cancelled) throw err;
          return fetchWithRetry(id, attemptsLeft - 1, delay * 2);
        }
        throw err;
      }
    };

    fetchWithRetry(messageId)
      .then(data => {
        if (cancelled) return;
        if (data.html || data.text) {
          bodyCache[messageId] = data;
          bodyCacheOrder.push(messageId);
          if (bodyCacheOrder.length > 50) {
            const evicted = bodyCacheOrder.shift();
            delete bodyCache[evicted];
          }
        }
        setBody(data);
        onBodyLoadedRef.current?.(data);
      })
      .catch(err => { if (!cancelled) setBodyError(err.message); })
      .finally(() => { if (!cancelled) setLoadingBody(false); });

    return () => { cancelled = true; };
  }, [messageId, retryKey]);

  // Reset iframe height before painting a new message so no stale blank space shows.
  useLayoutEffect(() => {
    if (iframeRef.current) iframeRef.current.style.height = '300px';
  }, [messageId]);

  // Size the iframe to its full content height (grow-only guard prevents oscillation).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !body?.html) return;

    let rafId;
    let lastH = 0;

    const setHeight = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const el = doc.documentElement;
      const b  = doc.body;
      const h  = Math.max(
        el ? el.scrollHeight : 0,
        el ? el.offsetHeight : 0,
        b  ? b.scrollHeight  : 0,
        b  ? b.offsetHeight  : 0,
      );
      const scaled = Math.round(h * emailScaleRef.current);
      if (scaled > lastH) {
        lastH = scaled;
        iframe.style.height = scaled + 'px';
      }
    };

    const onLoaded = () => {
      emailScaleRef.current = 1;
      const doc = iframe.contentDocument;
      if (!doc) return;

      const b = doc.body;
      const h = doc.documentElement;
      if (b) {
        b.style.setProperty('height', 'auto', 'important');
        b.style.setProperty('min-height', '0', 'important');
        b.style.setProperty('overflow-y', 'hidden', 'important');
      }
      if (h) {
        h.style.setProperty('height', 'auto', 'important');
        h.style.setProperty('min-height', '0', 'important');
        h.style.setProperty('overflow-y', 'hidden', 'important');
      }

      const iframeW = iframe.offsetWidth;
      if (iframeW > 0) {
        if (b) b.style.setProperty('overflow-x', 'visible', 'important');
        if (h) h.style.setProperty('overflow-x', 'visible', 'important');
        const contentW = Math.max(h ? h.scrollWidth : 0, b ? b.scrollWidth : 0);
        if (b) b.style.removeProperty('overflow-x');
        if (h) h.style.removeProperty('overflow-x');

        const wrapper = doc.getElementById('mf-scale-wrapper');
        if (contentW > iframeW + 2) {
          const scale = iframeW / contentW;
          emailScaleRef.current = scale;
          if (wrapper) {
            wrapper.style.transform       = `scale(${scale})`;
            wrapper.style.transformOrigin = 'top left';
            wrapper.style.width           = `${contentW}px`;
          }
        }
      }

      const expandedEls = new Set();
      const dv = doc.defaultView;
      const expandScrollContainers = () => {
        if (!dv) return;
        Array.from(doc.querySelectorAll('*')).reverse().forEach(el => {
          const cs = dv.getComputedStyle(el);
          const oy = cs.overflowY;
          const isScrollContainer = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2;
          const grewAfterExpansion = expandedEls.has(el) && el.scrollHeight > el.clientHeight + 2;
          if (isScrollContainer || grewAfterExpansion) {
            expandedEls.add(el);
            el.style.setProperty('overflow-y', 'hidden', 'important');
            el.style.setProperty('max-height', 'none', 'important');
            el.style.setProperty('height', el.scrollHeight + 'px', 'important');
          }
        });
      };
      expandScrollContainers();

      lastH = 0;
      setHeight();
      rafId = requestAnimationFrame(setHeight);

      doc.addEventListener('click', (ev) => {
        const anchor = ev.target.closest('a[href]');
        if (!anchor) return;
        ev.preventDefault();
        let raw = anchor.getAttribute('href') || '';
        if (raw.startsWith('//')) raw = 'https:' + raw;
        if (/^https?:\/\//i.test(raw)) window.open(raw, '_blank', 'noopener,noreferrer');
        else if (/^mailto:/i.test(raw)) window.open(raw, '_blank', 'noopener,noreferrer');
      });

      doc.querySelectorAll('img').forEach(img => {
        if (!img.complete) {
          img.addEventListener('load', () => { expandScrollContainers(); requestAnimationFrame(setHeight); }, { once: true });
          img.addEventListener('error', () => requestAnimationFrame(setHeight), { once: true });
        }
      });

      const root = doc.body || doc.documentElement;
      if (window.ResizeObserver && root) {
        roRef.current = new ResizeObserver(() => requestAnimationFrame(setHeight));
        roRef.current.observe(root);
      }
    };

    iframe.addEventListener('load', onLoaded, { once: true });
    if (iframe.contentDocument?.readyState === 'complete') onLoaded();

    return () => {
      cancelAnimationFrame(rafId);
      if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
      iframe.removeEventListener('load', onLoaded);
      emailScaleRef.current = 1;
    };
  }, [body?.html, messageId]);

  // Inject scoped email styles before paint (div path).
  useLayoutEffect(() => {
    if (!prepared) return;
    injectEmailStyles(prepared.prefix, prepared.styleBlocks);
    return () => removeEmailStyles(prepared.prefix);
  }, [prepared]);

  // Div render path — scale-to-fit for wide fixed-layout emails.
  useEffect(() => {
    if (!USE_DIV_RENDER || !prepared) return;

    let rafId = null;
    const expandedEls = new Set();

    const expandScrollContainers = (root) => {
      if (!root) return;
      Array.from(root.querySelectorAll('*')).reverse().forEach(el => {
        const oy = window.getComputedStyle(el).overflowY;
        const isScroll = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2;
        const grew = expandedEls.has(el) && el.scrollHeight > el.clientHeight + 2;
        if (isScroll || grew) {
          expandedEls.add(el);
          el.style.setProperty('overflow-y', 'hidden', 'important');
          el.style.setProperty('max-height', 'none', 'important');
          el.style.setProperty('height', el.scrollHeight + 'px', 'important');
        }
      });
    };

    const applyScale = () => {
      const inner  = innerRef.current;
      const outer  = outerRef.current;
      const scaler = scaleRef.current;
      if (!inner || !outer || !scaler) return;

      scaler.style.transform       = '';
      scaler.style.transformOrigin = '';
      scaler.style.width           = '';
      outer.style.height    = '';
      outer.style.overflowX = '';
      outer.style.overflowY = '';

      expandScrollContainers(inner);

      const containerW = outer.clientWidth;
      const contentW   = inner.scrollWidth;

      if (containerW > 0 && contentW > containerW + 2) {
        const scale = containerW / contentW;
        scaler.style.width           = `${contentW}px`;
        scaler.style.transform       = `scale(${scale})`;
        scaler.style.transformOrigin = 'top left';
        outer.style.height           = Math.round(inner.scrollHeight * scale) + 'px';
        outer.style.overflowX        = 'hidden';
        outer.style.overflowY        = 'hidden';
      }
    };

    const scheduleScale = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => { rafId = null; applyScale(); });
    };

    const imageListeners = [];
    innerRef.current?.querySelectorAll('img').forEach(img => {
      if (!img.complete) {
        const handler = () => scheduleScale();
        img.addEventListener('load', handler, { once: true });
        imageListeners.push({ img, handler });
      }
    });

    let ro;
    if (window.ResizeObserver && innerRef.current) {
      ro = new ResizeObserver(scheduleScale);
      ro.observe(innerRef.current);
    }

    scheduleScale();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (ro) ro.disconnect();
      imageListeners.forEach(({ img, handler }) => img.removeEventListener('load', handler));
    };
  }, [prepared]);

  const handleEmailClick = (ev) => {
    const anchor = ev.target.closest('a[href]');
    if (!anchor) return;
    ev.preventDefault();
    let raw = anchor.getAttribute('href') || '';
    if (raw.startsWith('//')) raw = 'https:' + raw;
    if (/^https?:\/\//i.test(raw)) window.open(raw, '_blank', 'noopener,noreferrer');
    else if (/^mailto:/i.test(raw)) window.open(raw, '_blank', 'noopener,noreferrer');
  };

  const handleDownload = async (id, part, filename) => {
    setDownloadingPart(part);
    try {
      const res = await fetch(`/api/mail/messages/${id}/attachments/${encodeURIComponent(part)}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download error:', err);
    } finally {
      setDownloadingPart(null);
    }
  };

  // Download every attachment as a ZIP. Uses the same authenticated fetch→blob path as
  // single downloads (rather than a plain <a href download>), so it carries the session
  // cookie and isn't intercepted by the service worker / mobile WebView, and surfaces a
  // notification on failure instead of silently doing nothing.
  const handleDownloadAll = async () => {
    setDownloadingAll(true);
    try {
      const res = await fetch(`/api/mail/messages/${messageId}/attachments.zip`, { credentials: 'include' });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      // Prefer the server-provided filename; fall back to a sensible default.
      let filename = 'attachments.zip';
      const cd = res.headers.get('Content-Disposition') || '';
      const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
      const plain = cd.match(/filename="?([^";]+)"?/i);
      if (star) { try { filename = decodeURIComponent(star[1]); } catch { /* keep fallback */ } }
      else if (plain) { filename = plain[1]; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download all error:', err);
      addNotification({ title: t('message.downloadFail.title'), body: t('message.downloadFail.body') });
    } finally {
      setDownloadingAll(false);
    }
  };

  const handleLoadImages = () => {
    imagesRequested.add(messageId);
    delete bodyCache[messageId];
    setRetryKey(k => k + 1);
  };

  const evictBlockedAndRetry = () => {
    for (const id of Object.keys(bodyCache)) {
      if (bodyCache[id]?.hasBlockedRemoteImages) delete bodyCache[id];
    }
    bodyCacheOrder.splice(0, bodyCacheOrder.length, ...bodyCacheOrder.filter(id => bodyCache[id]));
    setRetryKey(k => k + 1);
  };

  const handleAllowSender = async () => {
    const senderEmail = message?.from_email?.toLowerCase();
    if (!senderEmail) return;
    setSavingAllow(true);
    try {
      await addToImageWhitelist({ type: 'address', value: senderEmail });
      evictBlockedAndRetry();
    } catch {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      setSavingAllow(false);
    }
  };

  const handleAllowDomain = async () => {
    const senderEmail = message?.from_email?.toLowerCase() || '';
    const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';
    if (!senderDomain) return;
    setSavingAllow(true);
    try {
      await addToImageWhitelist({ type: 'domain', value: senderDomain });
      evictBlockedAndRetry();
    } catch {
      addNotification({ title: t('message.whitelistFail.title'), body: t('message.whitelistFail.body') });
    } finally {
      setSavingAllow(false);
    }
  };

  const retryFetch = () => { delete bodyCache[messageId]; setRetryKey(k => k + 1); };

  const attachments = body?.attachments || [];

  return (
    <>
      {/* Attachments */}
      {attachments.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 500 }}>
              {t('message.attachment', { count: attachments.length })}
            </div>
            {attachments.length > 1 && (
              <button onClick={handleDownloadAll} disabled={downloadingAll}
                style={{ fontSize: 12, color: 'var(--accent-fg)', background: 'none', border: 'none', padding: 0,
                  cursor: downloadingAll ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                {downloadingAll ? t('message.downloading') : t('message.downloadAll')}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {attachments.map((att, i) => (
              <button key={i} onClick={() => handleDownload(messageId, att.part, att.filename)} disabled={downloadingPart === att.part}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8,
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  cursor: downloadingPart === att.part ? 'wait' : 'pointer', color: 'var(--text-primary)',
                  transition: 'background 0.1s', maxWidth: 240,
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-tertiary)'}
                onMouseLeave={e => e.currentTarget.style.background = 'var(--bg-secondary)'}>
                <span style={{ display: 'flex', flexShrink: 0, color: 'var(--text-secondary)' }}>{fileIcon(att.type)}</span>
                <div style={{ minWidth: 0, textAlign: 'left' }}>
                  <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.filename}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {downloadingPart === att.part ? t('message.downloading') : formatBytes(att.size)}
                  </div>
                </div>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" style={{ flexShrink: 0 }}>
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loadingBody && (
        <div style={{ padding: '12px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="skeleton-line" style={{ height: 13, width: '62%', borderRadius: 4 }} />
          <div className="skeleton-line" style={{ height: 13, width: '88%', borderRadius: 4 }} />
          <div className="skeleton-line" style={{ height: 13, width: '75%', borderRadius: 4 }} />
          <div className="skeleton-line" style={{ height: 13, width: '50%', borderRadius: 4 }} />
        </div>
      )}

      {/* Error */}
      {!loadingBody && bodyError && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '12px 0' }}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 20px', maxWidth: 480 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{t('message.loadingError')}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{bodyError}</div>
          </div>
          <button onClick={retryFetch}
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13 }}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {/* No content */}
      {!loadingBody && !bodyError && body && !body.html && !body.text && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12, padding: '12px 0' }}>
          <div style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>{t('message.noContent')}</div>
          <button onClick={retryFetch}
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13 }}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {/* Remote-images blocked banner */}
      {!loadingBody && !bodyError && body?.html && body.hasBlockedRemoteImages && (
        <div style={{
          marginBottom: 10, padding: '9px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
          borderLeft: '3px solid var(--accent)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10,
          flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)',
        }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-fg)" strokeWidth="2" style={{ flexShrink: 0 }}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
          <span>{t('message.remoteImagesBlocked')}</span>
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
            {[
              { label: t('message.loadImages'), handler: handleLoadImages, disabled: false },
              message?.from_email && { label: t('message.allowSender', { email: message.from_email }), handler: handleAllowSender, disabled: savingAllow },
              (message?.from_email?.includes('@')) && { label: t('message.allowDomain', { domain: message.from_email.split('@')[1] }), handler: handleAllowDomain, disabled: savingAllow },
            ].filter(Boolean).map(({ label, handler, disabled }) => (
              <button key={label} onClick={handler} disabled={disabled}
                style={{ background: 'var(--accent-dim)', border: '1px solid transparent', borderRadius: 5, padding: '3px 9px', cursor: disabled ? 'default' : 'pointer', color: 'var(--accent-text)', fontSize: 11, fontWeight: 600, opacity: disabled ? 0.5 : 1 }}
                onMouseEnter={e => { if (!disabled) e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; }}>{label}</button>
            ))}
          </div>
        </div>
      )}

      {/* HTML body */}
      {!loadingBody && !bodyError && body?.html && (
        <div style={{
          position: 'relative', padding: '14px 16px 12px', background: 'white',
          borderRadius: isMobile ? 0 : 10, border: isMobile ? 'none' : '1px solid var(--border-subtle)',
          overflow: 'hidden', contain: 'layout',
        }}>
          {USE_DIV_RENDER ? (
            <div ref={outerRef} style={{ position: 'relative', width: '100%' }} onClick={handleEmailClick}>
              <div ref={scaleRef}>
                <div ref={innerRef} data-mailflow-email={prepared?.prefix} className={prepared?.prefix ?? ''}
                  dangerouslySetInnerHTML={prepared ? { __html: prepared.html } : undefined} />
              </div>
            </div>
          ) : (
            <iframe
              ref={iframeRef}
              srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8">
              <meta name="viewport" content="width=device-width,initial-scale=1">
              <meta name="color-scheme" content="only light">
              <meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';">
              <base target="_blank">
            </head><body><div id="mf-scale-wrapper">${
              body.html.replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1')
            }</div><style>
                html, body { height: auto !important; min-height: 0 !important; overflow: hidden !important; }
                body { margin: 0 !important; padding: 0 !important;
                       background-color: #ffffff !important; color-scheme: light;
                       font-family: -apple-system, Arial, sans-serif;
                       font-size: 14px; line-height: 1.6; color: #1a1a1a;
                       word-wrap: break-word; overflow-wrap: break-word; }
                img { max-width: 100% !important; height: auto !important; }
                body > table, body > center > table,
                body > div > table, body > center > div > table,
                #mf-scale-wrapper > table, #mf-scale-wrapper > center > table,
                #mf-scale-wrapper > div > table, #mf-scale-wrapper > center > div > table {
                  width: 100% !important;
                }
                td, th { min-width: 0 !important; }
                td { word-break: break-word; }
                th { overflow-wrap: normal; word-break: normal; }
                a { color: #6366f1; }
                pre, code { overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
                blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }
              </style></body></html>`}
              scrolling="no"
              style={{ width: '1px', minWidth: '100%', border: 'none', display: 'block', height: '300px' }}
              sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
              title={t('message.emailFrameTitle')}
            />
          )}
        </div>
      )}

      {/* Plain-text body */}
      {!loadingBody && !bodyError && body?.text && !body?.html && (
        <div style={{
          margin: 0, padding: '14px 16px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontSize: 14, color: '#1a1a1a', lineHeight: 1.7, fontFamily: 'DM Sans, sans-serif',
          background: 'white', borderRadius: isMobile ? 0 : 10, border: isMobile ? 'none' : '1px solid var(--border-subtle)', overflow: 'hidden',
        }} dangerouslySetInnerHTML={{ __html: linkifyText(body.text) }} />
      )}
    </>
  );
}
