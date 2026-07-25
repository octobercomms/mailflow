import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';

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
// what actually needs the user's action. Runs per account + folder (the user
// selects the folder in the UI). Non-streaming: returns structured JSON the panel
// renders, each task carrying the source email id so the UI can open it.
const AI_TASKS_MAX_EMAILS = 120;

router.post('/ai/tasks', requireAuth, async (req, res) => {
  const { accountId, folder } = req.body || {};
  if (!accountId || !folder) {
    return res.status(400).json({ error: 'accountId and folder are required' });
  }

  const cfgResult = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!cfgResult.rows.length) return res.status(503).json({ error: 'AI provider not configured' });
  let cfg;
  try { cfg = JSON.parse(cfgResult.rows[0].value); } catch {
    return res.status(500).json({ error: 'Corrupted AI config' });
  }
  if (!cfg.enabled) return res.status(503).json({ error: 'AI features are disabled' });
  if (!cfg.baseUrl || !cfg.model) return res.status(503).json({ error: 'AI provider not fully configured' });

  // Account must belong to the caller.
  const acct = await query(
    'SELECT id, email_address AS email FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!acct.rows.length) return res.status(404).json({ error: 'Account not found' });

  // Pull the folder's messages (newest first, capped). The local index already
  // holds subject/sender/snippet, so no IMAP round-trip is needed.
  const msgResult = await query(
    `SELECT id, subject, from_name, from_email, snippet, date, is_read
       FROM messages
      WHERE account_id = $1 AND folder = $2
      ORDER BY date DESC
      LIMIT $3`,
    [accountId, folder, AI_TASKS_MAX_EMAILS + 1]
  );
  const capped = msgResult.rows.length > AI_TASKS_MAX_EMAILS;
  const emails = msgResult.rows.slice(0, AI_TASKS_MAX_EMAILS);
  if (emails.length === 0) {
    return res.json({ tasks: [], scanned: 0, capped: false });
  }

  // Build the prompt. Emails are numbered [1..N]; the model refers back by index.
  const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const lines = emails.map((m, i) => {
    const from = clip(m.from_name || m.from_email || 'unknown', 80);
    const subject = clip(m.subject, 160) || '(no subject)';
    const when = m.date ? new Date(m.date).toISOString().slice(0, 10) : '';
    const snippet = clip(m.snippet, 240);
    return `[${i + 1}] From: ${from} — Subject: ${subject}${when ? ` — ${when}` : ''}\nSnippet: ${snippet}`;
  }).join('\n\n');

  const system = 'You turn a folder of emails into a concise, prioritized to-do list. ' +
    'Only include emails that genuinely require an action FROM THE USER (a reply, a decision, ' +
    'a task, a follow-up). Skip newsletters, receipts, notifications, and anything already handled. ' +
    'Merge related emails into a single task. Keep each task short, specific, and action-first ' +
    '(start with a verb). Do not invent tasks that are not supported by an email.';
  const user = `Here are the emails in the "${folder}" folder for ${acct.rows[0].email} (newest first):\n\n` +
    `${lines}\n\n` +
    'Return ONLY valid JSON, no prose, in this exact shape:\n' +
    '{"tasks":[{"emailIndex":<number>,"title":"<short action>","priority":"high|medium|low"}]}\n' +
    'emailIndex is the [n] of the email the task comes from. Order tasks high → low priority. ' +
    'If nothing needs action, return {"tasks":[]}.';

  const apiKey = cfg.apiKey ? decrypt(cfg.apiKey) : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let content;
  try {
    const aiRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(502).json({ error: `AI provider error (${aiRes.status}): ${errText.slice(0, 300)}` });
    }
    const data = await aiRes.json();
    content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      return res.status(502).json({ error: 'AI provider returned an unexpected response' });
    }
  } catch (err) {
    return res.status(502).json({ error: `AI request failed: ${err.message}` });
  }

  // Parse the JSON the model returned, tolerating ```json fences or surrounding prose.
  let parsed;
  try {
    let text = content.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    else {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) text = text.slice(start, end + 1);
    }
    parsed = JSON.parse(text);
  } catch {
    return res.status(502).json({ error: 'Could not parse the AI task list' });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  const tasks = (Array.isArray(parsed?.tasks) ? parsed.tasks : [])
    .map(t => {
      const idx = Number(t?.emailIndex);
      const src = Number.isInteger(idx) && idx >= 1 && idx <= emails.length ? emails[idx - 1] : null;
      const priority = ['high', 'medium', 'low'].includes(t?.priority) ? t.priority : 'medium';
      const title = clip(t?.title, 200);
      if (!title) return null;
      return src
        ? {
            title, priority,
            emailId: src.id,
            subject: src.subject || '(no subject)',
            from: src.from_name || src.from_email || 'unknown',
            date: src.date,
          }
        : { title, priority, emailId: null };
    })
    .filter(Boolean)
    .sort((a, b) => rank[a.priority] - rank[b.priority]);

  res.json({ tasks, scanned: emails.length, capped });
});

export default router;
