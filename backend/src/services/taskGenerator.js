import { query } from './db.js';
import { decrypt } from './encryption.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { snippetFromBody } from './messageParser.js';

// Shared AI "folder → task list" generation. Used by two callers:
//   • POST /ai/tasks   — the in-mail digest panel (one account + folder, ad-hoc)
//   • POST /tasks/refresh — the Tasks hub, sweeping every configured task folder
// Keeping the prompt + body-fetch + parse in one place means both paths produce
// identical results and the daily cron reuses the exact same logic.

// Strip a null byte (Postgres text can't hold \0) — mirrors mail.js sanitizeDbText.
const nz = (s) => (typeof s === 'string' ? s.replace(/\0/g, '') : s);
// Rough HTML→text for feeding an html-only email to the model (not stored).
const htmlToText = (html) => String(html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export const AI_TASKS_MAX_EMAILS = 120;
const CLIENT_LEGEND_MAX = 8000;

// ── Client legend ─────────────────────────────────────────────────────────────
// A user-maintained "Client Name: term, term, …" map (one per line). Terms are
// domains, people, or brand/project names that let the digest group by real client
// even when the client is only mentioned in the body.
export function parseLegend(text) {
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

export async function loadLegendText() {
  const r = await query("SELECT value FROM system_settings WHERE key = 'client_legend'");
  return r.rows.length ? r.rows[0].value : '';
}

export async function saveLegendText(legend) {
  const clipped = String(legend || '').slice(0, CLIENT_LEGEND_MAX);
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('client_legend', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [clipped]
  );
}

// ── AI provider config ────────────────────────────────────────────────────────
// Throws an Error tagged with .status so a route can relay the right HTTP code.
export async function loadAiConfig() {
  const r = await query("SELECT value FROM system_settings WHERE key = 'ai_config'");
  if (!r.rows.length) { const e = new Error('AI provider not configured'); e.status = 503; throw e; }
  let cfg;
  try { cfg = JSON.parse(r.rows[0].value); } catch { const e = new Error('Corrupted AI config'); e.status = 500; throw e; }
  if (!cfg.enabled) { const e = new Error('AI features are disabled'); e.status = 503; throw e; }
  if (!cfg.baseUrl || !cfg.model) { const e = new Error('AI provider not fully configured'); e.status = 503; throw e; }
  return cfg;
}

// ── Generic non-streaming completion ──────────────────────────────────────────
// One place for the OpenAI-compatible /chat/completions call the assistant features
// (tasks, client briefs, drafts, daily brief, research) all share. Note: this model
// rejects a `temperature` field, so we never send one. Throws Error tagged .status.
export async function aiComplete(cfg, messages, { timeoutMs = 120000 } = {}) {
  const apiKey = cfg.apiKey ? decrypt(cfg.apiKey) : null;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // Trust boundary: intentionally plain fetch (see ai.js) — the admin-configured base
  // URL legitimately points at an internal/self-hosted provider.
  const aiRes = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, messages, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!aiRes.ok) {
    const errText = await aiRes.text();
    const e = new Error(`AI provider error (${aiRes.status}): ${errText.slice(0, 300)}`);
    e.status = 502; throw e;
  }
  const data = await aiRes.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') { const e = new Error('AI provider returned an unexpected response'); e.status = 502; throw e; }
  return content;
}

// ── The generator ─────────────────────────────────────────────────────────────
// Reads one account's folder, fetches missing bodies on demand, asks the model for
// a grouped/prioritized task list, and returns normalized tasks. `refs` is the set
// of message-ids currently present in the folder — the hub uses it to auto-complete
// tasks whose source email has since been filed elsewhere.
export async function generateFolderTasks({ account, folder, cfg, legend, imapManager, extraContext = '', ownerNames = '' }) {
  const msgResult = await query(
    `SELECT id, uid, message_id, subject, from_name, from_email, snippet, body_text, date, is_read,
            to_addresses, cc_addresses, thread_key
       FROM messages
      WHERE account_id = $1 AND folder = $2
      ORDER BY date DESC
      LIMIT $3`,
    [account.id, folder, AI_TASKS_MAX_EMAILS + 1]
  );
  const capped = msgResult.rows.length > AI_TASKS_MAX_EMAILS;
  let emails = msgResult.rows.slice(0, AI_TASKS_MAX_EMAILS);
  if (emails.length === 0) return { tasks: [], scanned: 0, capped: false, refs: new Set() };

  // The owner's addresses (account + aliases) — used both for To/Cc weighting and to
  // detect "already replied".
  const ownerAddrs = new Set();
  if (account.email_address) ownerAddrs.add(account.email_address.toLowerCase());
  { let aliases = account.aliases;
    if (typeof aliases === 'string') { try { aliases = JSON.parse(aliases); } catch { aliases = []; } }
    for (const a of aliases || []) if (a?.email) ownerAddrs.add(a.email.toLowerCase()); }

  // Drop emails the owner has ALREADY replied to: if a later message exists in the same
  // thread from one of the owner's addresses, the ball is no longer in their court, so
  // there's no task. Excluding these from `refs` also auto-completes any existing task
  // in the hub whose source email has now been answered (even while it sits in-folder).
  const threadKeys = [...new Set(emails.map(m => m.thread_key).filter(Boolean))];
  const ownerLastByThread = new Map();
  if (threadKeys.length && ownerAddrs.size) {
    const r = await query(
      `SELECT thread_key, MAX(date) AS last_owner
         FROM messages
        WHERE account_id = $1 AND thread_key = ANY($2) AND lower(from_email) = ANY($3)
        GROUP BY thread_key`,
      [account.id, threadKeys, [...ownerAddrs]]
    );
    for (const row of r.rows) ownerLastByThread.set(row.thread_key, new Date(row.last_owner).getTime());
  }
  const alreadyReplied = (m) => {
    if (!m.thread_key || !m.date) return false;
    const last = ownerLastByThread.get(m.thread_key);
    return last != null && last > new Date(m.date).getTime();
  };
  emails = emails.filter(m => !alreadyReplied(m));
  if (emails.length === 0) return { tasks: [], scanned: 0, capped, refs: new Set() };

  const refs = new Set(emails.map(m => m.message_id).filter(Boolean));

  // Fetch real bodies on demand. Gmail is indexed with fetchBody:false, so most
  // rows only carry a short snippet — feeding that to the model is why an unhydrated
  // digest is shallow. Fetch, cache (one-time cost, normal reading benefits too),
  // and use for the prompt. Bounded concurrency + stop early if throttled.
  const needBody = emails.filter(m => !m.body_text && m.uid);
  if (needBody.length) {
    imapManager.noteUserActivity(account.id);
    const CONCURRENCY = 3;
    const BODY_FETCH_BUDGET_MS = 120000;
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
            m.body_text = plain || m.snippet;
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

  const hintFor = (m) => {
    if (!legend.length) return '';
    const hay = `${m.from_email || ''} ${m.from_name || ''}`.toLowerCase();
    for (const { client, terms } of legend) {
      if (terms.some(term => term && hay.includes(term))) return client;
    }
    return '';
  };

  const nowMs = Date.now();
  const ageLabel = (d) => {
    if (!d) return '';
    const days = Math.floor((nowMs - new Date(d).getTime()) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 45) return `${days} days ago`;
    if (days < 400) return `${Math.round(days / 30)} months ago`;
    return `${(days / 365).toFixed(1)} years ago`;
  };

  // Was the owner a direct recipient (To), only copied (Cc), or neither (received via
  // a group/label)? Lets the model weight "asked of me" vs "just kept in the loop".
  // ownerAddrs is computed above (also used for reply detection).
  const parseAddrs = (v) => { if (Array.isArray(v)) return v; try { return JSON.parse(v || '[]'); } catch { return []; } };
  const recipientRole = (m) => {
    const to = parseAddrs(m.to_addresses).map(x => (x.email || '').toLowerCase());
    const cc = parseAddrs(m.cc_addresses).map(x => (x.email || '').toLowerCase());
    if (to.some(e => ownerAddrs.has(e))) return 'To';
    if (cc.some(e => ownerAddrs.has(e))) return 'Cc';
    return '-';
  };

  const lines = emails.map((m, i) => {
    const from = clip(m.from_name || m.from_email || 'unknown', 80);
    const subject = clip(m.subject, 160) || '(no subject)';
    const when = m.date ? `${new Date(m.date).toISOString().slice(0, 10)} (${ageLabel(m.date)})` : '';
    const bodyText = clip(m.body_text || m.snippet, 2000);
    const hint = hintFor(m);
    return `[${i + 1}] From: ${from} — Subject: ${subject}${when ? ` — ${when}` : ''} — [${recipientRole(m)}]${hint ? ` — CLIENT: ${hint}` : ''}\n${bodyText}`;
  }).join('\n\n');

  const ownerNamesList = String(ownerNames || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  const ownerBlock =
    `WHO YOU ARE: you are ${account.email_address}` +
    (ownerNamesList.length ? ` — also referred to as ${ownerNamesList.join(', ')}` : '') +
    `. Each email is tagged with your role on it: [To] = you were a direct recipient, ` +
    `[Cc] = you were only copied in, [-] = you were not a named recipient (it reached you via a group/label).\n\n`;

  const legendBlock = legend.length
    ? 'KNOWN CLIENTS — group every task under ONE of these EXACT names. Match each email to a client using ' +
      'the sender, the people named, and the brand/project mentioned in the body (the terms in parentheses are ' +
      'matching hints; a "CLIENT:" tag on an email is an authoritative match you should trust):\n' +
      legend.map(e => `- ${e.client}${e.terms.length ? ` (${e.terms.join(', ')})` : ''}`).join('\n') +
      '\nThis list is a STARTING POINT, not a closed set. When an email matches one of these, use that exact name. ' +
      'When an email clearly belongs to a client, company, or project that is NOT on the list, DO create a new, ' +
      'sensible group for it — infer the name from the sender\'s company/domain and the content (e.g. "Acme Studio", ' +
      '"Trinity Court"). Do NOT dump everything unmatched into "Other". ' +
      'Never split by individual person or city — roll those into the company/client. ' +
      'Reserve "Other" only for genuinely miscellaneous one-offs that fit no client or project.\n\n'
    : '';

  const system = 'You turn a folder of emails into a thorough, grouped, prioritized to-do digest for a busy agency owner. ' +
    'Be COMPLETE: go through every email and capture every outstanding action the user still owes — a reply, a ' +
    'decision, a deliverable, a follow-up, a chase. It is better to include a borderline item than to miss a real one. ' +
    'If a single email contains several distinct asks, create a SEPARATE task for each one. ' +
    'Only skip an email if it is a pure newsletter/receipt/automated notification, or the user has plainly already ' +
    'responded/actioned it in a later message. IMPORTANT: the underlying work being finished does NOT mean skip — ' +
    'if an email addressed to the user still expects ANY response, including just a short acknowledgement, a ' +
    'courtesy reply, or a sign-off nod (e.g. a project closure/hand-off, an FYI that invites a reply), include it ' +
    'as a LOW priority task ("Acknowledge …" / "Reply to …"). When in doubt, include it as low rather than drop it. ' +
    'Do not collapse unrelated actions together just to shorten the list. NEVER merge two emails just because ' +
    'they share a subject line — a shared subject is NOT enough. Merge only when emails are genuinely the same ' +
    'ongoing conversation: the same people AND continuous back-and-forth. Emails from different senders, different ' +
    'clients, or far apart in time (e.g. one from 2016 and one from this year) are ALWAYS separate tasks — or ' +
    'omit the stale one entirely — even if the subject is identical. Judge each email by its sender, date, and ' +
    'body, not its subject. ' +
    'DATES MATTER. You are given today\'s date, and every email is dated. Judge recency and any deadline against ' +
    'TODAY — never against the email\'s own sense of "now". NEVER carry over time-relative wording from an email ' +
    '("this week", "by Friday", "today", "tomorrow") as if it were current: an email from two months ago saying ' +
    '"sign-off this week" does NOT mean this week now. Restate deadlines as the concrete date if the email gives one, ' +
    'and drop vague relative timing when the email is not recent. If a stated deadline has clearly already passed, ' +
    'either omit the item or frame it as a possibly-stale follow-up ("Check whether … is still needed") — do not ' +
    'present a lapsed deadline as urgent. Emails more than about a year old are very likely stale leftovers — include ' +
    'one only if it clearly describes an action still genuinely open today; otherwise skip it. ' +
    'WHO IS BEING ASKED. Each email is tagged [To], [Cc], or [-] for the user\'s role on it (see WHO YOU ARE). ' +
    'Weigh this: when the user is on [To], or is named/addressed in the body ("Daniel, can you…"), treat it as a ' +
    'normal ask. When the user is only [Cc] or [-] AND the body does not name or ask them specifically, it is most ' +
    'likely FYI / kept-in-the-loop — do NOT create a task for it UNLESS it is clearly something the user owns ' +
    'regardless of being asked by name: an automated or system alert (a failed or failing payment, a card/Stripe/' +
    'billing problem, an expiring or expired certificate/domain/subscription, a webhook or integration breaking, an ' +
    'error/downtime report, a renewal or account-suspension notice), or an action only the user can take. Those ARE ' +
    'the user\'s job even though nobody asked by name — include them. So: system/automated alerts → include even on ' +
    '[Cc]/[-]; ordinary human emails where the user was merely copied and not addressed → skip unless they plainly ' +
    'need the user\'s action. When genuinely unsure on a Cc-only human email, prefer skipping over adding noise. ' +
    'GROUPING: prefer the KNOWN CLIENTS names when an email matches one, but you are NOT limited to that list — when ' +
    'an email clearly belongs to another client, company, or project, infer a concise, stable, title-cased group name ' +
    'from the sender domain and content and create it. Never split by individual person or city (roll those into the ' +
    'company/client). NEVER create two groups that differ only by a year, edition, season, or trivial suffix — e.g. ' +
    '"Atlanta Design Festival" and "Atlanta Design Festival 2026" are the SAME client; always use the one canonical ' +
    'name without the year. Keep group names short and canonical so the same client always lands in one group. ' +
    'Use "Other"/"General" only for genuinely miscellaneous one-offs, not as a dumping ground. ' +
    'For each task write: a short action-first title (start with a verb), and a "detail" of 1–2 sentences that ' +
    'captures the real substance — what specifically is being asked, by whom, any deadline, and (crucially) the ' +
    'concrete sub-items if the email lists several (e.g. "needs sign-off on 4 things: X, Y, Z, and W") — so the ' +
    'user knows exactly what it involves without opening the email. ' +
    'Use priority honestly: high = urgent/explicitly deadline-bound or chased, medium = normal, low = nice-to-have. ' +
    'Do not invent anything not supported by an email.';
  const today = new Date().toISOString().slice(0, 10);
  const user = `TODAY'S DATE IS ${today}. Judge every email's recency and deadlines against this date.\n\n` +
    `Here are the emails in the "${folder}" folder for ${account.email_address} (newest first). ` +
    `Full message bodies are included — read them, don't just skim the subject. Each email's own date is shown after its subject.\n\n` +
    `${ownerBlock}` +
    `${extraContext ? extraContext + '\n\n' : ''}` +
    `${legendBlock}` +
    `${lines}\n\n` +
    'Return ONLY valid JSON, no prose, in this exact shape:\n' +
    '{"tasks":[{"emailIndex":<number>,"group":"<client or project name>","title":"<short action, verb-first>",' +
    '"detail":"<1–2 sentences: the specific ask, who from, any deadline, and the concrete sub-items>",' +
    '"priority":"high|medium|low"}]}\n' +
    'emailIndex is the [n] of the email the task comes from. Order tasks high → low priority within the whole list. ' +
    'Aim to reflect every genuinely outstanding action across the folder. If truly nothing needs action, return {"tasks":[]}.';

  const content = await aiComplete(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);

  // Parse the JSON, tolerating ```json fences or surrounding prose, and salvaging a
  // list truncated mid-array by the provider's output cap.
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
      const objs = text.match(/\{[^{}]*\}/g) || [];
      const tasksOut = [];
      for (const o of objs) { try { tasksOut.push(JSON.parse(o)); } catch { /* skip partial */ } }
      if (tasksOut.length) parsed = { tasks: tasksOut };
      else { const e = new Error('Could not parse the AI task list'); e.status = 502; throw e; }
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
            messageId: src.message_id || null,
            subject: src.subject || '(no subject)',
            from: src.from_name || src.from_email || 'unknown',
            date: src.date,
          }
        : { title, detail, group, priority, emailId: null, messageId: null };
    })
    .filter(Boolean)
    .sort((a, b) => rank[a.priority] - rank[b.priority]);

  return { tasks, scanned: emails.length, capped, refs };
}
