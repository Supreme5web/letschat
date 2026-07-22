# Entangle — quantum-styled messenger

A 1:1 messaging web app with a "quantum" visual identity: an ambient
particle field, glass panels, and messages that "decohere" into view
when they arrive. Vanilla HTML/CSS/JS, backed entirely by Supabase
(auth, Postgres + realtime, storage for images).

## Setup (5 steps)

1. **Create a Supabase project** at supabase.com if you don't have one.

2. **Run the schema.** Open your project's SQL Editor and run the
   entire contents of `schema.sql`. This creates `profiles`,
   `conversations`, `conversation_participants`, `messages`, their RLS
   policies, and enables realtime on `messages`.

3. **Create the storage bucket.** Go to Storage → New bucket, name it
   exactly `chat-images`, and mark it **Public**. That's all that's
   needed for image sending to work with the current setup.

4. **Add your keys.** Open `app.js` and set:
   ```js
   const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
   const SUPABASE_ANON_KEY = "your-anon-public-key";
   ```
   Both are on your project's Settings → API page. The anon key is
   safe to expose client-side — RLS policies are what actually protect
   the data.

5. **Turn off email confirmation (optional, for fast local testing).**
   In Authentication → Providers → Email, disable "Confirm email" if
   you want signups to log straight in without a verification email.
   Leave it on for a real deployment.

Then just open `index.html` in a browser (or serve the folder with
any static file server — e.g. `npx serve .`).

## How it works

- **Auth** — Supabase email/password auth. On signup, a matching row
  is created in `profiles` so people can find each other by handle.
- **Starting a chat** — search a handle in the sidebar; this finds or
  creates a 1:1 row in `conversations` + `conversation_participants`.
- **Messaging** — sending inserts a row into `messages`. Everyone in
  the conversation is subscribed to a Supabase Realtime channel
  filtered to that `conversation_id`, so new rows appear instantly
  without polling.
- **Images** — picked files upload to the `chat-images` storage
  bucket first; the returned public URL is stored on the message row
  alongside (or instead of) text.

## Extending it

- **Group chats**: the schema already supports `is_group` + multiple
  participants — the UI just needs a "create group" flow and a
  multi-select for members.
- **Typing indicators / read receipts**: use Supabase Realtime's
  `broadcast` or `presence` channels (separate from the `postgres_changes`
  listener already wired up for messages).
- **Push notifications**: pair with a Supabase Edge Function triggered
  on `messages` insert.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup for auth screen + chat app |
| `style.css` | Quantum visual identity — palette, type, decoherence animation |
| `app.js` | Supabase client, auth, conversations, realtime messaging, uploads, particle field |
| `schema.sql` | Tables, RLS policies, realtime + storage setup |
