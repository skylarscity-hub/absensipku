
create table if not exists public.app_documents (
  id uuid primary key default gen_random_uuid(),
  collection text not null,
  document jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists app_documents_collection_idx on public.app_documents(collection);
create index if not exists app_documents_document_gin_idx on public.app_documents using gin(document);
alter table public.profiles add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.attendance add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.offices add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.schedule add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.holidays add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.overtime_requests add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.leaves add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.admin_requests add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.attendance_corrections add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.notifications add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.push_tokens add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.security_audit add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.security_rate_events add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.auth_failures add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.user_sessions add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.liveness_sessions add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.liveness_results add column if not exists legacy_data jsonb not null default '{}'::jsonb;
alter table public.app_documents enable row level security;
grant all on public.app_documents to service_role;
