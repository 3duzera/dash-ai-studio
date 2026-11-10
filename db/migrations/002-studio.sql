-- Modo Studio: a conversa de cada dashboard, guardada por nós (não pelo Claude Code).
-- Idempotente: o seed.py aplica todos os arquivos desta pasta a cada `docker compose up`.

alter table dashboards.dashboard
  add column if not exists visibility text not null default 'team'
  check (visibility in ('team', 'individual'));

create table if not exists dashboards.studio_session (
  tenant_id    text not null references warehouse.tenant(id),
  id           text primary key,
  dashboard_id text references dashboards.dashboard(id) on delete cascade,  -- nulo até o 1º rascunho
  status       text not null default 'idle' check (status in ('idle', 'running')),
  locked_at    timestamptz,
  model        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists studio_session_dash on dashboards.studio_session (tenant_id, dashboard_id);

-- role: user (pedido), assistant (resposta), choices (perguntas com opções), answers (opções escolhidas),
--       manual (edição feita à mão no canvas), note (aviso do sistema)
create table if not exists dashboards.studio_message (
  id         bigserial primary key,
  session_id text not null references dashboards.studio_session(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant', 'choices', 'answers', 'manual', 'note')),
  content    jsonb not null,
  run        jsonb,                        -- tokens, duração e reparos do turno (só em assistant)
  created_at timestamptz not null default now()
);
create index if not exists studio_message_session on dashboards.studio_message (session_id, id);
