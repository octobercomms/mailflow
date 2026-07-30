import { query } from './db.js';
import { imapManager } from '../index.js';
import { aiComplete, loadAiConfig, loadLegendText, parseLegend } from './taskGenerator.js';
import { loadClientBriefs } from './clientBriefs.js';
import { sanitizeEmail } from './emailSanitizer.js';

// Auto-drafts. For emails that look like they need a reply, draft one in the owner's
// voice and stash it (status 'suggested') so a suggestion is waiting when they open
// the message. Never sends, never writes to the mailbox — approval-gated by design.

const nz = (s) => (typeof s === 'string' ? s.replace(/\0/g, '') : s);
const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const htmlToText = (html) => String(html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ').trim();

const SWEEP_MAX_PER_RUN = 8;       // cap AI calls per sweep
const CANDIDATE_LOOKBACK_DAYS = 14;
const VOICE_SAMPLES = 4;

// The account's own addresses, so we can tell "from me" from "to me".
function accountAddresses(account) {
  const set = new Set();
  if (account.email_address) set.add(account.email_address.toLowerCase());
  let aliases = account.aliases;
  if (typeof aliases === 'string') { try { aliases = JSON.parse(aliases); } catch { aliases = []; } }
  for (const a of aliases || []) if (a?.email) set.add(a.email.toLowerCase());
  return set;
}

// A few of the owner's recent sent replies, as a private style reference (never shown
// to anyone — only fed to the model so the draft sounds like them).
async function loadVoiceSamples(account) {
  const sent = (await query(
    `SELECT path FROM folders WHERE account_id = $1
       AND (special_use ILIKE '%sent%' OR name ILIKE 'sent%' OR path ILIKE '%sent%')
     ORDER BY (special_use ILIKE '%sent%') DESC LIMIT 1`,
    [account.id]
  )).rows[0];
  if (!sent) return [];
  const rows = (await query(
    `SELECT body_text, snippet FROM messages
      WHERE account_id = $1 AND folder = $2 AND body_text IS NOT NULL AND length(body_text) > 40
      ORDER BY date DESC LIMIT $3`,
    [account.id, sent.path, VOICE_SAMPLES]
  )).rows;
  return rows.map(r => clip(r.body_text || r.snippet, 700)).filter(Boolean);
}

// Ensure the source message has a real body to reply to; fetch + cache on demand.
async function ensureBody(account, m) {
  if (m.body_text && m.body_text.trim()) return m.body_text;
  if (!m.uid) return m.snippet || '';
  try {
    const { html, text, attachments } = await imapManager.fetchMessageBody(account, m.uid, m.folder);
    const safeHtml = html ? sanitizeEmail(html) : null;
    const plain = (text && text.trim()) ? text : (safeHtml ? htmlToText(safeHtml) : '');
    if (safeHtml || text) {
      await query(
        `UPDATE messages SET body_html = $1, body_text = $2, attachments = $3 WHERE id = $4`,
        [nz(safeHtml), nz(text || ''), JSON.stringify(attachments || []), m.id]
      );
    }
    return plain || m.snippet || '';
  } catch { return m.snippet || ''; }
}

function clientBriefFor(message, briefs, legend) {
  if (!briefs.length) return '';
  const hay = `${message.from_email || ''} ${message.from_name || ''} ${message.subject || ''}`.toLowerCase();
  for (const { client, terms } of legend) {
    if (client && (hay.includes(client.toLowerCase()) || terms.some(t => t && hay.includes(t)))) {
      const b = briefs.find(x => x.client.toLowerCase() === client.toLowerCase());
      if (b?.brief) return `WHAT YOU KNOW ABOUT THIS CLIENT (${b.client}):\n${clip(b.brief, 1200)}`;
    }
  }
  return '';
}

// Draft one reply. Returns the plain-text body (no send, no store).
export async function generateReplyDraft({ account, message, bodyText, cfg, briefBlock, voiceSamples, signature }) {
  const from = clip(message.from_name || message.from_email || 'the sender', 80);
  const voiceBlock = voiceSamples?.length
    ? 'HOW THE USER WRITES — match this voice (tone, length, greeting/sign-off habits). These are past replies of theirs, for STYLE ONLY; do not reuse their content:\n' +
      voiceSamples.map((s, i) => `Example ${i + 1}: ${s}`).join('\n') + '\n\n'
    : '';
  const system =
    'You draft a reply email on behalf of a busy agency owner, in their voice, ready for them to review and send. ' +
    'Write only the reply body — no subject line, no "Draft:" preamble, no meta commentary. ' +
    'Be helpful and specific: actually address what the email asks, using the client context if given. ' +
    'Where you genuinely lack a fact the user must supply (a price, a date, an attachment), leave a clearly marked ' +
    '[bracketed placeholder] rather than inventing it. Keep it concise and professional; match the user\'s style samples. ' +
    'Do NOT include a signature block — one is appended separately. Never fabricate commitments or figures.';
  const user =
    `${voiceBlock}` +
    `${briefBlock ? briefBlock + '\n\n' : ''}` +
    `EMAIL TO REPLY TO — from ${from}, subject "${clip(message.subject, 160) || '(no subject)'}":\n` +
    `${clip(bodyText, 4000)}\n\n` +
    'Draft the reply body now.';

  let draft = (await aiComplete(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])).trim();

  if (signature && signature.trim()) {
    const sigText = htmlToText(signature).trim();
    if (sigText && !draft.includes(sigText.slice(0, 20))) draft += `\n\n${sigText}`;
  }
  return draft;
}

// Sweep a user's watched folders and draft replies for recent, unanswered, human
// emails that don't have a suggestion yet. Bounded per run. Returns a summary.
export async function runDraftSweep(userId, { max = SWEEP_MAX_PER_RUN } = {}) {
  const cfg = await loadAiConfig();

  const prefRow = await query('SELECT preferences FROM users WHERE id = $1', [userId]);
  const prefs = prefRow.rows[0]?.preferences || {};
  const sources = prefs.taskSources || {};

  const accts = await query('SELECT * FROM email_accounts WHERE user_id = $1 AND enabled = true', [userId]);
  const legend = parseLegend(await loadLegendText());
  const briefs = await loadClientBriefs(userId);

  let created = 0, considered = 0;
  for (const account of accts.rows) {
    if (created >= max) break;
    const c = sources[account.id];
    if (!c || c.enabled === false) continue;
    const folders = (Array.isArray(c.folders) ? c.folders : []).filter(Boolean);
    if (!folders.length) continue;

    const mine = accountAddresses(account);
    const voiceSamples = await loadVoiceSamples(account);
    const signature = account.signature || '';
    const briefBlockCache = new Map();

    for (const folder of folders) {
      if (created >= max) break;
      // Candidate messages: recent, in the folder, not already drafted/dismissed.
      const cands = (await query(
        `SELECT m.id, m.uid, m.message_id, m.subject, m.from_name, m.from_email, m.snippet, m.body_text, m.date,
                $4::text AS folder
           FROM messages m
           LEFT JOIN ai_drafts d ON d.user_id = $2 AND d.message_id = m.message_id
          WHERE m.account_id = $1 AND m.folder = $4
            AND m.date > NOW() - INTERVAL '${CANDIDATE_LOOKBACK_DAYS} days'
            AND m.message_id IS NOT NULL
            AND d.id IS NULL
          ORDER BY m.date DESC
          LIMIT 40`,
        [account.id, userId, null, folder]
      )).rows;

      for (const m of cands) {
        if (created >= max) break;
        const fromEmail = (m.from_email || '').toLowerCase();
        if (!fromEmail || mine.has(fromEmail)) continue;                 // skip mail from myself
        if (/(no-?reply|do-?not-?reply|notifications?@|mailer-daemon|postmaster@)/i.test(fromEmail)) continue;
        considered++;

        try {
          const bodyText = await ensureBody(account, m);
          if (!bodyText || bodyText.length < 20) continue;              // nothing substantive to reply to

          let briefBlock = briefBlockCache.get(fromEmail);
          if (briefBlock === undefined) { briefBlock = clientBriefFor(m, briefs, legend); briefBlockCache.set(fromEmail, briefBlock); }

          const body = await generateReplyDraft({ account, message: m, bodyText, cfg, briefBlock, voiceSamples, signature });
          const rawSubject = (m.subject || '').trim();
          const reSubject = rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:';
          await query(
            `INSERT INTO ai_drafts (user_id, account_id, message_id, subject, body, status)
               VALUES ($1,$2,$3,$4,$5,'suggested')
             ON CONFLICT (user_id, message_id) DO NOTHING`,
            [userId, account.id, m.message_id, reSubject.slice(0, 500), nz(body).slice(0, 8000)]
          );
          created++;
        } catch (err) {
          if (/THROTTL/i.test(err?.message || '')) return { created, considered, throttled: true };
        }
      }
    }
  }
  return { created, considered };
}

// On-demand draft for a single open email (the "Draft a reply" button). Generates and
// stores (or refreshes) a suggestion regardless of the sweep heuristics.
export async function generateDraftForMessageId(userId, messageId) {
  const cfg = await loadAiConfig();
  const row = (await query(
    `SELECT m.*, m.folder AS folder FROM messages m
       JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND m.message_id = $2
      ORDER BY m.date DESC LIMIT 1`,
    [userId, messageId]
  )).rows[0];
  if (!row) { const e = new Error('Message not found'); e.status = 404; throw e; }
  const account = (await query('SELECT * FROM email_accounts WHERE id = $1', [row.account_id])).rows[0];

  const legend = parseLegend(await loadLegendText());
  const briefs = await loadClientBriefs(userId);
  const bodyText = await ensureBody(account, row);
  const briefBlock = clientBriefFor(row, briefs, legend);
  const voiceSamples = await loadVoiceSamples(account);
  const body = await generateReplyDraft({ account, message: row, bodyText, cfg, briefBlock, voiceSamples, signature: account.signature || '' });

  const rawSubject = (row.subject || '').trim();
  const reSubject = rawSubject.startsWith('Re:') ? rawSubject : rawSubject ? `Re: ${rawSubject}` : 'Re:';
  const saved = (await query(
    `INSERT INTO ai_drafts (user_id, account_id, message_id, subject, body, status)
       VALUES ($1,$2,$3,$4,$5,'suggested')
     ON CONFLICT (user_id, message_id) DO UPDATE SET body = $5, subject = $4, status = 'suggested', updated_at = NOW()
     RETURNING id, message_id, subject, body, status`,
    [userId, account.id, messageId, reSubject.slice(0, 500), nz(body).slice(0, 8000)]
  )).rows[0];
  return saved;
}
