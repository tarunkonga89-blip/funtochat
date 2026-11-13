-- ============================================================
-- PingMe — Supabase schema
-- Run in the SQL editor, or `supabase db push`.
-- Safe to re-run: uses IF NOT EXISTS / DROP POLICY IF EXISTS.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. PROFILES
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  username      text not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name  text not null check (char_length(display_name) between 1 and 50),
  avatar_url    text,
  bio           text default '' check (char_length(bio) <= 160),
  status        text not null default 'online' check (status in ('online','busy','away')),
  last_seen     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create unique index if not exists profiles_username_lower_idx on public.profiles (lower(username));

alter table public.profiles enable row level security;

drop policy if exists "profiles readable by authenticated" on public.profiles;
create policy "profiles readable by authenticated" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own" on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ------------------------------------------------------------
-- 2. FOLLOWS
-- ------------------------------------------------------------
create table if not exists public.follows (
  follower_id  uuid not null references auth.users(id) on delete cascade,
  following_id uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

alter table public.follows enable row level security;

drop policy if exists "follows readable" on public.follows;
create policy "follows readable" on public.follows
  for select to authenticated using (true);

drop policy if exists "follows insert own" on public.follows;
create policy "follows insert own" on public.follows
  for insert to authenticated with check (follower_id = auth.uid());

drop policy if exists "follows delete own" on public.follows;
create policy "follows delete own" on public.follows
  for delete to authenticated using (follower_id = auth.uid());

-- ------------------------------------------------------------
-- 3. CONVERSATIONS + MEMBERS
-- ------------------------------------------------------------
-- (blocks is declared here because can_send() references it)
create table if not exists public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
alter table public.blocks enable row level security;

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'dm' check (kind in ('dm','group')),
  title       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            text not null default 'member' check (role in ('owner','admin','member')),
  pinned          boolean not null default false,
  muted           boolean not null default false,
  archived        boolean not null default false,
  last_read_at    timestamptz not null default now(),
  joined_at       timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx on public.conversation_members(user_id);
create index if not exists conversation_members_conv_idx on public.conversation_members(conversation_id);

alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;

-- helper: is the current user a member of a conversation?
create or replace function public.is_member(p_conv uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = p_conv and user_id = auth.uid()
  );
$$;

-- helper: can the current user send into a conversation (member + no block)?
create or replace function public.can_send(p_conv uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.is_member(p_conv)
    and not exists (
      select 1
      from public.conversation_members cm
      join public.blocks b
        on (b.blocker_id = auth.uid() and b.blocked_id = cm.user_id)
        or (b.blocker_id = cm.user_id and b.blocked_id = auth.uid())
      where cm.conversation_id = p_conv and cm.user_id <> auth.uid()
    );
$$;

drop policy if exists "conversations readable by members" on public.conversations;
create policy "conversations readable by members" on public.conversations
  for select to authenticated using (public.is_member(id));

drop policy if exists "conversations insert by creator" on public.conversations;
create policy "conversations insert by creator" on public.conversations
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "conversations update by members" on public.conversations;
create policy "conversations update by members" on public.conversations
  for update to authenticated using (public.is_member(id));

drop policy if exists "members readable by members" on public.conversation_members;
create policy "members readable by members" on public.conversation_members
  for select to authenticated using (public.is_member(conversation_id));

drop policy if exists "members update self" on public.conversation_members;
create policy "members update self" on public.conversation_members
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Members are inserted only through start_dm()/start_group() (security definer).

-- ------------------------------------------------------------
-- 4. MESSAGES
-- ------------------------------------------------------------
-- Legacy upgrade: the first PingMe demo used a simple messages table.
-- If that old (bigint id) table is present, replace it with the real schema.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'messages'
      and column_name = 'id' and data_type = 'bigint'
  ) then
    drop table public.messages cascade;
  end if;
end $$;

create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations(id) on delete cascade,
  sender_id        uuid not null references auth.users(id) on delete cascade,
  type             text not null default 'text'
                   check (type in ('text','emoji','photo','video','voice','file','gif','meme','sticker','link')),
  content          text,
  media_url        text,
  media_meta       jsonb not null default '{}'::jsonb,  -- {width,height,duration,size,mime,thumb}
  reply_to         uuid references public.messages(id) on delete set null,
  view_once        boolean not null default false,
  edited_at        timestamptz,
  deleted_for_all  boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists messages_conv_created_idx on public.messages(conversation_id, created_at);
create index if not exists messages_sender_idx on public.messages(sender_id);

alter table public.messages enable row level security;
alter table public.messages replica identity full;

drop policy if exists "messages readable by members" on public.messages;
create policy "messages readable by members" on public.messages
  for select to authenticated
  using (public.is_member(conversation_id) and deleted_for_all = false);

drop policy if exists "messages insert by members" on public.messages;
create policy "messages insert by members" on public.messages
  for insert to authenticated
  with check (sender_id = auth.uid() and public.can_send(conversation_id));

drop policy if exists "messages update by sender" on public.messages;
create policy "messages update by sender" on public.messages
  for update to authenticated
  using (sender_id = auth.uid() and public.is_member(conversation_id))
  with check (sender_id = auth.uid());

drop policy if exists "messages delete by sender" on public.messages;
create policy "messages delete by sender" on public.messages
  for delete to authenticated using (sender_id = auth.uid());

-- per-user "delete for me"
create table if not exists public.message_deletions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  primary key (message_id, user_id)
);
alter table public.message_deletions enable row level security;

drop policy if exists "deletions read own" on public.message_deletions;
create policy "deletions read own" on public.message_deletions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "deletions insert own" on public.message_deletions;
create policy "deletions insert own" on public.message_deletions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "deletions delete own" on public.message_deletions;
create policy "deletions delete own" on public.message_deletions
  for delete to authenticated using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 5. REACTIONS
-- ------------------------------------------------------------
create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  emoji      text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
alter table public.message_reactions enable row level security;

drop policy if exists "reactions readable by members" on public.message_reactions;
create policy "reactions readable by members" on public.message_reactions
  for select to authenticated using (
    exists (select 1 from public.messages m where m.id = message_id and public.is_member(m.conversation_id))
  );

drop policy if exists "reactions insert own" on public.message_reactions;
create policy "reactions insert own" on public.message_reactions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "reactions delete own" on public.message_reactions;
create policy "reactions delete own" on public.message_reactions
  for delete to authenticated using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 6. BLOCKS (table created in section 3; policies here)
-- ------------------------------------------------------------
drop policy if exists "blocks read own" on public.blocks;
create policy "blocks read own" on public.blocks
  for select to authenticated using (blocker_id = auth.uid() or blocked_id = auth.uid());

drop policy if exists "blocks insert own" on public.blocks;
create policy "blocks insert own" on public.blocks
  for insert to authenticated with check (blocker_id = auth.uid());

drop policy if exists "blocks delete own" on public.blocks;
create policy "blocks delete own" on public.blocks
  for delete to authenticated using (blocker_id = auth.uid());

-- ------------------------------------------------------------
-- 7. MESSAGE REQUESTS (stranger DMs)
-- ------------------------------------------------------------
create table if not exists public.message_requests (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  from_user       uuid not null references auth.users(id) on delete cascade,
  to_user         uuid not null references auth.users(id) on delete cascade,
  status          text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at      timestamptz not null default now(),
  unique (conversation_id, from_user, to_user)
);
alter table public.message_requests enable row level security;

drop policy if exists "requests read participants" on public.message_requests;
create policy "requests read participants" on public.message_requests
  for select to authenticated using (from_user = auth.uid() or to_user = auth.uid());

drop policy if exists "requests update recipient" on public.message_requests;
create policy "requests update recipient" on public.message_requests
  for update to authenticated using (to_user = auth.uid()) with check (to_user = auth.uid());

-- Created through start_dm().

-- ------------------------------------------------------------
-- 8. CALLS (log rows; signaling uses Realtime channels)
-- ------------------------------------------------------------
create table if not exists public.calls (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  caller_id       uuid not null references auth.users(id) on delete cascade,
  callee_id       uuid not null references auth.users(id) on delete cascade,
  kind            text not null check (kind in ('audio','video')),
  status          text not null default 'ringing' check (status in ('ringing','accepted','declined','missed','ended')),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz
);
create index if not exists calls_conv_idx on public.calls(conversation_id, started_at desc);
alter table public.calls enable row level security;

drop policy if exists "calls read participants" on public.calls;
create policy "calls read participants" on public.calls
  for select to authenticated using (caller_id = auth.uid() or callee_id = auth.uid());

drop policy if exists "calls insert caller" on public.calls;
create policy "calls insert caller" on public.calls
  for insert to authenticated with check (caller_id = auth.uid());

drop policy if exists "calls update participants" on public.calls;
create policy "calls update participants" on public.calls
  for update to authenticated using (caller_id = auth.uid() or callee_id = auth.uid());

-- ------------------------------------------------------------
-- 9. TRIGGERS
-- ------------------------------------------------------------
create or replace function public.touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set updated_at = now() where id = new.conversation_id;
  return new;
end;
$$;
drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation after insert on public.messages
  for each row execute function public.touch_conversation();

-- new auth user -> profile row (username/display name from signup metadata)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_username text;
  v_display  text;
begin
  v_username := coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8));
  v_username := lower(regexp_replace(v_username, '[^a-zA-Z0-9_]', '', 'g'));
  if char_length(v_username) < 3 then
    v_username := 'user_' || substr(new.id::text, 1, 8);
  end if;
  v_display := coalesce(
    nullif(new.raw_user_meta_data->>'display_name', ''),
    nullif(new.raw_user_meta_data->>'full_name', ''),
    split_part(coalesce(new.email, 'friend'), '@', 1)
  );
  insert into public.profiles (id, username, display_name, avatar_url)
  values (new.id, v_username, left(v_display, 50), new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------
-- 10. RPC: start a DM (creation + message-request gating)
-- ------------------------------------------------------------
create or replace function public.start_dm(p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_conv uuid;
  v_blocked boolean;
  v_follow boolean;
begin
  if p_other = auth.uid() then
    raise exception 'You cannot message yourself';
  end if;

  select exists (
    select 1 from public.blocks
    where (blocker_id = auth.uid() and blocked_id = p_other)
       or (blocker_id = p_other and blocked_id = auth.uid())
  ) into v_blocked;
  if v_blocked then
    raise exception 'This user is blocked';
  end if;

  select c.id into v_conv
  from public.conversations c
  where c.kind = 'dm'
    and exists (
      select 1 from public.conversation_members m
      where m.conversation_id = c.id and m.user_id = auth.uid()
    )
    and exists (
      select 1 from public.conversation_members m
      where m.conversation_id = c.id and m.user_id = p_other
    )
  limit 1;

  if v_conv is not null then
    return v_conv;
  end if;

  insert into public.conversations (kind, created_by)
  values ('dm', auth.uid())
  returning id into v_conv;

  insert into public.conversation_members (conversation_id, user_id)
  values (v_conv, auth.uid()), (v_conv, p_other);

  select exists (
    select 1 from public.follows
    where follower_id = auth.uid() and following_id = p_other
  ) into v_follow;

  if not v_follow then
    insert into public.message_requests (conversation_id, from_user, to_user)
    values (v_conv, auth.uid(), p_other)
    on conflict do nothing;
  end if;

  return v_conv;
end;
$$;
grant execute on function public.start_dm(uuid) to authenticated;

create or replace function public.respond_message_request(p_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.message_requests
  set status = case when p_accept then 'accepted' else 'declined' end
  where id = p_id and to_user = auth.uid();
end;
$$;
grant execute on function public.respond_message_request(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 11. REALTIME
-- ------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['messages','message_reactions','conversations','conversation_members','calls','profiles','message_requests'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 12. STORAGE BUCKETS + POLICIES
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars', 'avatars', true, 5242880)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 52428800)
on conflict (id) do nothing;

-- avatars: public read; owner writes only inside their own folder (uid/...)
drop policy if exists "avatars read" on storage.objects;
create policy "avatars read" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "avatars insert own" on storage.objects;
create policy "avatars insert own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars update own" on storage.objects;
create policy "avatars update own" on storage.objects
  for update to authenticated using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars delete own" on storage.objects;
create policy "avatars delete own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- media: private; path is <conversation_id>/<user_id>/<file>
-- read/upload only for members of that conversation
drop policy if exists "media read members" on storage.objects;
create policy "media read members" on storage.objects
  for select to authenticated using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.is_member(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "media insert members" on storage.objects;
create policy "media insert members" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.is_member(((storage.foldername(name))[1])::uuid)
    and (storage.foldername(name))[2] = auth.uid()::text
  );

drop policy if exists "media delete own" on storage.objects;
create policy "media delete own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'media' and (storage.foldername(name))[2] = auth.uid()::text
  );

-- ------------------------------------------------------------
-- 13. GRANTS
-- ------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles, public.follows, public.conversations, public.conversation_members,
  public.messages, public.message_deletions, public.message_reactions,
  public.blocks, public.message_requests, public.calls
to authenticated;