const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

// GET reads of the treasury board are public, matching this app's "no login"
// product rule: the balance, the history and the member list are community
// content anyone who opens the app can see. Only these paths, GET only —
// recording an entry still requires a valid platform-issued token.
const PUBLIC_READ_PATHS = new Set(['/api/summary', '/api/entries', '/api/members']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (req.method === 'GET' && PUBLIC_READ_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---- Treasury API -------------------------------------------------------
// Money is stored as integer cents, never floats. `kind` is 'in' (money
// into the treasury) or 'out' (an expense). Entries are community content:
// the payer is a free-text name typed on the form, not a platform account.

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseAmountCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  if (!Number.isInteger(cents) || cents <= 0 || cents > 100000000) return null;
  return cents;
}

// Home screen: current balance, this month's money in / money out, and the
// ten latest entries.
app.get('/api/summary', async (_req, res) => {
  try {
    const [totals, month, latest] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN kind = 'in'  THEN amount_cents END), 0) AS in_cents,
          COALESCE(SUM(CASE WHEN kind = 'out' THEN amount_cents END), 0) AS out_cents
        FROM entries
      `),
      pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN kind = 'in'  THEN amount_cents END), 0) AS in_cents,
          COALESCE(SUM(CASE WHEN kind = 'out' THEN amount_cents END), 0) AS out_cents
        FROM entries
        WHERE created_at >= date_trunc('month', NOW())
      `),
      pool.query(`
        SELECT id, kind, amount_cents, payer, note, created_at
        FROM entries
        ORDER BY created_at DESC, id DESC
        LIMIT 10
      `),
    ]);
    res.json({
      balance_cents: Number(totals.rows[0].in_cents) - Number(totals.rows[0].out_cents),
      month_in_cents: Number(month.rows[0].in_cents),
      month_out_cents: Number(month.rows[0].out_cents),
      latest: latest.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record an entry. Amount arrives as a decimal dollar number and is stored
// as integer cents.
app.post('/api/entries', async (req, res) => {
  const kind = req.body && req.body.kind;
  const payer = typeof (req.body && req.body.payer) === 'string'
    ? req.body.payer.trim() : '';
  const note = typeof (req.body && req.body.note) === 'string'
    ? req.body.note.trim() : '';
  const cents = parseAmountCents(req.body && req.body.amount);

  if (kind !== 'in' && kind !== 'out') {
    return res.status(400).json({ error: 'Type must be in or out' });
  }
  if (cents === null) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }
  if (!payer) {
    return res.status(400).json({ error: 'Name is required' });
  }
  if (payer.length > 255 || note.length > 500) {
    return res.status(400).json({ error: 'Name or note is too long' });
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO entries (kind, amount_cents, payer, note)
      VALUES ($1, $2, $3, $4)
      RETURNING id, kind, amount_cents, payer, note, created_at
    `, [kind, cents, payer, note]);
    res.status(201).json({ entry: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// History: every entry, newest first, optionally filtered by payer name
// (exact, case-insensitive) and/or month ("YYYY-MM").
app.get('/api/entries', async (req, res) => {
  const member = typeof req.query.member === 'string' ? req.query.member.trim() : '';
  const month = typeof req.query.month === 'string' ? req.query.month : '';

  const clauses = [];
  const params = [];
  if (member) {
    params.push(member.toLowerCase());
    clauses.push(`LOWER(payer) = $${params.length}`);
  }
  if (month) {
    if (!MONTH_RE.test(month)) {
      return res.status(400).json({ error: 'Month must look like YYYY-MM' });
    }
    params.push(month + '-01');
    clauses.push(`created_at >= date_trunc('month', $${params.length}::date)
      AND created_at < (date_trunc('month', $${params.length}::date) + INTERVAL '1 month')`);
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  try {
    const { rows } = await pool.query(`
      SELECT id, kind, amount_cents, payer, note, created_at
      FROM entries
      ${where}
      ORDER BY created_at DESC, id DESC
    `, params);
    res.json({ entries: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Distinct payer names, for the history filter dropdown.
app.get('/api/members', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT payer FROM entries ORDER BY payer
    `);
    res.json({ members: rows.map(r => r.payer) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/community-treasury-5d64a5/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/community-treasury-5d64a5/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entries (
      id SERIAL PRIMARY KEY,
      kind VARCHAR(3) NOT NULL CHECK (kind IN ('in', 'out')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      payer VARCHAR(255) NOT NULL,
      note VARCHAR(500) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // The demo `presses` table belonged to the starter template, which this
  // change replaces; drop it so fresh bootstraps don't carry it forward.
  await pool.query('DROP TABLE IF EXISTS presses');

  // Staging previews start from a copy of production, but this table is
  // brand new, so it is empty there. Seed a handful of obviously fake rows
  // so the home and history screens are reviewable. Fake identities only,
  // never the visitor. The guard makes it idempotent: staging containers
  // reboot on every push, and without it the batch would duplicate.
  if (IS_STAGING) {
    await pool.query(`
      INSERT INTO entries (kind, amount_cents, payer, note, created_at)
      SELECT * FROM (VALUES
        ('in'::text,  250000, 'Staging demo Alice'::text, 'Monthly contribution'::text, NOW() - INTERVAL '2 months 3 days'),
        ('out',        12000, 'Staging demo Bob',   'Pizza for game night', NOW() - INTERVAL '1 month 20 days'),
        ('in',        100000, 'Staging demo Carol', 'Bake sale proceeds',   NOW() - INTERVAL '1 month 5 days'),
        ('out',        45000, 'Staging demo Alice', 'Board game restock',   NOW() - INTERVAL '10 days'),
        ('in',         50000, 'Staging demo Bob',   'Membership dues',      NOW() - INTERVAL '6 hours')
      ) AS seed(kind, amount_cents, payer, note, created_at)
      WHERE NOT EXISTS (
        SELECT 1 FROM entries WHERE payer LIKE 'Staging demo %'
      )
    `);
  }

  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  return server;
}

// Graceful shutdown: the container is stopped and replaced on every deploy,
// so stop accepting connections, give in-flight requests a bounded drain,
// close the pool, exit. Idempotent — a repeat signal must not double-run.
const DRAIN_MS = 3000;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  try { global.__treasuryServer?.close(() => {}); } catch {}
  try { global.__treasuryServer?.closeIdleConnections?.(); } catch {}
  const t = setTimeout(() => global.__treasuryServer?.closeAllConnections?.(), DRAIN_MS);
  t.unref?.();
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start()
  .then(server => { global.__treasuryServer = server; })
  .catch(err => { console.error(err); process.exit(1); });
