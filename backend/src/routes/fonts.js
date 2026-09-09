// Custom font uploads (e.g. Brockmann). Admins upload font files through the app's
// appearance settings; the files are stored in the database and served back at
// /api/fonts/custom/<filename>. A generated stylesheet at /api/fonts/custom.css declares
// an @font-face for each uploaded file (family 'Brockmann'), with weight/style inferred
// from the filename. The GET routes are public so the browser can load the fonts before
// (and after) sign-in; upload/list/delete require an admin.
import { Router } from 'express';
import express from 'express';
import { query } from '../services/db.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file
const MIME_BY_EXT = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };
const FORMAT_BY_EXT = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

// Strip any path, keep a plain base filename with a safe character set.
function safeName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  return base.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 200);
}
function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// Infer the CSS font-weight and font-style for an @font-face from the filename, so
// whatever weights the user uploads map to the right place without manual mapping.
function inferWeightStyle(name) {
  const n = String(name).toLowerCase();
  const style = /italic|oblique/.test(n) ? 'italic' : 'normal';
  // Order matters: check the more specific keywords before the shorter ones
  // ("semibold"/"extrabold" before "bold", "extralight" before "light").
  const table = [
    ['thin', 100], ['hairline', 100],
    ['extralight', 200], ['ultralight', 200],
    ['semibold', 600], ['demibold', 600],
    ['extrabold', 800], ['ultrabold', 800],
    ['medium', 500],
    ['black', 900], ['heavy', 900],
    ['light', 300],
    ['bold', 700],
    ['regular', 400], ['normal', 400], ['book', 400],
  ];
  let weight = 400;
  for (const [kw, w] of table) {
    if (n.includes(kw)) { weight = w; break; }
  }
  return { weight, style };
}

// Generated stylesheet: one @font-face per uploaded file. Public.
router.get('/fonts/custom.css', async (req, res) => {
  try {
    const r = await query('SELECT filename FROM custom_fonts ORDER BY filename');
    let css = '/* Generated from uploaded custom fonts (family: Brockmann). */\n';
    for (const { filename } of r.rows) {
      const fmt = FORMAT_BY_EXT[extOf(filename)];
      if (!fmt) continue;
      const { weight, style } = inferWeightStyle(filename);
      css += `@font-face{font-family:'Brockmann';font-style:${style};font-weight:${weight};`
        + `font-display:swap;src:url(/api/fonts/custom/${encodeURIComponent(filename)}) format('${fmt}');}\n`;
    }
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    // Let the client re-fetch after an upload/delete rather than caching an empty sheet.
    res.setHeader('Cache-Control', 'no-cache');
    res.send(css);
  } catch {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    res.status(200).send('/* custom font css unavailable */');
  }
});

// Serve a single font file. Public.
router.get('/fonts/custom/:filename', async (req, res) => {
  const filename = safeName(req.params.filename);
  const mime = MIME_BY_EXT[extOf(filename)];
  if (!mime) return res.status(404).end();
  try {
    const r = await query('SELECT data, mime FROM custom_fonts WHERE filename = $1', [filename]);
    if (!r.rows.length) return res.status(404).end();
    res.setHeader('Content-Type', r.rows[0].mime || mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(r.rows[0].data);
  } catch {
    res.status(500).end();
  }
});

// List uploaded fonts. Admin only.
router.get('/fonts/manage', requireAdmin, async (req, res) => {
  const r = await query('SELECT filename, size, created_at FROM custom_fonts ORDER BY filename');
  res.json({ fonts: r.rows });
});

// Upload (or replace) a font file. Admin only. Raw body; filename comes from the query.
router.post('/fonts/upload', requireAdmin, express.raw({ type: '*/*', limit: MAX_BYTES }), async (req, res) => {
  const filename = safeName(req.query.filename);
  if (!filename) return res.status(400).json({ error: 'A filename is required' });
  const mime = MIME_BY_EXT[extOf(filename)];
  if (!mime) return res.status(400).json({ error: 'Only .woff2, .woff, .ttf and .otf files are allowed' });
  const data = req.body;
  if (!Buffer.isBuffer(data) || data.length === 0) return res.status(400).json({ error: 'The uploaded file was empty' });
  if (data.length > MAX_BYTES) return res.status(413).json({ error: 'Font file is too large (5 MB max)' });
  await query(
    `INSERT INTO custom_fonts (filename, mime, size, data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (filename) DO UPDATE
       SET mime = EXCLUDED.mime, size = EXCLUDED.size, data = EXCLUDED.data, created_at = NOW()`,
    [filename, mime, data.length, data]
  );
  res.json({ ok: true, filename, size: data.length });
});

// Delete a font file. Admin only.
router.delete('/fonts/manage/:filename', requireAdmin, async (req, res) => {
  const filename = safeName(req.params.filename);
  await query('DELETE FROM custom_fonts WHERE filename = $1', [filename]);
  res.json({ ok: true });
});

export default router;
