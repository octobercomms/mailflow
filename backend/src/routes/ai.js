import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/encryption.js';
import { validateHost } from '../services/hostValidation.js';
import { getConnectionPolicy } from '../services/connectionPolicy.js';
import { imapManager } from '../index.js';
import { sanitizeEmail } from '../services/emailSanitizer.js';
import { snippetFromBody } from '../services/messageParser.js';

// Strip a null byte (Postgres text can't hold \0) — mirrors mail.js sanitizeDbText.
const nz = (s) => (typeof s === 'string' ? s.replace(/\0/g, '') : s);
// Rough HTML→text for feeding an html-only email to the model (not stored).
const htmlToText = (html) => String(html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ').trim();

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

// ── Client legend ─────────────────────────────────────────────────────────────
// A user-maintained map of "Client Name: term, term, …" (one per line). Terms are
// domains, people, or brand/project names. They let the task list group by real
// client even for internal mail that only mentions the client in the body — the
// legend is fed to the model as the authoritative grouping vocabulary, and any
// term that matches the sender address/name also tags the email deterministically.
const CLIENT_LEGEND_MAX = 8000;

function parseLegend(text) {
  return (text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const idx = line.indexOf(':');
      if (idx === -1) return { client: line.trim(), terms: [] };
      const client = line.slice(0, idx).trim();
      const terms = line.slice(idx + 1).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      return { client, terms };
    })
    .filter(e => e.client);
}

async function loadLegendText() {
  const r = await query("SELECT value FROM system_settings WHERE key = 'client_legend'");
  return r.rows.length ? r.rows[0].value : '';
}

router.get('/ai/tasks/legend', requireAuth, async (_req, res) => {
  res.json({ legend: await loadLegendText() });
});

router.put('/ai/tasks/legend', requireAuth, async (req, res) => {
  let { legend } = req.body || {};
  if (typeof legend !== 'string') return res.status(400).json({ error: 'legend must be a string' });
  legend = legend.slice(0, CLIENT_LEGEND_MAX);
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('client_legend', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [legend]
  );
  res.json({ ok: true });
});

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

  // Account must belong to the caller. Full row — the on-demand body fetch below
  // needs the IMAP connection details.
  const acct = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!acct.rows.length) return res.status(404).json({ error: 'Account not found' });
  const account = acct.rows[0];

  // Pull the folder's messages (newest first, capped).
  const msgResult = await query(
    `SELECT id, uid, subject, from_name, from_email, snippet, body_text, date, is_read
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

  // Fetch real bodies on demand. Gmail is indexed with fetchBody:false, so most
  // rows only carry a short snippet — feeding that to the model is why the digest
  // was shallow. Fetch the full body for any email missing one, cache it (so this
  // is a one-time cost per email and normal reading benefits too), and use it for
  // the prompt. Bounded concurrency + stop early if the server starts throttling.
  const needBody = emails.filter(m => !m.body_text && m.uid);
  if (needBody.length) {
    imapManager.noteUserActivity(account.id);
    const CONCURRENCY = 3;
    const BODY_FETCH_BUDGET_MS = 120000;   // leave room under the 300s proxy ceiling for the AI call
    const deadline = Date.now() + BODY_FETCH_BUDGET_MS;
    let throttled = false;
    for (let i = 0; i < needBody.length && !throttled && Date.now() < deadline; i += CONCURRENCY) {
      const batch = needBody.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (m) => {
        try {
          const { html, text, attachments } = await imapManager.fetchMessageBody(account, m.uid, folder);
          const safeHtml = html ? sanitizeEmail(html) : null;
          const plain = (text && text.trim()) ? text : (safeHtml ? htmlToText(safeHtml) : '');
          if (safeHtml || text) {
            m.body_text = plain || m.snippet;   // in-memory, for the prompt
            const snip = snippetFromBody(text, safeHtml || html);
            await query(
              `UPDATE messages SET body_html = $1, body_text = $2, attachments = $3,
                   snippet = CASE WHEN $5 != '' THEN $5 ELSE snippet END
               WHERE id = $4`,
              [nz(safeHtml), nz(text || ''), JSON.stringify(attachments || []), m.id, nz(snip || '')]
            );
          }
        } catch (err) {
          if (/THROTTL/i.test(err?.message || '')) throttled = true;
        }
      }));
    }
  }

  // Load the user's client legend (if any). Terms that match the sender address or
  // name tag the email deterministically; the full legend is also fed to the model
  // as the grouping vocabulary so content-only mentions (e.g. internal mail about a
  // client) still file under the right client.
  const legend = parseLegend(await loadLegendText());
  const hintFor = (m) => {
    if (!legend.length) return '';
    const hay = `${m.from_email || ''} ${m.from_name || ''}`.toLowerCase();
    for (const { client, terms } of legend) {
      if (terms.some(term => term && hay.includes(term))) return client;
    }
    return '';
  };

  // Build the prompt. Emails are numbered [1..N]; the model refers back by index.
  // Feed the message body (not just the snippet) so the model can extract the actual
  // ask — what is wanted, from whom, and any deadline — rather than a thin one-liner.
  const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const lines = emails.map((m, i) => {
    const from = clip(m.from_name || m.from_email || 'unknown', 80);
    const subject = clip(m.subject, 160) || '(no subject)';
    const when = m.date ? new Date(m.date).toISOString().slice(0, 10) : '';
    const bodyText = clip(m.body_text || m.snippet, 2000);
    const hint = hintFor(m);
    return `[${i + 1}] From: ${from} — Subject: ${subject}${when ? ` — ${when}` : ''}${hint ? ` — CLIENT: ${hint}` : ''}\n${bodyText}`;
  }).join('\n\n');

  const legendBlock = legend.length
    ? 'KNOWN CLIENTS — group every task under ONE of these EXACT names. Match each email to a client using ' +
      'the sender, the people named, and the brand/project mentioned in the body (the terms in parentheses are ' +
      'matching hints; a "CLIENT:" tag on an email is an authoritative match you should trust):\n' +
      legend.map(e => `- ${e.client}${e.terms.length ? ` (${e.terms.join(', ')})` : ''}`).join('\n') +
      '\nDo NOT create per-person or per-project groups (e.g. a contact name or a city) — roll those up into the ' +
      'matching client. If an email genuinely matches no client above, group it under "Other".\n\n'
    : '';

  const system = 'You turn a folder of emails into a thorough, grouped, prioritized to-do digest for a busy agency owner. ' +
    'Be COMPLETE: go through every email and capture every outstanding action the user still owes — a reply, a ' +
    'decision, a deliverable, a follow-up, a chase. It is better to include a borderline item than to miss a real one. ' +
    'If a single email contains several distinct asks, create a SEPARATE task for each one. ' +
    'Only skip an email if it is a pure newsletter/receipt/automated notification, or the action is clearly already ' +
    'done. Do not collapse unrelated actions together just to shorten the list — merge only when two emails are ' +
    'genuinely the same request (e.g. the same thread). ' +
    'When a KNOWN CLIENTS list is provided, you MUST group strictly by those exact client names — never invent ' +
    'per-person or per-project group labels. When no list is provided, infer the client/project from the sender ' +
    'domain, names, and content, and use "General" only when nothing more specific fits. ' +
    'For each task write: a short action-first title (start with a verb), and a "detail" of 1–2 sentences that ' +
    'captures the real substance — what specifically is being asked, by whom, any deadline, and (crucially) the ' +
    'concrete sub-items if the email lists several (e.g. "needs sign-off on 4 things: X, Y, Z, and W") — so the ' +
    'user knows exactly what it involves without opening the email. ' +
    'Use priority honestly: high = urgent/explicitly deadline-bound or chased, medium = normal, low = nice-to-have. ' +
    'Do not invent anything not supported by an email.';
  const user = `Here are the emails in the "${folder}" folder for ${account.email_address} (newest first). ` +
    `Full message bodies are included — read them, don't just skim the subject.\n\n` +
    `${legendBlock}` +
    `${lines}\n\n` +
    'Return ONLY valid JSON, no prose, in this exact shape:\n' +
    '{"tasks":[{"emailIndex":<number>,"group":"<client or project name>","title":"<short action, verb-first>",' +
    '"detail":"<1–2 sentences: the specific ask, who from, any deadline, and the concrete sub-items>",' +
    '"priority":"high|medium|low"}]}\n' +
    'emailIndex is the [n] of the email the task comes from. Order tasks high → low priority within the whole list. ' +
    'Aim to reflect every genuinely outstanding action across the folder. If truly nothing needs action, return {"tasks":[]}.';

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
  {
    let text = content.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    else {
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start >= 0 && end > start) text = text.slice(start, end + 1);
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      // A long, thorough list can be truncated mid-array by the provider's output
      // cap, which breaks a strict parse. Salvage every complete {...} task object
      // so the user still gets a (near-)complete list rather than an error.
      const objs = text.match(/\{[^{}]*\}/g) || [];
      const tasksOut = [];
      for (const o of objs) {
        try { tasksOut.push(JSON.parse(o)); } catch { /* skip partial */ }
      }
      if (tasksOut.length) parsed = { tasks: tasksOut };
      else return res.status(502).json({ error: 'Could not parse the AI task list' });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  const tasks = (Array.isArray(parsed?.tasks) ? parsed.tasks : [])
    .map(t => {
      const idx = Number(t?.emailIndex);
      const src = Number.isInteger(idx) && idx >= 1 && idx <= emails.length ? emails[idx - 1] : null;
      const priority = ['high', 'medium', 'low'].includes(t?.priority) ? t.priority : 'medium';
      const title = clip(t?.title, 200);
      if (!title) return null;
      const group = clip(t?.group, 80) || 'General';
      const detail = clip(t?.detail, 400);
      return src
        ? {
            title, detail, group, priority,
            emailId: src.id,
            subject: src.subject || '(no subject)',
            from: src.from_name || src.from_email || 'unknown',
            date: src.date,
          }
        : { title, detail, group, priority, emailId: null };
    })
    .filter(Boolean)
    .sort((a, b) => rank[a.priority] - rank[b.priority]);

  res.json({ tasks, scanned: emails.length, capped });
});

export default router;
