-- Banco de exemplo. Duas áreas:
--   warehouse  ← o dado de negócio (o agente nunca vê; só a api consulta)
--   dashboards ← as specs dos dashboards (jsonb) e, via migrations/, a conversa do Studio
--
-- O dado é de uma loja online fictícia: cada linha de warehouse.order_line é um item de um pedido.

create schema warehouse;

create table warehouse.tenant (
  id        text primary key,
  name      text not null,
  segment   text not null,           -- ramo da empresa, só para exibir
  modules   text[] not null          -- módulos contratados: sales, customers, operations
);

create table warehouse.state (
  id   text primary key,
  name text not null
);

create table warehouse.channel (
  id   text primary key,
  name text not null
);

create table warehouse.segment (
  id   text primary key,
  name text not null
);

create table warehouse.product (
  tenant_id     text not null references warehouse.tenant(id),
  id            text not null,
  name          text not null,
  category      text not null,
  category_name text not null,
  unit_cost     numeric(10,2) not null,
  primary key (tenant_id, id)
);

create table warehouse.order_line (
  tenant_id   text not null,
  day         date not null,
  order_id    text not null,
  customer_id text not null,
  product_id  text not null,
  channel_id  text not null,
  state_id    text not null,          -- estado de entrega
  segment_id  text not null,          -- segmento do cliente
  qty         int not null,
  unit_price  numeric(10,2) not null,
  discount    numeric(4,3) not null,  -- fração: 0.10 = 10%
  status      text not null check (status in ('delivered', 'returned', 'canceled')),
  late        boolean not null,       -- entregue depois do prazo prometido
  first_order boolean not null        -- primeira compra do cliente na loja
);
create index on warehouse.order_line (tenant_id, day);
create index on warehouse.order_line (tenant_id, product_id);

-- Uma carga por dia. Dia com status 'failed' não tem dado (vira buraco nos gráficos de linha).
create table warehouse.daily_load (
  tenant_id       text not null references warehouse.tenant(id),
  day             date not null,
  status          text not null check (status in ('ok', 'failed')),
  materialized_at timestamptz,
  primary key (tenant_id, day)
);

create schema dashboards;

create table dashboards.dashboard (
  tenant_id      text not null references warehouse.tenant(id),
  id             text primary key,
  title          text not null,
  status         text not null check (status in ('draft', 'published')),
  spec           jsonb not null,        -- rascunho atual
  published_spec jsonb,                 -- o que o time vê
  created_via    text not null,         -- agent, manual, example
  prompt         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  published_at   timestamptz
);
create index on dashboards.dashboard (tenant_id, updated_at desc);
