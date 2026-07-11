-- ============================================================
-- Supabase setup for the justfortan.beauty photobooth
-- Paste this whole file into the Supabase SQL editor and run it.
-- (Project → SQL Editor → New query → paste → Run)
--
-- It creates:
--   1. a public "strips" storage bucket (holds session frames +
--      the final composed photobooth strips)
--   2. a "strips" table holding one row per kept strip
--   3. permissive RLS policies for the anonymous (anon) role
--
-- NOTE: this is a private gift site, not a bank. The anon key is
-- public by design, so anyone with the key + PIN can read/write.
-- That's an accepted trade-off here. Do NOT reuse this project for
-- anything sensitive.
-- ============================================================


-- ------------------------------------------------------------
-- 1. STORAGE BUCKET  (public read)
--    Frames live at:  sessions/{sessionId}/{deviceId}-{frameIndex}.jpg
--    Final strips at: strips/{sessionId}.jpg
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('strips', 'strips', true)
on conflict (id) do update set public = true;

-- Storage policies: allow the anon role to read/write/delete in this bucket.
drop policy if exists "strips public read"   on storage.objects;
drop policy if exists "strips anon insert"    on storage.objects;
drop policy if exists "strips anon update"    on storage.objects;
drop policy if exists "strips anon delete"    on storage.objects;

create policy "strips public read"
  on storage.objects for select
  using ( bucket_id = 'strips' );

create policy "strips anon insert"
  on storage.objects for insert
  to anon
  with check ( bucket_id = 'strips' );

create policy "strips anon update"
  on storage.objects for update
  to anon
  using ( bucket_id = 'strips' )
  with check ( bucket_id = 'strips' );

create policy "strips anon delete"
  on storage.objects for delete
  to anon
  using ( bucket_id = 'strips' );


-- ------------------------------------------------------------
-- 2. STRIPS TABLE  (one row per kept strip, for the gallery)
--    id         = the session id (also the strip's file name)
--    path       = storage path of the composed strip jpg
--    session_id = folder of the raw frames, so delete can clean up
-- ------------------------------------------------------------
create table if not exists public.strips (
  id          text primary key,
  created_at  timestamptz not null default now(),
  path        text        not null,
  session_id  text        not null,
  mode        text        not null default 'together'
);

alter table public.strips enable row level security;

-- Table policies: anon can read, insert and delete (gift site).
drop policy if exists "strips select" on public.strips;
drop policy if exists "strips insert" on public.strips;
drop policy if exists "strips delete" on public.strips;

create policy "strips select"
  on public.strips for select
  to anon
  using ( true );

create policy "strips insert"
  on public.strips for insert
  to anon
  with check ( true );

create policy "strips delete"
  on public.strips for delete
  to anon
  using ( true );


-- ------------------------------------------------------------
-- 3. REALTIME
--    The photobooth uses Realtime Broadcast + Presence on an
--    ad-hoc channel ("photobooth-room"). Those do NOT require a
--    Postgres publication, so there is nothing else to enable —
--    Realtime is on by default for new projects.
--    (No need to add the strips table to a publication; the
--     gallery just reads it over the normal REST API.)
-- ------------------------------------------------------------
