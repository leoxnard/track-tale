-- TrackTale schema. Apply once per environment (Supabase SQL editor or MCP apply_migration).

create table if not exists users (
  telegram_id bigint primary key,
  display_name text not null,
  is_owner boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists invites (
  code text primary key,
  created_by bigint not null references users(telegram_id),
  used_by bigint references users(telegram_id),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- A trip belongs to the Telegram chat it was created in — a private chat or a
-- group where several travellers contribute to the same journey.
create table if not exists chats (
  chat_id bigint primary key,
  type text not null default 'private',
  title text,
  active_trip_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null references chats(chat_id) on delete cascade,
  owner_telegram_id bigint not null references users(telegram_id),
  name text not null,
  start_date date not null,
  end_date date not null,
  timezone text not null default 'Europe/Berlin',
  share_slug text not null unique,
  current_day_number int,
  live_url text,
  live_expires_at timestamptz,
  -- Set by /endtrip. A finished trip keeps its pages but stops being written to.
  finished_at timestamptz,
  reminders_enabled boolean not null default true,
  og_path text,
  og_updated_at timestamptz,
  archive_path text,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

alter table chats
  add constraint chats_active_trip_fk
  foreign key (active_trip_id) references trips(id) on delete set null;

create table if not exists plan_segments (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  source_url text,
  name text,
  geojson jsonb not null,
  distance_m double precision not null default 0,
  elevation_up double precision not null default 0,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists days (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  day_number int not null,
  date date not null,
  color text not null,
  unique (trip_id, day_number)
);

create table if not exists track_segments (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references days(id) on delete cascade,
  geojson jsonb not null,
  distance_m double precision not null default 0,
  duration_s double precision not null default 0,
  moving_s double precision not null default 0,
  elevation_up double precision not null default 0,
  elevation_down double precision not null default 0,
  sport text,
  name text,
  source text not null check (source in ('komoot', 'gpx', 'fit')),
  source_url text,
  started_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists media (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references days(id) on delete cascade,
  storage_path text not null,
  thumb_path text,
  caption text,
  telegram_date timestamptz not null,
  matched_lat double precision,
  matched_lng double precision,
  author_telegram_id bigint,
  author_name text,
  created_at timestamptz not null default now()
);

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references days(id) on delete cascade,
  text text not null,
  author_telegram_id bigint,
  author_name text,
  created_at timestamptz not null default now()
);

-- Messages left by family on the public trip page.
create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references days(id) on delete cascade,
  author_name text not null,
  text text not null,
  created_at timestamptz not null default now()
);

-- Maps each of the bot's confirmation messages to the row it created, so that
-- replying /delete to one removes exactly that thing.
create table if not exists bot_actions (
  chat_id bigint not null,
  message_id bigint not null,
  entity_type text not null check (
    entity_type in ('note', 'media', 'track_segment', 'plan_segment', 'comment')
  ),
  entity_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);

create table if not exists weather_cache (
  day_id uuid primary key references days(id) on delete cascade,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

create index if not exists track_segments_day_idx on track_segments(day_id);
create index if not exists days_trip_idx on days(trip_id);
create index if not exists media_day_idx on media(day_id);
create index if not exists notes_day_idx on notes(day_id);
create index if not exists comments_day_idx on comments(day_id);
create index if not exists trips_chat_idx on trips(chat_id);
-- /undo reads the newest action in a chat.
create index if not exists bot_actions_recent_idx on bot_actions(chat_id, created_at desc);

-- All access goes through the service-role key on the server; lock everything else out.
alter table users enable row level security;
alter table invites enable row level security;
alter table chats enable row level security;
alter table trips enable row level security;
alter table plan_segments enable row level security;
alter table days enable row level security;
alter table track_segments enable row level security;
alter table media enable row level security;
alter table notes enable row level security;
alter table comments enable row level security;
alter table bot_actions enable row level security;
alter table weather_cache enable row level security;

grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;

-- Storage: public buckets. `photos` is read directly by the viewer page and also
-- holds the generated share cards under og/; `archives` holds /archive bundles
-- too large to send through Telegram.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true), ('archives', 'archives', true)
on conflict (id) do nothing;

-- Columns added after the first release. Safe to re-run; new environments get
-- them from the create table statements above.
alter table trips add column if not exists finished_at timestamptz;
alter table trips add column if not exists reminders_enabled boolean not null default true;
alter table trips add column if not exists og_path text;
alter table trips add column if not exists og_updated_at timestamptz;
alter table trips add column if not exists archive_path text;
alter table trips add column if not exists archived_at timestamptz;
alter table invites add column if not exists expires_at timestamptz;
-- Redemption compares against expires_at, and NULL never compares true, so give
-- codes issued before expiry existed a deadline rather than breaking them.
update invites set expires_at = created_at + interval '7 days' where expires_at is null;
