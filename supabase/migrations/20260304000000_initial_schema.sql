-- Baseline schema required before the later incremental migrations.
-- Supabase provides auth.users; this app stores application-specific user data in public.profiles.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  role text not null default 'worker',
  created_at timestamptz not null default now(),
  constraint profiles_role_check check (role in ('manager', 'worker'))
);

alter table public.profiles enable row level security;

create policy "Profiles: read for authenticated"
  on public.profiles for select
  using (auth.role() = 'authenticated');

create policy "Profiles: user can insert own profile"
  on public.profiles for insert
  with check (id = auth.uid());

create policy "Profiles: user can update own profile"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  type text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint shifts_type_check check (type in ('day', 'night'))
);

create index if not exists idx_shifts_date on public.shifts(date);
create index if not exists idx_shifts_created_by on public.shifts(created_by);

alter table public.shifts enable row level security;

create policy "Shifts: read for authenticated"
  on public.shifts for select
  using (auth.role() = 'authenticated');

create policy "Shifts: manager can modify"
  on public.shifts for all
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'manager'
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'manager'
    )
  );

create table if not exists public.constraints (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id) on delete cascade,
  date date not null,
  type text not null,
  status text not null default 'unavailable',
  note text,
  created_at timestamptz not null default now(),
  constraint constraints_type_check check (type in ('day', 'night')),
  constraint constraints_status_check check (status in ('unavailable'))
);

create index if not exists idx_constraints_worker_id on public.constraints(worker_id);
create index if not exists idx_constraints_date on public.constraints(date);

alter table public.constraints enable row level security;

create policy "Constraints: user can read own"
  on public.constraints for select
  using (worker_id = auth.uid());

create policy "Constraints: manager can read all"
  on public.constraints for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'manager'
    )
  );

create policy "Constraints: user can insert own"
  on public.constraints for insert
  with check (worker_id = auth.uid());

create policy "Constraints: user can update own"
  on public.constraints for update
  using (worker_id = auth.uid())
  with check (worker_id = auth.uid());

create policy "Constraints: user can delete own"
  on public.constraints for delete
  using (worker_id = auth.uid());

create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts(id) on delete cascade,
  worker_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint assignments_shift_worker_unique unique (shift_id, worker_id)
);

create index if not exists idx_assignments_shift_id on public.assignments(shift_id);
create index if not exists idx_assignments_worker_id on public.assignments(worker_id);
