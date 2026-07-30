import { query } from './db.js';
import { refreshUserTasks } from './taskRefresh.js';
import { runDraftSweep } from './draftWriter.js';

// Daily auto-refresh of the Tasks hub. Polls every few minutes; for each user who
// has opted in (preferences.taskAutoRefresh.enabled) and has task folders set, runs
// one refresh once per local day at or after their target hour. Opt-in, timezone
// aware, and idempotent per day via a stored lastRun date.

const POLL_MS = 5 * 60 * 1000;        // 5 minutes — daily refresh gate
const DRAFT_POLL_MS = 20 * 60 * 1000; // 20 minutes — background draft sweep
const DEFAULT_TZ = process.env.TASK_TZ || 'Europe/London';
let timer = null;
let draftTimer = null;

// { hour: 0-23, date: 'YYYY-MM-DD' } in the given IANA timezone.
function localParts(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || DEFAULT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t)?.value;
  let hour = Number(get('hour'));
  if (!Number.isFinite(hour) || hour === 24) hour = 0;   // some engines emit '24' at midnight
  return { hour, date: `${get('year')}-${get('month')}-${get('day')}` };
}

function hasSources(prefs) {
  const sources = prefs?.taskSources || {};
  return Object.values(sources).some(s => s && s.enabled !== false && Array.isArray(s.folders) && s.folders.length);
}

async function stampLastRun(userId, date) {
  await query(
    `UPDATE users SET preferences =
       jsonb_set(COALESCE(preferences,'{}'::jsonb), '{taskAutoRefresh,lastRun}', to_jsonb($2::text), true)
     WHERE id = $1`,
    [userId, date]
  );
}

async function tick() {
  let users;
  try { users = await query('SELECT id, preferences FROM users'); }
  catch (e) { console.warn('[task-scheduler] user query failed:', e.message); return; }

  for (const u of users.rows) {
    const prefs = u.preferences || {};
    const cfg = prefs.taskAutoRefresh;
    if (!cfg || cfg.enabled === false) continue;      // opt-in only
    if (!hasSources(prefs)) continue;

    const tz = cfg.tz || DEFAULT_TZ;
    const targetHour = Number.isInteger(cfg.hour) ? cfg.hour : 8;
    const { hour, date } = localParts(tz);
    if (hour < targetHour || cfg.lastRun === date) continue;

    // Stamp first so a crash mid-run doesn't cause a retry storm; a failed provider
    // then simply waits until tomorrow rather than every 5 minutes all day.
    await stampLastRun(u.id, date).catch(() => {});
    try {
      const r = await refreshUserTasks(u.id);
      console.log(`[task-scheduler] ${u.id}: +${r.added} tasks, ${r.completed} auto-done (${r.folders} folders)`);
    } catch (e) {
      if (e.code !== 'NO_SOURCES') console.warn(`[task-scheduler] ${u.id}: ${e.message}`);
    }
  }
}

// Background auto-drafts: for each opted-in user (preferences.autoDrafts.enabled),
// draft replies for recent unanswered mail in their watched folders. Bounded per run
// by runDraftSweep. Runs on its own slower cadence, independent of the daily gate.
async function draftTick() {
  let users;
  try { users = await query("SELECT id, preferences FROM users"); }
  catch (e) { console.warn('[draft-sweep] user query failed:', e.message); return; }
  for (const u of users.rows) {
    const prefs = u.preferences || {};
    if (prefs.autoDrafts?.enabled !== true) continue;
    if (!hasSources(prefs)) continue;
    try {
      const r = await runDraftSweep(u.id);
      if (r.created) console.log(`[draft-sweep] ${u.id}: drafted ${r.created} repl${r.created === 1 ? 'y' : 'ies'}`);
    } catch (e) {
      if (e.code !== 'NO_SOURCES') console.warn(`[draft-sweep] ${u.id}: ${e.message}`);
    }
  }
}

export function startTaskScheduler() {
  if (timer) return;
  // A first tick shortly after boot catches a user whose target hour already passed
  // today (e.g. a restart at 10am), then steady polling.
  timer = setInterval(() => { tick().catch(e => console.warn('[task-scheduler] tick error:', e.message)); }, POLL_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => { tick().catch(() => {}); }, 30000).unref?.();

  draftTimer = setInterval(() => { draftTick().catch(e => console.warn('[draft-sweep] tick error:', e.message)); }, DRAFT_POLL_MS);
  if (draftTimer.unref) draftTimer.unref();
  setTimeout(() => { draftTick().catch(() => {}); }, 90000).unref?.();

  console.log(`[task-scheduler] started (poll ${POLL_MS / 60000}m, drafts ${DRAFT_POLL_MS / 60000}m, default tz ${DEFAULT_TZ})`);
}

export function stopTaskScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
  if (draftTimer) { clearInterval(draftTimer); draftTimer = null; }
}
