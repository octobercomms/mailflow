// App branding: the in-app logo shown in the sidebar and on the login screen (NOT the
// favicon / PWA icon). Admins upload an image through appearance settings; it is stored
// in the database and served at /api/branding/logo. GET is public (the login screen must
// load it before sign-in); upload/delete require an admin.
import { Router } from 'express';
import express from 'express';
import { query } from '../services/db.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MIME_BY_EXT = {
  gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// Serve the logo. Public.
router.get('/branding/logo', async (req, res) => {
  try {
    const r = await query("SELECT data, mime FROM app_branding WHERE name = 'logo'");
    if (!r.rows.length) return res.status(404).end();
    res.setHeader('Content-Type', r.rows[0].mime || 'application/octet-stream');
    // Small file that can change on upload; revalidate rather than cache hard.
    res.setHeader('Cache-Control', 'no-cache');
    res.send(r.rows[0].data);
  } catch {
    res.status(500).end();
  }
});

// Upload/replace the logo. Admin only. Raw body; filename (for the type) via the query.
router.post('/branding/logo', requireAdmin, express.raw({ type: '*/*', limit: MAX_BYTES }), async (req, res) => {
  const mime = MIME_BY_EXT[extOf(req.query.filename)];
  if (!mime) return res.status(400).json({ error: 'Only .gif, .png, .jpg and .webp images are allowed' });
  const data = req.body;
  if (!Buffer.isBuffer(data) || data.length === 0) return res.status(400).json({ error: 'The uploaded file was empty' });
  if (data.length > MAX_BYTES) return res.status(413).json({ error: 'Logo is too large (5 MB max)' });
  await query(
    `INSERT INTO app_branding (name, mime, data)
     VALUES ('logo', $1, $2)
     ON CONFLICT (name) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = NOW()`,
    [mime, data]
  );
  res.json({ ok: true });
});

// Remove the logo (revert to the built-in mark). Admin only.
router.delete('/branding/logo', requireAdmin, async (req, res) => {
  await query("DELETE FROM app_branding WHERE name = 'logo'");
  res.json({ ok: true });
});

export default router;
