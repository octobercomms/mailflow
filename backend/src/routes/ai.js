import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { imapManager } from '../index.js';
import { generateFolderTasks, loadAiConfig, loadLegendText, saveLegendText, parseLegend } from '../services/taskGenerator.js';
import { scanUserOoo } from '../services/oooScanner.js';

const router = Router();

// ── Admin: AI provider configuration ──────────────────────────────────────────

router.get('/admin/ai', requireAdmin, async (req, res) => {
  const result = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!result.rows.length) return res.json({ config: null });
  try {
    const cfg = JSON.parse(result.rows[0].value);
    res.json({ config: { ...cfg, apiKey: cfg.apiKey ? '••••••••' : '' } });
  } catch {
    res.json({ config: null });
  }
});

router.patch('/admin/ai', requireAdmin, async (req, res) => {
  const { enabled, baseUrl, apiKey, model, features } = req.body;

  let existingKey = null;
  const existing = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (existing.rows.length) {
    try { existingKey = JSON.parse(existing.rows[0].value).apiKey; } catch { /* keep null */ }
  }

  const encryptedKey = apiKey && apiKey !== '••••••••'
    ? encrypt(apiKey)
    : (existingKey || null);

  const trimmedBaseUrl = (baseUrl || '').trim().replace(/\/+$/, '');
  if (trimmedBaseUrl) {
    let urlHost;
    try { urlHost = new URL(trimmedBaseUrl).hostname; } catch {
      return res.status(400).json({ error: 'Invalid base URL' });
    }
    const policy = await getConnectionPolicy();
    const hostErr = await validateHost(urlHost, { allowPrivate: policy.allowPrivateHosts });
    if (hostErr) {
      const hint = hostErr.includes('private or reserved')
        ? ' To use a local network address, enable "Allow private hosts" in Settings → Security.'
        : '';
      return res.status(400).json({ error: `Base URL: ${hostErr}.${hint}` });
    }
  }

  const cfg = {
    enabled: enabled !== false,
    baseUrl: trimmedBaseUrl,
    apiKey: encryptedKey,
    model: (model || '').trim(),
    features: {
      compose: features?.compose !== false,
      summarize: features?.summarize !== false,
      // Opt-in: run the out-of-office contact scan once a day (off unless explicitly set).
      oooDaily: features?.oooDaily === true,
    },
  };

  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('ai_config', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(cfg)]
  );
  console.log(`[admin] ${req.session.username} updated AI config`);
  res.json({ ok: true });
});

router.delete('/admin/ai', requireAdmin, async (req, res) => {
  await query("DELETE FROM system_settings WHERE key = 'ai_config'");
  res.json({ ok: true });
});

router.post('/admin/ai/test', requireAdmin, async (req, res) => {
  const result = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!result.rows.length) return res.status(400).json({ error: 'No AI provider configured' });

  let cfg;
  try { cfg = JSON.parse(result.rows[0].value); } catch {
    return res.status(500).json({ error: 'Corrupted AI config' });
  }

  if (!cfg.baseUrl || !cfg.model) {
    return res.status(400).json({ error: 'Base URL and model name are required' });
  }

  const apiKey = cfg.apiKey ? decrypt(cfg.apiKey) : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    // Trust boundary: intentionally plain fetch, NOT safeFetch. The AI base URL is
    // admin-configured and legitimately points at an internal/self-hosted provider
    // (e.g. a LAN or Tailscale Ollama), which the private-host guard would block.
    // The host is validated when saved (PATCH /admin/ai); the admin owns this URL.
    const testRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'Reply with only the word "ok".' }],
        max_tokens: 5,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!testRes.ok) {
      const errText = await testRes.text();
      return res.status(400).json({ error: `Provider returned ${testRes.status}: ${errText.slice(0, 300)}` });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Authenticated: AI status (used by compose & message pane) ─────────────────

router.get('/ai/status', requireAuth, async (req, res) => {
  const result = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!result.rows.length) return res.json({ enabled: false, features: {} });
  try {
    const cfg = JSON.parse(result.rows[0].value);
    res.json({
      enabled: cfg.enabled === true && !!cfg.baseUrl && !!cfg.model,
      features: cfg.features || {},
    });
  } catch {
    res.json({ enabled: false, features: {} });
  }
});

// ── Authenticated: streaming chat proxy ───────────────────────────────────────

router.post('/ai/chat', requireAuth, async (req, res) => {
  const cfgResult = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!cfgResult.rows.length) return res.status(503).json({ error: 'AI provider not configured' });

  let cfg;
  try { cfg = JSON.parse(cfgResult.rows[0].value); } catch {
    return res.status(500).json({ error: 'Corrupted AI config' });
  }

  if (!cfg.enabled) return res.status(503).json({ error: 'AI features are disabled' });
  if (!cfg.baseUrl || !cfg.model) return res.status(503).json({ error: 'AI provider not fully configured' });

  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  for (const msg of messages) {
    if (!msg.role || typeof msg.content !== 'string') {
      return res.status(400).json({ error: 'Each message must have role and content' });
    }
    if (!['system', 'user', 'assistant'].includes(msg.role)) {
      return res.status(400).json({ error: 'Invalid message role' });
    }
    if (msg.content.length > 32000) {
      return res.status(400).json({ error: 'Message content exceeds maximum length' });
    }
  }

  const apiKey = cfg.apiKey ? decrypt(cfg.apiKey) : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    // Trust boundary: intentionally plain fetch, NOT safeFetch — see the note on the
    // config-test call above. The admin-configured AI base URL is legitimately internal.
    const aiRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: cfg.model, messages, stream: true }),
      signal: AbortSignal.timeout(120000),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(502).json({ error: `AI provider error (${aiRes.status}): ${errText.slice(0, 300)}` });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = aiRes.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (res.destroyed) { reader.cancel(); break; }
        res.write(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: `AI request failed: ${err.message}` });
    }
  }
});

// ── AI task list ──────────────────────────────────────────────────────────────
// Reads every message in one account's folder (e.g. a "to respond" folder) and
// asks the configured AI provider for a prioritized, de-duplicated task list of
// what actually needs the user's action. The heavy lifting (body fetch, prompt,
// parse) lives in services/taskGenerator.js so the Tasks hub + daily cron share it.

// ── Client legend ─────────────────────────────────────────────────────────────
// A user-maintained map of "Client Name: term, term, …" (one per line) — the
// grouping vocabulary fed to the model. Stored in system_settings; see taskGenerator.
router.get('/ai/tasks/legend', requireAuth, async (_req, res) => {
  res.json({ legend: await loadLegendText() });
});

router.put('/ai/tasks/legend', requireAuth, async (req, res) => {
  const { legend } = req.body || {};
  if (typeof legend !== 'string') return res.status(400).json({ error: 'legend must be a string' });
  await saveLegendText(legend);
  res.json({ ok: true });
});

router.post('/ai/tasks', requireAuth, async (req, res) => {
  const { accountId, folder } = req.body || {};
  if (!accountId || !folder) {
    return res.status(400).json({ error: 'accountId and folder are required' });
  }

  let cfg;
  try { cfg = await loadAiConfig(); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

  // Account must belong to the caller. Full row — the on-demand body fetch needs the
  // IMAP connection details.
  const acct = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!acct.rows.length) return res.status(404).json({ error: 'Account not found' });

  const legend = parseLegend(await loadLegendText());
  const prefRow = await query('SELECT preferences FROM users WHERE id = $1', [req.session.userId]);
  const ownerNames = prefRow.rows[0]?.preferences?.ownerNames || '';
  try {
    const { tasks, scanned, capped } = await generateFolderTasks({
      account: acct.rows[0], folder, cfg, legend, imapManager, ownerNames,
    });
    res.json({ tasks, scanned, capped });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message || 'AI request failed' });
  }
});

// ── Out-of-office contact-update scan ─────────────────────────────────────────
// Scans auto-reply / out-of-office mail across all of the user's accounts and folders,
// extracts lasting contact changes, stores suggestions, and emails the user a summary.
// Runs in the background (the sweep can be long); the response returns immediately.
const _oooScanRunning = new Set();
const _oooLastRun = new Map(); // userId -> { scanned, suggestions, remaining, at, error }

router.post('/ooo/scan', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  // Fail fast with a clear error if no AI provider is configured.
  try { await loadAiConfig(); }
  catch (err) { return res.status(err.status || 503).json({ error: err.message || 'AI not configured' }); }

  if (_oooScanRunning.has(userId)) return res.json({ started: false, alreadyRunning: true });
  _oooScanRunning.add(userId);
  scanUserOoo(userId)
    .then(summary => {
      console.log(`OOO scan for user ${userId}: scanned ${summary.scanned}, ${summary.suggestions} suggestion(s), ${summary.remaining} remaining`);
      _oooLastRun.set(userId, { ...summary, at: new Date().toISOString(), error: null });
    })
    .catch(err => {
      console.error(`OOO scan for user ${userId} failed:`, err.message);
      _oooLastRun.set(userId, { scanned: 0, suggestions: 0, remaining: 0, at: new Date().toISOString(), error: err.message });
    })
    .finally(() => _oooScanRunning.delete(userId));

  res.json({ started: true });
});

// Live scan status for the settings page: whether a scan is running, the last run's
// summary, and the current number of open suggestions.
router.get('/ooo/status', requireAuth, async (req, res) => {
  const userId = req.session.userId;
  let total = 0;
  try {
    const r = await query("SELECT COUNT(*)::int AS n FROM ooo_suggestions WHERE user_id = $1 AND status <> 'dismissed'", [userId]);
    total = r.rows[0]?.n ?? 0;
  } catch { /* table may not exist yet pre-migration — treat as zero */ }
  res.json({ running: _oooScanRunning.has(userId), lastRun: _oooLastRun.get(userId) || null, total });
});

router.post('/ooo/suggestions/:id/dismiss', requireAuth, async (req, res) => {
  try {
    await query(
      "UPDATE ooo_suggestions SET status = 'dismissed' WHERE id = $1 AND user_id = $2",
      [req.params.id, req.session.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to dismiss' });
  }
});

router.get('/ooo/suggestions', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, category, person_name, person_email, new_email, new_company, role,
              alt_contacts, source_quote, from_email, subject, message_date, confidence, status, created_at
         FROM ooo_suggestions
        WHERE user_id = $1 AND status <> 'dismissed'
        ORDER BY created_at DESC
        LIMIT 500`,
      [req.session.userId]
    );
    res.json({ suggestions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to load suggestions' });
  }
});

export default router;
