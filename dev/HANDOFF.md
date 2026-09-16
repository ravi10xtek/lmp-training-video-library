# Handoff: Local dev environment (2026-09-15)

Branch: `harithroo-changes`. **All changes below are uncommitted.**

## The app in one paragraph
LMP Training Library for Loch Monster Plumbing. It's plain HTML/JS with no build step: `old-html-version/app.js` (~3.4k lines) and
`index.html`. Two services back it:
- **Supabase**: Postgres, Auth, row-level security (RLS), Storage and Edge Functions.
- **Wasabi**: private video storage.

Vercel serves only `old-html-version/` (see `vercel.json`). The Edge Functions in
`supabase/functions/` are deployed separately to each Supabase project with
`supabase functions deploy`. Pushing to git does not deploy them.

Phase 1:
1. **Script review.** Ravi creates a script against a video slot and assigns a writer. The writer drafts and sends it to Joe,
   who listens to an AI voice preview (`script-tts`, OpenAI), leaves voice notes
   (`transcribe`, Whisper) and approves. The approved version is locked.
   Flow: `draft → sent → changes → sent … → approved`.
2. **Video.** Upload to Wasabi (`wasabi-*` functions), then `to_review → to_edit → completed →
   published`, with feedback, comments, review rounds and push notifications (`notify-review`).
   Staff (`worker` accounts) see only published videos.

Roles: `profiles.role` is `admin` or `worker`, plus the `is_reviewer` flag. Reviewer = admin +
is_reviewer (Joe). Manager/editor = admin (Ravi). Writers and editors are `worker`s who get access
through `scripts.writer_id` / `editor_id`.

Gaps noted:
- No separate client role.
- The staff training layer is basic (library + watch_progress only).
- No tests.
- The README is out of date (it mentions a non-existent `frontend/` and says the keys are in index.html).
- Nothing records which migrations have run.

## What was done this session
| Change | Why |
|---|---|
| `app.js`: `SUPABASE_URL` / `ANON_KEY` fall back to `window.LMP_ENV` | Point a local copy at a dev project |
| `index.html`: loads `env.local.js` **only on localhost** | Production is unaffected |
| `.gitignore`: `.env.dev`, `old-html-version/env.local.js` | Keep keys out of git |
| `dev/setup-dev-db.ps1` | Runs the schema and 19 migrations in git-history order, creates test users, writes `env.local.js`. Refuses to run against the prod URL. `-UsersOnly` to redo accounts |
| `dev/dev_extras.sql` | `joe-recordings` bucket and policies (the migrations only described this in comments), plus a **fix**: `handle_new_user` needs `set search_path = public`, or Auth user creation fails with 500 |
| `dev/.env.dev.example` | Template (the real file is `dev/.env.dev`, gitignored) |

## Current status
**Dev Supabase project:** `cpjzwcyckgfsqlxwdoto`. Prod is `tdxwsgfjkpurtjmgwabr`; don't touch it.

- [x] Schema and all migrations applied, no errors
- [x] 152 video slots seeded
- [x] Test accounts created (password = `DEV_USER_PASSWORD` in `dev/.env.dev`)
- [x] Local app confirmed to use the dev project
- [ ] User login not yet confirmed by the user
- [ ] **Edge Functions not deployed to dev.** "Preview failed: Failed to send a request to the Edge Function" is expected until they are
- [ ] Secrets not set in dev (OpenAI, Wasabi, VAPID)
- [ ] Nothing committed

| Account | Role |
|---|---|
| joe@lmp.test | admin + reviewer (client) |
| reviewer@lmp.test | admin + reviewer (video reviewer) |
| ravi@lmp.test | admin (manager, assigns work) |
| writer@lmp.test | worker (script writer) |
| editor@lmp.test | worker (video editor) |
| staff@lmp.test | worker (client staff) |

## Run locally
```
cd old-html-version; python -m http.server 8081
```
Open http://localhost:8081. Delete `old-html-version/env.local.js` to use prod instead.
Use private windows to be logged in as more than one user at once. The service worker caches
aggressively, so hard-refresh if changes don't show up.

## Next steps
1. **The user** runs `npx supabase login` and adds the `OPENAI_API_KEY` secret to the dev project
   (dashboard → Edge Functions → Secrets).
2. Deploy: `npx supabase functions deploy script-tts --project-ref cpjzwcyckgfsqlxwdoto --use-api`
   (then `transcribe` and `notify-review`).
3. Optional: a Wasabi dev bucket and keys for `wasabi-*`, and VAPID keys for push.
4. Commit the dev setup. Consider moving the `handle_new_user` search_path fix into
   `database/supabase_schema.sql`, and updating the README.
