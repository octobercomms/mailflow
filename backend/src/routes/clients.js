import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { loadLegendText, parseLegend, loadAiConfig } from '../services/taskGenerator.js';
import { loadClientBriefs, getBrief, upsertBrief, generateClientBrief } from '../services/clientBriefs.js';

// Client knowledge layer API. The client roster comes from the shared legend; each
// client can carry a living brief the AI maintains from recent mail (and the user can
// hand-edit). Briefs feed back into task generation and reply drafting.
const router = Router();
const uid = (req) => req.session.userId;

// Roster: every legend client, merged with any stored brief.
router.get('/clients', requireAuth, async (req, res) => {
  const [legendText, briefs] = await Promise.all([loadLegendText(), loadClientBriefs(uid(req))]);
  const byClient = new Map(briefs.map(b => [b.client.toLowerCase(), b]));
  const legendClients = parseLegend(legendText).map(e => e.client);
  const seen = new Set();
  const clients = [];
  for (const name of legendClients) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const b = byClient.get(key);
    clients.push({ client: name, hasBrief: !!(b && b.brief), auto: b ? b.auto : true, updatedAt: b?.updated_at || null, refreshedAt: b?.refreshed_at || null });
  }
  // Include briefs whose client is no longer in the legend, so nothing is orphaned.
  for (const b of briefs) {
    if (seen.has(b.client.toLowerCase())) continue;
    clients.push({ client: b.client, hasBrief: !!b.brief, auto: b.auto, updatedAt: b.updated_at, refreshedAt: b.refreshed_at, orphan: true });
  }
  res.json({ clients });
});

router.get('/clients/:client', requireAuth, async (req, res) => {
  const b = await getBrief(uid(req), req.params.client);
  res.json({ client: req.params.client, brief: b?.brief || '', auto: b ? b.auto : true, updatedAt: b?.updated_at || null, refreshedAt: b?.refreshed_at || null });
});

// Hand-edit a brief. Marks auto=false so a later regenerate won't silently overwrite it.
router.put('/clients/:client', requireAuth, async (req, res) => {
  const { brief } = req.body || {};
  if (typeof brief !== 'string') return res.status(400).json({ error: 'brief must be a string' });
  const saved = await upsertBrief(uid(req), req.params.client, { brief, auto: false });
  res.json({ ok: true, ...saved });
});

// Regenerate one client's brief from recent mail. force overrides the hand-edited guard.
router.post('/clients/:client/regenerate', requireAuth, async (req, res) => {
  let cfg;
  try { cfg = await loadAiConfig(); }
  catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  try {
    const result = await generateClientBrief(uid(req), req.params.client, cfg, { force: req.body?.force === true });
    res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'HAND_EDITED') return res.status(409).json({ error: err.message, code: 'HAND_EDITED' });
    res.status(err.status || 502).json({ error: err.message || 'Regenerate failed' });
  }
});

export default router;
