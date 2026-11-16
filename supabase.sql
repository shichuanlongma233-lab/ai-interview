-- Supabase の SQL Editor に貼り付けて「Run」を1回押してください
create table if not exists app_files (
  path text primary key,
  content text not null,
  is_base64 boolean not null default false,
  updated_at timestamptz not null default now()
);
-- 外部から直接読めないようにする(サーバーは secret key で読み書きします)
alter table app_files enable row level security;
