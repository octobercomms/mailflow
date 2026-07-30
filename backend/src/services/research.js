import { query } from './db.js';
import { encrypt, decrypt } from './encryption.js';
import { aiComplete, loadAiConfig } from './taskGenerator.js';

// Phase 7 — the agentic layer, kept deliberately narrow and approval-gated. The only
// autonomous-feeling action is research: when a task/email is "look into X", the user
// explicitly asks Claude to research it, and this runs a web search (if a provider is
// configured) then synthesises a cited note. Nothing here runs on a schedule or without
// a direct user click. If no search provider is set, it answers from the model's own
// knowledge, clearly flagged as not web-verified.

const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

export async function loadResearchConfig() {
  const r = await query("SELECT value FROM system_settings WHERE key = 'research_config'");
  if (!r.rows.length) return { provider: 'none', apiKey: null };
  try { return JSON.parse(r.rows[0].value); } catch { return { provider: 'none', apiKey: null }; }
}

export async function saveResearchConfig({ provider, apiKey }) {
  const existing = await loadResearchConfig();
  const key = apiKey && apiKey !== '••••••••' ? encrypt(apiKey) : (existing.apiKey || null);
  const cfg = { provider: ['tavily', 'brave', 'none'].includes(provider) ? provider : 'none', apiKey: key };
  await query(
    `INSERT INTO system_settings (key, value, updated_at) VALUES ('research_config', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(cfg)]
  );
  return cfg;
}

// Provider calls hit fixed, public search-API hosts (not user-supplied URLs), so plain
// fetch is fine — no SSRF surface. Returns { results: [{title,url,content}], answer? }.
async function webSearch(cfg, question) {
  const key = cfg.apiKey ? decrypt(cfg.apiKey) : null;
  if (cfg.provider === 'tavily' && key) {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query: question, search_depth: 'basic', max_results: 6, include_answer: true }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw Object.assign(new Error(`Search provider error (${r.status})`), { status: 502 });
    const d = await r.json();
    return { results: (d.results || []).map(x => ({ title: x.title, url: x.url, content: x.content })), answer: d.answer || null };
  }
  if (cfg.provider === 'brave' && key) {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(question)}&count=6`, {
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': key },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw Object.assign(new Error(`Search provider error (${r.status})`), { status: 502 });
    const d = await r.json();
    const web = d.web?.results || [];
    return { results: web.map(x => ({ title: x.title, url: x.url, content: x.description })), answer: null };
  }
  return null;   // no provider → model-only
}

// Run a research request. `context` is optional background (e.g. the email/task text).
export async function runResearch(userId, { question, context = '' }) {
  const q = clip(question, 500);
  if (!q) { const e = new Error('A research question is required'); e.status = 400; throw e; }
  const aiCfg = await loadAiConfig();
  const rcfg = await loadResearchConfig();

  let search = null;
  let searchError = null;
  try { search = await webSearch(rcfg, q); }
  catch (err) { searchError = err.message; }

  const webVerified = !!(search && search.results && search.results.length);
  const sources = webVerified ? search.results.slice(0, 6) : [];

  const sourceBlock = webVerified
    ? 'WEB RESULTS (cite these by number where you use them):\n' +
      sources.map((s, i) => `[${i + 1}] ${clip(s.title, 140)} — ${s.url}\n${clip(s.content, 600)}`).join('\n\n')
    : '';

  const system =
    'You are a research assistant for a busy agency owner. Answer the research question clearly and usefully: ' +
    'a short summary first, then the key findings as bullets, then any recommended next step. ' +
    (webVerified
      ? 'Base your answer on the web results provided and cite sources inline as [1], [2]. Do not invent facts beyond them.'
      : 'No live web results are available, so answer from your general knowledge and BEGIN with a one-line note that ' +
        'this is not web-verified and may be out of date. Do not fabricate specific figures, prices, or current events.') +
    ' Keep it tight and skimmable.';
  const user =
    `RESEARCH QUESTION: ${q}\n` +
    `${context ? `\nBACKGROUND (from the email/task):\n${clip(context, 1500)}\n` : ''}` +
    `${sourceBlock ? `\n${sourceBlock}\n` : ''}` +
    (search?.answer ? `\nA search engine's own summary (verify against the sources): ${clip(search.answer, 600)}\n` : '') +
    '\nWrite the research note.';

  const answer = (await aiComplete(aiCfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])).trim();

  return { answer, sources, webVerified, provider: rcfg.provider, searchError };
}
