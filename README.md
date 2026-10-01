# Community Treasury

A shared treasury board for the community. Anyone can record money coming in
(a contribution) or going out (an expense), and everyone can see where the
treasury stands.

## What's in the app

- **Home** — the current balance, this month's money in and money out, and
  the ten latest entries.
- **Add entry** — record an entry: type (money in / money out), amount,
  the payer's name, and an optional note.
- **History** — every entry, newest first, filterable by member and by month.

No login and no wallet: the payer is a name typed on the form. Visitors are
authenticated only by the Homeroom platform itself, as with every app here.

## How it works

- Node/Express server (`server.js`) with its own PostgreSQL database.
- Entries live in the `entries` table; amounts are stored as **integer
  cents**, never floats (`amount_cents`).
- API: `GET /api/summary` (balance, month totals, latest 10),
  `POST /api/entries`, `GET /api/entries?member=&month=YYYY-MM`,
  `GET /api/members` (distinct payer names for the history filter).
- Styling is Tailwind, precompiled by `npm run build` during the image
  build; the frontend is a single hash-routed page in `public/index.html`.
