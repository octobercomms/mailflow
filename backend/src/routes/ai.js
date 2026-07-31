import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { imapManager } from '../index.js';
import { generateFolderTasks, loadAiConfig, loadLegendText, saveLegendText, parseLegend } from '../services/taskGenerator.js';

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

export default router;
