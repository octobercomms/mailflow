import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';

// ── October Marketing Intelligence (OMI) PR integration ───────────────────────
// October Mail's reading pane surfaces the OMI "PR Gmail add-on" workflow for any
// staff member: look up the sender's journalist/contact profile, capture an unknown
// sender as a contact, and log a thread to a client's editorial log. We proxy to
// OMI's /api/pr-addon endpoints server-side so the shared X-OMI-Key never reaches
// the browser. Config (base URL + key) is admin-set, stored like the AI config.

const router = Router();
const CFG_KEY = 'omi_config';

async function loadConfig() {
  const r = await query('SELECT value FROM system_settings WHERE key = $1', [CFG_KEY]);
  if (!r.rows.length) return null;
  try { return JSON.parse(r.rows[0].value); } catch { return null; }
}

function isReady(cfg) {
  return !!(cfg && cfg.enabled && cfg.baseUrl && cfg.apiKey);
}

// Forward a request to OMI's PR add-on API with the stored key. Returns the parsed
// JSON body and upstream status so the caller can relay both.
async function omiFetch(cfg, method, path, { search, body } = {}) {
  // Tolerate a base URL that already includes the API path — people naturally paste
  // the full add-on URL. Strip a trailing /api/pr-addon (or /api) so we never double it.
  const base = cfg.baseUrl.replace(/\/+$/, '').replace(/\/api(\/pr-addon)?\/?$/i, '').replace(/\/+$/, '');
  const url = `${base}/api/pr-addon${path}${search ? `?${search}` : ''}`;
  const key = decrypt(cfg.apiKey);
  const res = await fetch(url, {
    method,
    headers: {
      'X-OMI-Key': key,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* non-JSON upstream */ }
  return { status: res.status, data, raw };
}

// Relay OMI's response. When OMI replies with a non-JSON body (wrong base URL, an HTML
// error page, a gateway error), surface a readable message instead of a blank
// "Request failed" so the misconfiguration is obvious in the panel.
function relayOmi(res, { status, data, raw }) {
  if (data) return res.status(status).json(data);
  const snippet = (raw || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return res.status(status >= 400 ? status : 502).json({
    error: `OMI responded ${status}${snippet ? `: ${snippet}` : ' with an empty/non-JSON body'} — check the OMI base URL + PR add-on key in Admin → Integrations.`,
  });
}

// ── Authenticated: is OMI configured? Gates the reading-pane PR panel. ─────────
router.get('/omi/status', requireAuth, async (_req, res) => {
  res.json({ enabled: isReady(await loadConfig()) });
});

// ── Authenticated proxies (any logged-in staff) ───────────────────────────────
router.get('/omi/pr/lookup', requireAuth, async (req, res) => {
  const cfg = await loadConfig();
  if (!isReady(cfg)) return res.status(503).json({ error: 'OMI is not configured' });
  const email = String(req.query.email || '').trim();
  try {
    relayOmi(res, await omiFetch(cfg, 'GET', '/lookup', { search: `email=${encodeURIComponent(email)}` }));
  } catch (err) {
    res.status(502).json({ error: `OMI request failed: ${err.message}` });
  }
});

router.post('/omi/pr/contacts', requireAuth, async (req, res) => {
  const cfg = await loadConfig();
  if (!isReady(cfg)) return res.status(503).json({ error: 'OMI is not configured' });
  try {
    relayOmi(res, await omiFetch(cfg, 'POST', '/contacts', { body: req.body || {} }));
  } catch (err) {
    res.status(502).json({ error: `OMI request failed: ${err.message}` });
  }
});

router.post('/omi/pr/editorial-log', requireAuth, async (req, res) => {
  const cfg = await loadConfig();
  if (!isReady(cfg)) return res.status(503).json({ error: 'OMI is not configured' });
  try {
    relayOmi(res, await omiFetch(cfg, 'POST', '/editorial-log', { body: req.body || {} }));
  } catch (err) {
    res.status(502).json({ error: `OMI request failed: ${err.message}` });
  }
});

// ── Admin: configure the OMI connection ───────────────────────────────────────
router.get('/admin/omi', requireAdmin, async (_req, res) => {
  const cfg = await loadConfig();
  if (!cfg) return res.json({ config: null });
  res.json({ config: { enabled: cfg.enabled !== false, baseUrl: cfg.baseUrl || '', apiKey: cfg.apiKey ? '••••••••' : '' } });
});

router.patch('/admin/omi', requireAdmin, async (req, res) => {
  const { enabled, baseUrl, apiKey } = req.body || {};

  let existingKey = null;
  const existing = await loadConfig();
  if (existing) existingKey = existing.apiKey;

  const encryptedKey = apiKey && apiKey !== '••••••••' ? encrypt(apiKey) : (existingKey || null);

  const trimmedBaseUrl = (baseUrl || '').trim().replace(/\/+$/, '');
  if (trimmedBaseUrl) {
    let host;
    try { host = new URL(trimmedBaseUrl).hostname; } catch {
      return res.status(400).json({ error: 'Invalid base URL' });
    }
    const policy = await getConnectionPolicy();
    const hostErr = await validateHost(host, { allowPrivate: policy.allowPrivateHosts });
    if (hostErr) {
      const hint = hostErr.includes('private or reserved')
        ? ' To use a local network address, enable "Allow private hosts" in Settings → Security.'
        : '';
      return res.status(400).json({ error: `Base URL: ${hostErr}.${hint}` });
    }
  }

  const cfg = { enabled: enabled !== false, baseUrl: trimmedBaseUrl, apiKey: encryptedKey };
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [CFG_KEY, JSON.stringify(cfg)]
  );
  console.log(`[admin] ${req.session.username} updated OMI config`);
  res.json({ ok: true });
});

router.delete('/admin/omi', requireAdmin, async (_req, res) => {
  await query('DELETE FROM system_settings WHERE key = $1', [CFG_KEY]);
  res.json({ ok: true });
});

export default router;
