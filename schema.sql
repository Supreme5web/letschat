-- =====================================================================
-- Entangle — Supabase schema
-- Run this in your Supabase project's SQL editor (Database → SQL Editor)
-- =====================================================================

-- ---------- profiles ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  status text default 'online',
  created_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "profiles are readable by any signed-in user"
  on profiles for select
  using (auth.uid() is not null);

create policy "users can insert their own profile"
  on profiles for insert
  with check (auth.uid() = id);

create policy "users can update their own profile"
  on profiles for update
  using (auth.uid() = id);

-- ---------- conversations ----------
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  is_group boolean default false,
  name text,
  created_at timestamptz default now()
);

alter table conversations enable row level security;

create table if not exists conversation_participants (
  conversation_id uuid references conversations(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (conversation_id, user_id)
);

alter table conversation_participants enable row level security;

-- a user can see conversations they belong to
create policy "participants can read their conversations"
  on conversations for select
  using (
    id in (
      select conversation_id from conversation_participants
      where user_id = auth.uid()
    )
  );

create policy "signed-in users can create conversations"
  on conversations for insert
  with check (auth.uid() is not null);

-- a user can read the participant rows for conversations they're in
create policy "participants can read participant rows"
  on conversation_participants for select
  using (
    conversation_id in (
      select conversation_id from conversation_participants
      where user_id = auth.uid()
    )
  );

create policy "signed-in users can add participants"
  on conversation_participants for insert
  with check (auth.uid() is not null);

-- ---------- messages ----------
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  sender_id uuid references profiles(id) on delete cascade,
  content text,
  image_url text,
  created_at timestamptz default now()
);

alter table messages enable row level security;

create policy "participants can read messages in their conversations"
  on messages for select
  using (
    conversation_id in (
      select conversation_id from conversation_participants
      where user_id = auth.uid()
    )
  );

create policy "participants can send messages in their conversations"
  on messages for insert
  with check (
    sender_id = auth.uid()
    and conversation_id in (
      select conversation_id from conversation_participants
      where user_id = auth.uid()
    )
  );

-- ---------- realtime ----------
-- enable realtime broadcasts for new messages
alter publication supabase_realtime add table messages;

-- =====================================================================
-- Storage: run separately in Storage → create bucket "chat-images"
-- (public bucket, or use the policies below if kept private)
-- =====================================================================

-- If you create the "chat-images" bucket as PUBLIC (recommended for this
-- app), no extra policies are required for reading images.
-- For uploads, add this policy on storage.objects:

-- create policy "authenticated users can upload chat images"
--   on storage.objects for insert
--   with check (
--     bucket_id = 'chat-images'
--     and auth.uid() is not null
--   );
