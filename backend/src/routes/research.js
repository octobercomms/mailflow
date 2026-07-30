import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { loadResearchConfig, saveResearchConfig, runResearch } from '../services/research.js';

// Approval-gated research. POST /research only runs on an explicit user action (a click),
// never on a schedule. Admin configures an optional web-search provider; without one,
// results are model-only and flagged as not web-verified.
const router = Router();

router.get('/research/status', requireAuth, async (_req, res) => {
  const cfg = await loadResearchConfig();
  res.json({ provider: cfg.provider || 'none', webSearch: cfg.provider !== 'none' && !!cfg.apiKey });
});

router.post('/research', requireAuth, async (req, res) => {
  const { question, context } = req.body || {};
  if (!question || typeof question !== 'string') return res.status(400).json({ error: 'question is required' });
  try {
    const result = await runResearch(req.session.userId, { question, context: typeof context === 'string' ? context : '' });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || 'Research failed' });
  }
});

// ── Admin config ──────────────────────────────────────────────────────────────
router.get('/admin/research', requireAdmin, async (_req, res) => {
  const cfg = await loadResearchConfig();
  res.json({ config: { provider: cfg.provider || 'none', apiKey: cfg.apiKey ? '••••••••' : '' } });
});

router.patch('/admin/research', requireAdmin, async (req, res) => {
  const { provider, apiKey } = req.body || {};
  const cfg = await saveResearchConfig({ provider, apiKey });
  res.json({ ok: true, provider: cfg.provider });
});

export default router;
