// Out-of-office scanner.
//
// Finds auto-reply / out-of-office messages across every one of a user's accounts and
// folders, asks the configured AI to extract any LASTING contact change (a person left
// or gave a new address, or named an alternate contact), and stores reviewable
// suggestions. Vacation-only replies produce nothing.
//
// Work is de-duplicated by sender: the same person's auto-reply fires on every campaign
// send, so we only ever scan each sender's MOST RECENT out-of-office message. That copy
// carries the current contact-change info, and reviewing one suggestion per person beats
// dozens of identical ones. A sender is re-scanned only when a newer auto-reply arrives
// from them (exactly when their situation may have changed). Each scanned message is
// recorded so the first run sweeps all history and later runs are incremental, with no
// double-charging.
//
// Detection is a cheap subject-pattern filter over the DB (no AI), so "scan every email"
// only spends AI on the small out-of-office subset it finds. Provider plumbing is the
// same OpenAI-compatible /chat/completions used by the other assistant features.

import { query } from './db.js';
import { loadAiConfig, aiComplete } from './taskGenerator.js';
import { sendSystemEmail } from './mailer.js';

// This is a classify-and-extract job (read one auto-reply, label it, pull a verbatim
// address), so it runs on Haiku regardless of the global AI model — it's intelligent
// enough for the task and keeps the full historical sweep and the daily pass cheap.
// Change this string if the configured provider expects a different Haiku identifier
// (a rejected model surfaces as a provider error on the scan status panel).
const OOO_MODEL = 'claude-haiku-4-5';

// High-precision subject patterns. Kept tight to avoid wasting AI calls on false hits;
// widen if real out-of-office replies are being missed.
const OOO_SUBJECT_RE =
  "(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|away from (the |my )?office|on annual leave|annual leave|maternity leave|paternity leave|on holiday|on vacation|currently away|away from my desk|out of the country|réponse automatique|abwesen|fuori sede)";

const SCAN_CONCURRENCY = 3;
// Cap AI calls per invocation so a first full-history sweep can't run unbounded. Any
// remainder is picked up next run (each is marked scanned only after it is processed).
const MAX_PER_RUN = 300;
// Trim the body fed to the model — an out-of-office reply's useful content is short.
const BODY_MAX = 2000;

function bounded(runners, limit, worker) {
  let idx = 0;
  const pool = Array.from({ length: Math.min(limit, runners.length) }, async () => {
    while (idx < runners.length) {
      const i = idx++;
      await worker(runners[i]);
    }
  });
  return Promise.all(pool);
}

// Build the extraction prompt. Pure and exported for testing — the load-bearing decision
// (what we ask the model for) is unit-testable without a provider.
export function buildOooPrompt({ subject, from, body } = {}) {
  const trimmed = (body || '').replace(/\s+/g, ' ').trim().slice(0, BODY_MAX);
  return [
    {
      role: 'system',
      content:
        'You read a single out-of-office / auto-reply email and extract any LASTING contact change. ' +
        'Reply with ONLY a JSON object, no prose and no code fences. Use this exact shape:\n' +
        '{\n' +
        '  "category": "vacation" | "left_or_moved" | "mentions_alt_contact" | "other",\n' +
        '  "person": { "name": string|null, "new_email": string|null, "new_company": string|null, "role": string|null } | null,\n' +
        '  "alt_contacts": [ { "name": string|null, "email": string|null, "role": string|null, "company": string|null } ],\n' +
        '  "source_quote": string,\n' +
        '  "confidence": number\n' +
        '}\n' +
        'Rules: "vacation" = a temporary absence with nothing to change (person null, alt_contacts []). ' +
        '"left_or_moved" = the sender has left, changed employer, or given a new personal email. ' +
        '"mentions_alt_contact" = the message names someone else to contact, or an alternate address for the sender. ' +
        'Only ever include an email address you can see VERBATIM in the message; never invent or guess one. ' +
        'source_quote is the exact sentence supporting the finding, at most 200 characters. confidence is 0 to 1.',
    },
    {
      role: 'user',
      content: `From: ${from || '(unknown)'}\nSubject: ${(subject || '').slice(0, 200)}\n\n${trimmed}`,
    },
  ];
}

// Parse the model output into a normalised result, or null when unusable. Pure/exported.
export function parseOooResult(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  // Strip ```json ... ``` fences some models add despite instructions.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Fall back to the first {...} block if there is leading/trailing prose.
  if (s[0] !== '{') {
    const brace = s.match(/\{[\s\S]*\}/);
    if (brace) s = brace[0];
  }
  let obj;
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  const category = ['vacation', 'left_or_moved', 'mentions_alt_contact', 'other'].includes(obj.category)
    ? obj.category : 'other';
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const email = (v) => {
    const e = str(v);
    return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e.toLowerCase() : null;
  };
  const person = obj.person && typeof obj.person === 'object' ? {
    name: str(obj.person.name),
    new_email: email(obj.person.new_email),
    new_company: str(obj.person.new_company),
    role: str(obj.person.role),
  } : null;
  const alt = Array.isArray(obj.alt_contacts) ? obj.alt_contacts.slice(0, 10).map(c => ({
    name: str(c?.name), email: email(c?.email), role: str(c?.role), company: str(c?.company),
  })).filter(c => c.name || c.email) : [];
  const confidence = typeof obj.confidence === 'number' && obj.confidence >= 0 && obj.confidence <= 1
    ? obj.confidence : null;
  return { category, person, alt_contacts: alt, source_quote: str(obj.source_quote), confidence };
}

// A result is worth surfacing only when it carries an actual change: a new address/employer
// for the sender, or at least one named alternate contact.
function isActionable(r) {
  if (!r) return false;
  if (r.category === 'left_or_moved' && r.person && (r.person.new_email || r.person.new_company)) return true;
  if (r.category === 'mentions_alt_contact' && r.alt_contacts.length > 0) return true;
  return false;
}

// Scan a user's mailboxes for out-of-office contact updates. Returns a summary
// { scanned, suggestions, remaining }. Marks every candidate scanned (whatever the
// outcome) so it is never re-charged. Sends the user an email if new suggestions were
// created. Safe to call repeatedly: the scan_state table makes each run incremental.
export async function scanUserOoo(userId) {
  const cfg = await loadAiConfig(); // throws (503) when no provider is configured
  // Hard-wire this feature to Haiku, leaving the global model untouched for everything else.
  const oooCfg = { ...cfg, model: OOO_MODEL };

  // One candidate per sender: their most recent out-of-office message, but only when that
  // latest copy has not been scanned yet. This collapses the same person's many campaign
  // auto-replies to a single AI call, and re-scans a sender only once a newer reply lands.
  const { rows: candidates } = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (lower(m.from_email))
              m.id, m.account_id, m.subject, m.from_name, m.from_email, m.date,
              COALESCE(NULLIF(m.body_text, ''), m.snippet) AS body
         FROM messages m
         JOIN email_accounts a ON a.id = m.account_id
        WHERE a.user_id = $1
          AND m.is_deleted = false
          AND m.from_email IS NOT NULL
          AND m.subject ~* $2
        ORDER BY lower(m.from_email), m.date DESC
     )
     SELECT id, account_id, subject, from_name, from_email, date, body
       FROM latest
      WHERE NOT EXISTS (SELECT 1 FROM ooo_scan_state s WHERE s.message_id = latest.id)
      ORDER BY date DESC
      LIMIT $3`,
    [userId, OOO_SUBJECT_RE, MAX_PER_RUN]
  );

  const created = [];
  // A provider-level failure (quota exhausted, bad key, rate limit) hits every message,
  // so as soon as we see one, stop the run instead of hammering hundreds of dead calls.
  // The affected messages stay unscanned and retry once access returns.
  let providerError = null;
  await bounded(candidates, SCAN_CONCURRENCY, async (m) => {
    if (providerError) return;
    let result;
    try {
      const raw = await aiComplete(oooCfg, buildOooPrompt({
        subject: m.subject,
        from: m.from_name || m.from_email,
        body: m.body,
      }), { timeoutMs: 45000 });
      result = parseOooResult(raw);
    } catch (err) {
      console.warn(`OOO scan: AI call failed for message ${m.id}: ${err.message}`);
      if (/usage limit|quota|rate limit|too many request|insufficient|billing|invalid api key|unauthor|\b(401|402|403|429)\b/i.test(err.message)) {
        providerError = err.message;
      }
      // Leave this message unscanned so a later run retries it, then move on.
      return;
    }
    // Mark scanned regardless of outcome so we never re-charge for it.
    await query(
      'INSERT INTO ooo_scan_state (message_id) VALUES ($1) ON CONFLICT (message_id) DO NOTHING',
      [m.id]
    );
    if (!isActionable(result)) return;

    const ins = await query(
      `INSERT INTO ooo_suggestions
         (user_id, account_id, source_message_id, category, person_name, person_email,
          new_email, new_company, role, alt_contacts, source_quote, from_email, subject,
          message_date, confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        userId, m.account_id, m.id, result.category,
        result.person?.name || m.from_name || null,
        m.from_email || null,
        result.person?.new_email || null,
        result.person?.new_company || null,
        result.person?.role || null,
        JSON.stringify(result.alt_contacts),
        result.source_quote || null,
        m.from_email || null,
        m.subject || null,
        m.date || null,
        result.confidence,
      ]
    );
    created.push({ id: ins.rows[0].id, ...result, from_email: m.from_email, subject: m.subject });
  });

  if (created.length > 0) {
    await notifyUser(userId, created).catch(err =>
      console.warn(`OOO scan: notification email failed for user ${userId}: ${err.message}`)
    );
    await query(
      "UPDATE ooo_suggestions SET status = 'notified' WHERE user_id = $1 AND status = 'new'",
      [userId]
    );
  }

  // Remaining senders whose latest out-of-office reply is still unscanned — the same
  // per-sender unit the candidate query works in, so the UI counts people, not copies.
  const { rows: rem } = await query(
    `WITH latest AS (
       SELECT DISTINCT ON (lower(m.from_email)) m.id
         FROM messages m JOIN email_accounts a ON a.id = m.account_id
        WHERE a.user_id = $1 AND m.is_deleted = false AND m.from_email IS NOT NULL
          AND m.subject ~* $2
        ORDER BY lower(m.from_email), m.date DESC
     )
     SELECT COUNT(*)::int AS n FROM latest
      WHERE NOT EXISTS (SELECT 1 FROM ooo_scan_state s WHERE s.message_id = latest.id)`,
    [userId, OOO_SUBJECT_RE]
  );

  return {
    scanned: candidates.length,
    suggestions: created.length,
    remaining: rem[0]?.n ?? 0,
    providerError,
  };
}

async function notifyUser(userId, created) {
  // No primary email on the user record — notify the recovery address if set, else the
  // user's first email account (their own mailbox).
  const { rows } = await query(
    `SELECT COALESCE(
              NULLIF(u.recovery_email, ''),
              (SELECT ea.email_address FROM email_accounts ea
                WHERE ea.user_id = u.id AND ea.enabled = true
                ORDER BY ea.sort_order ASC, ea.created_at ASC
                LIMIT 1)
            ) AS email
       FROM users u WHERE u.id = $1`,
    [userId]
  );
  const to = rows[0]?.email;
  if (!to) return;

  const lines = created.map((c) => {
    if (c.category === 'left_or_moved') {
      const bits = [c.person?.name || c.from_email];
      if (c.person?.new_email) bits.push(`new email ${c.person.new_email}`);
      if (c.person?.new_company) bits.push(`now at ${c.person.new_company}`);
      return `• Moved/left: ${bits.join(' — ')}\n  “${(c.source_quote || '').slice(0, 160)}”`;
    }
    const alt = (c.alt_contacts || []).map(a =>
      [a.name, a.email, a.role, a.company].filter(Boolean).join(', ')).join('; ');
    return `• New contact mentioned by ${c.from_email}: ${alt}\n  “${(c.source_quote || '').slice(0, 160)}”`;
  });

  const text =
    `MailFlow scanned your out-of-office replies and found ${created.length} possible contact update(s) to review:\n\n` +
    lines.join('\n\n') +
    `\n\nThese are suggestions only — nothing has been changed. Review and apply the ones you want.`;

  await sendSystemEmail({
    to,
    subject: `MailFlow: ${created.length} contact update${created.length === 1 ? '' : 's'} to review`,
    text,
  });
}
