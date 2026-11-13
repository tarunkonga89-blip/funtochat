# FunToChat

A playful, Messenger-style chat UI built as **one self-contained HTML file** (HTML + CSS + vanilla JavaScript).

- Live site: https://funtochat.vercel.app
- GitHub: https://github.com/tarunkonga89-blip/funtochat

## Run it

```bash
npm install
npm run dev
```

Or simply open `index.html` in a browser — there are no runtime dependencies (Poppins loads from Google Fonts).

## What's inside `index.html`

- **Brand**: FunToChat logo (inline SVG speech bubble + smile), violet `#7C3AED`, amber `#F59E0B`, online green `#22C55E`.
- **Three panels**: chat list (320px), conversation, collapsible contact info (300px). On mobile the list comes first and the chat slides in with a back arrow.
- **Chat list**: search, pinned chats, unread badges, online dots, relative times.
- **Messages**: grouped bubbles (gradient right / grey left), date separators, hover timestamps, reply quotes, reactions (👍 ❤️ 😂 😮 😢 😡), image lightbox, file cards, links auto-linked.
- **Status**: Sending → Sent → Delivered → Seen (with tiny avatar).
- **Composer**: auto-growing textarea (max 5 lines), Enter to send, Shift+Enter for a new line, emoji picker, file/image attach with preview, quick 👍 when empty.
- **Demo behaviour**: 7 conversations with Indian names, simulated "typing…" + auto-reply 1–2s after you send, unread handling, saved to `localStorage` (wrapped in try/catch).
- **Extras**: light/dark mode, floating chat heads (up to 3, minimisable), "↓ New messages" pill, accessible buttons/labels/focus rings.

## Data layer

The file is organised in commented sections. Everything the UI needs goes through `Store` (section 3), which reads and writes `localStorage` through the `Storage` adapter. To connect a real backend later (Supabase Realtime, Firebase, etc.), keep the same `Store` methods (`list`, `get`, `open`, `send`, `receive`, `setStatus`, `markMineSeen`, `react`, `toggleMute`, `toggleBlock`, `setTheme`, `addConversation`) and replace the body of `Storage` / the `Store` mutations with API calls. The rendering code does not need to change.

## Deploy

The repository is connected to Vercel — pushing to `main` builds and deploys automatically (Vite, output `dist`).

> Note: the earlier Supabase-connected React demo remains in `src/` for reference; the live site now serves the single-file `index.html`.