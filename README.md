# Peptide Cycle Log

Static single-page app (`index.html` + `styles.css` + `app.js`) for logging peptide cycles: schedule, titration, dose changes, pauses, vial math.

- **Hosting:** Vercel, deploys automatically on every push to `main`.
- **Accounts & data:** Supabase project `peptide-cycle-log` (`ojxscacnyybvtxffbere`).
  - Sign-in: emailed magic link.
  - `profiles`: name, Telegram username, approval status (`pending` / `approved` / `blocked`), `is_admin`.
  - `cycles`: one row per cycle, cycle object in `data` (jsonb).
  - Row-level security: people only see their own data; only approved people can read/write cycles; only the admin can see everyone's names and change approval status.
- The Supabase URL and publishable key in `index.html` are safe to be public; access is enforced by row-level security.

## Making changes

Push to `main` and Vercel deploys to production automatically.
