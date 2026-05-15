-- ================================================================
-- Run this in your Supabase SQL Editor
-- If you already ran the previous schema, run the ALTER statements
-- at the bottom instead of the full CREATE TABLE
-- ================================================================

-- ── Services table ───────────────────────────────────────────────
create table if not exists services (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz default now(),
  name         text not null,
  duration_min integer not null,
  active       boolean not null default true
);

insert into services (name, duration_min) values
  ('Skate Sharpening', 15),
  ('New Boot Fitting', 60)
on conflict do nothing;

-- ── Bookings table ───────────────────────────────────────────────
create table if not exists bookings (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz default now(),
  date               date not null,
  slot_id            text not null check (slot_id in ('am', 'pm')),
  service_id         uuid references services(id),
  confirmed_start    time,
  first_name         text not null,
  last_name          text not null,
  email              text not null,
  phone              text,
  notes              text,
  status             text not null default 'pending'
                     check (status in ('pending', 'confirmed', 'paid', 'cancelled')),
  stripe_session_id  text,
  stripe_payment_id  text
);

create index if not exists bookings_date_idx on bookings (date);
create index if not exists bookings_service_idx on bookings (service_id);

alter table bookings enable row level security;
alter table services enable row level security;

create policy "Service role only - bookings"
  on bookings using (auth.role() = 'service_role');

create policy "Service role only - services"
  on services using (auth.role() = 'service_role');

-- ================================================================
-- IF YOU ALREADY RAN THE OLD SCHEMA, run just these instead:
-- ================================================================
-- create table if not exists services (
--   id uuid primary key default gen_random_uuid(),
--   created_at timestamptz default now(),
--   name text not null,
--   duration_min integer not null,
--   active boolean not null default true
-- );
-- insert into services (name, duration_min) values ('Skate Sharpening', 15), ('New Boot Fitting', 60);
-- alter table bookings add column if not exists service_id uuid references services(id);
-- alter table bookings add column if not exists confirmed_start time;
-- alter table bookings drop constraint if exists bookings_date_slot_id_status_key;
-- alter table services enable row level security;
-- create policy "Service role only - services" on services using (auth.role() = 'service_role');
-- ================================================================

create or replace view upcoming_bookings as
  select
    b.id, b.date, b.slot_id, b.confirmed_start,
    s.name as service_name, s.duration_min,
    b.first_name || ' ' || b.last_name as customer_name,
    b.email, b.phone, b.status, b.created_at
  from bookings b
  left join services s on s.id = b.service_id
  where b.date >= current_date
  order by b.date, b.confirmed_start nulls last;
