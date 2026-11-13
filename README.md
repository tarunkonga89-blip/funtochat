# Chattr

A playful, Instagram-DM-style messenger. The UI is still **one self-contained HTML file** (HTML + CSS + vanilla JS) — the live backend is layered on top by `src/live.js`, so the look and feel did not change:

- violet `#7C3AED` brand, Poppins, rounded cards, light/dark mode
- chat list with pins, unread badges, online dots, search
- grouped bubbles, reactions, reply quotes, image lightbox, floating chat heads

- Live site: https://funtochat.vercel.app
- GitHub: https://github.com/tarunkonga89-blip/funtochat

> **Branding note:** the app is now called **Chattr**. The GitHub repo, the Vercel
> project and the `funtochat.vercel.app` URL keep their original names — rename them
> in GitHub/Vercel if you want the domain to match. Test account emails still use
> `@funtochat.test` because those rows already exist in Supabase.

## What works today (step 1)

| Area | Status |
| --- | --- |
| Email + password sign-up / login | ✅ Supabase Auth |
| "Try demo mode" (fake data, no backend) | ✅ unchanged |
| Session persistence + logout | ✅ |
| Profile: @username, display name, bio, status, avatar upload | ✅ |
| Find people (search by username/name), follow, start DM | ✅ |
| Message requests for people you do not follow | ✅ `start_dm()` |
| Realtime messages | ✅ Supabase Realtime |
| Typing indicator | ✅ Realtime broadcast |
| Presence + last seen | ✅ Realtime presence |
| Ticks: sending → sent → seen | ✅ from `conversation_members.last_read_at` |
| Photo sharing with compression + upload to Storage | ✅ (signed URLs, 50 MB guard) |
| File sharing (name/size + upload when a file is picked) | ✅ |
| Reactions | ✅ persisted + realtime |
| Blocks (blocked users cannot message) | ✅ enforced by RLS |
| Google sign-in | ⚠️ code ready, provider must be enabled in Supabase |
| Forgot-password email | ⚠️ code ready, needs SMTP configured |
| GIF picker (GIPHY search + trending) | ✅ needs the free `GIPHY_API_KEY` secret |
| Stickers (big animated emoji) and Meme maker (templates or your own photo + top/bottom text) | ✅ no key needed |
| Full-screen media viewer: swipe / ← → between photos, tap or wheel or pinch to zoom, download | ✅ |
| Message menu (⋯): copy, forward, edit (15 min, shows "Edited"), delete for me, unsend for everyone | ✅ live in Realtime |
| ChattrBot AI chat (pinned at the top) | ✅ Google Gemini **free tier** — needs `GEMINI_API_KEY` |
| Voice notes: tap 🎤 to record (max 2 min), tap again to send; tap ▶ to play | ✅ uploaded to Storage |
| Video sharing (📎 → pick a video, 50 MB max), plays full screen | ✅ |
| 1:1 voice & video calls (WebRTC, signaling over Realtime broadcast): accept/decline, mute, camera off, hang up | ✅ logged-in users only |
| View-once, pin/mute/archive UI, group calls | ⏳ next steps |

> **Calls and networks:** calls use free Google STUN servers, which work on most home Wi-Fi and mobile data.
> Some office or strict networks need a TURN relay — add a free one (e.g. Metered or Cloudflare) with
> `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` in Vercel's environment variables.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
# or the port the app is usually served on:
npx vite --port 4173
```

Opening `index.html` directly still works, but only in demo mode (no bundler → no Supabase client).

## Configure

### 1. Environment

`.env` (never committed):

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

Only `VITE_` variables reach the browser. Server secrets live in Supabase Edge Function secrets — see `.env.example`.

### 2. Database, RLS and storage

Run [`supabase/schema.sql`](supabase/schema.sql) in the SQL editor (or `supabase db push`). It is idempotent and creates:

- `profiles`, `follows`, `conversations`, `conversation_members`, `messages`,
  `message_deletions`, `message_reactions`, `blocks`, `message_requests`, `calls`
- RLS on every table: you only see conversations you belong to, a block stops new messages,
  messages can only be edited/deleted by their sender
- helper RPCs `start_dm()` (creates the DM + a message request when you do not follow the person)
  and `respond_message_request()`
- triggers: `handle_new_user` (profile from signup metadata) and `touch_conversation`
- realtime publication for messages, reactions, members, conversations, calls, profiles
- storage buckets: `avatars` (public, 5 MB) and `media` (private, 50 MB) with folder policies

Media paths are `<conversation_id>/<user_id>/<file>`; the browser reads them with short-lived signed URLs.

### 3. Auth settings

- **Site URL** → your deployed origin (e.g. `https://funtochat.vercel.app`)
- **Redirect URLs** → add `http://localhost:4173`, `http://localhost:5173` and the deployed origin
- **Email confirmation** is currently disabled on this project so sign-up works instantly.
  Turn it back on (Authentication → Providers → Email) once SMTP is configured.
- **Google**: enable the provider and paste a Google Cloud OAuth client id/secret.
  Without it the "Continue with Google" button shows an error message.
- **Forgot password** uses Supabase's mailer; configure custom SMTP (Resend, Brevo, …)
  because the built-in mailer is heavily rate limited.

## Edge Functions

Both functions verify the caller's Supabase JWT before doing anything.

```bash
supabase functions deploy ai-chat
supabase functions deploy giphy

supabase secrets set GEMINI_API_KEY=...      # free: https://aistudio.google.com → Get API key
supabase secrets set GIPHY_API_KEY=...       # free: https://developers.giphy.com → Create an App
# optional: supabase secrets set GEMINI_MODEL=gemini-2.5-flash
```

No credit card is needed for either key. You can also add the secrets in the Supabase dashboard
(Edge Functions → Secrets) and deploy the functions from there.

- `ai-chat` → `POST { messages: [{ role, content }] }` → `{ reply }` (Google Gemini free tier, 1–3 sentence "ChattrBot").
  It tries `GEMINI_MODEL`, then `gemini-2.5-flash`, `gemini-flash-latest`, `gemini-2.5-flash-lite`, so a retired model does not break the bot.
  Only signed-in users can call it, which protects your free quota.
- `giphy` → `GET ?q=cats&trending=1&sticker=1` → `{ items: [{ id, title, url, preview }] }`

Keys never touch the frontend: there is no `VITE_GEMINI_KEY` or `VITE_GIPHY_KEY` anywhere.

ChattrBot's chat history is stored on the device (localStorage, per account), not in Postgres.
In demo mode ChattrBot answers with canned replies; GIF search shows a hint, while stickers and memes always work.

## Code map

| File | Role |
| --- | --- |
| `index.html` | whole UI: styles, `Store` (demo data + localStorage), rendering, events, auth screens |
| `src/live.js` | Supabase auth, profiles, find people, live `Store` overrides, realtime, presence, typing, uploads |
| `supabase/schema.sql` | tables, RLS, triggers, RPCs, realtime, storage policies |
| `supabase/functions/ai-chat` | Claude proxy (server-side key) |
| `supabase/functions/giphy` | GIPHY proxy (server-side key) |

`src/live.js` monkey-patches `Store` (`send`, `open`, `react`, `toggleMute`, `toggleBlock`, …) only when a session exists, so the demo path and all rendering code stay untouched. `window.PingMe` exposes the hooks the module needs.

## Two-account testing

The project currently has two confirmed test accounts (created for QA):

```
aarav@funtochat.test / FunToChat123!
priya@funtochat.test / FunToChat123!
```

Use two browsers (or a private window) to see typing, presence and seen ticks live.
Remove them before going public:

```sql
delete from auth.users where email like '%@funtochat.test';
```

## Deploy

Pushing to `main` builds and deploys automatically on Vercel (Vite, output `dist`).
Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the Vercel project's environment variables.