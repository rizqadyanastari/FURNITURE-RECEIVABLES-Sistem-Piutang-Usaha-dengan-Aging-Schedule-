-- Furniture Receivables: skema piutang usaha untuk Supabase (PostgreSQL).
-- Jalankan seluruh file ini melalui Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company_name text,
  email text,
  phone text,
  address text,
  created_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  customer_id uuid not null references public.customers(id) on delete restrict,
  invoice_date date not null default current_date,
  due_date date not null,
  total_amount numeric(14, 2) not null check (total_amount > 0),
  notes text,
  created_at timestamptz not null default now(),
  check (due_date >= invoice_date)
);

create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  description text not null,
  quantity numeric(12, 2) not null check (quantity > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  line_total numeric(16, 2) generated always as (quantity * unit_price) stored,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),
  payment_date date not null default current_date,
  payment_method text,
  reference text,
  created_at timestamptz not null default now()
);

create index if not exists invoices_customer_id_idx on public.invoices(customer_id);
create index if not exists invoices_due_date_idx on public.invoices(due_date);
create index if not exists invoice_items_invoice_id_idx on public.invoice_items(invoice_id);
create index if not exists payments_invoice_id_idx on public.payments(invoice_id);

create or replace view public.aging_schedule as
with payment_totals as (
  select invoice_id, sum(amount) as paid_amount
  from public.payments
  group by invoice_id
)
select
  i.id as invoice_id,
  i.invoice_number,
  i.customer_id,
  c.name as customer_name,
  c.company_name,
  i.invoice_date,
  i.due_date,
  i.total_amount,
  coalesce(pt.paid_amount, 0)::numeric(14, 2) as paid_amount,
  greatest(i.total_amount - coalesce(pt.paid_amount, 0), 0)::numeric(14, 2) as balance,
  greatest(i.due_date - current_date, 0) as days_until_due,
  greatest(current_date - i.due_date, 0) as days_overdue,
  case
    when i.total_amount - coalesce(pt.paid_amount, 0) <= 0 then 'Paid'
    when current_date <= i.due_date then 'Current'
    when current_date - i.due_date between 1 and 30 then '1-30'
    when current_date - i.due_date between 31 and 60 then '31-60'
    when current_date - i.due_date between 61 and 90 then '61-90'
    else '90+'
  end as aging_bucket,
  case
    when i.total_amount - coalesce(pt.paid_amount, 0) <= 0 then 'Lunas'
    when current_date <= i.due_date then 'Belum jatuh tempo'
    when current_date - i.due_date between 1 and 30 then '1–30 hari'
    when current_date - i.due_date between 31 and 60 then '31–60 hari'
    when current_date - i.due_date between 61 and 90 then '61–90 hari'
    else 'Lebih dari 90 hari'
  end as aging_bucket_label
from public.invoices i
join public.customers c on c.id = i.customer_id
left join payment_totals pt on pt.invoice_id = i.id;

alter view public.aging_schedule set (security_invoker = true);

create or replace function public.create_invoice_with_items(
  p_invoice_number text,
  p_customer_id uuid,
  p_invoice_date date,
  p_due_date date,
  p_items jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  new_invoice_id uuid;
  computed_total numeric(14, 2);
begin
  if p_invoice_number is null or length(trim(p_invoice_number)) = 0 or length(p_invoice_number) > 80
    or p_invoice_date is null or p_due_date is null or p_due_date < p_invoice_date then
    raise exception 'Nomor dan tanggal invoice tidak valid.';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'Invoice harus memiliki 1 sampai 100 item.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(description text, quantity numeric, unit_price numeric)
    where item.description is null or length(trim(item.description)) = 0 or length(item.description) > 240
      or item.quantity is null or item.quantity <= 0
      or item.quantity <> round(item.quantity, 2)
      or item.unit_price is null or item.unit_price < 0
      or item.unit_price <> round(item.unit_price, 2)
  ) then
    raise exception 'Data item invoice tidak valid.';
  end if;

  select sum(round(item.quantity * item.unit_price, 2))
  into computed_total
  from jsonb_to_recordset(p_items) as item(description text, quantity numeric, unit_price numeric);

  if computed_total is null or computed_total <= 0 then
    raise exception 'Total invoice harus lebih besar dari 0.';
  end if;

  insert into public.invoices (invoice_number, customer_id, invoice_date, due_date, total_amount)
  values (trim(p_invoice_number), p_customer_id, p_invoice_date, p_due_date, computed_total)
  returning id into new_invoice_id;

  insert into public.invoice_items (invoice_id, description, quantity, unit_price)
  select new_invoice_id, item.description, item.quantity, item.unit_price
  from jsonb_to_recordset(p_items) as item(description text, quantity numeric, unit_price numeric);

  return new_invoice_id;
end;
$$;

create or replace function public.record_invoice_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_date date,
  p_payment_method text
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  invoice_total numeric(14, 2);
  paid_total numeric(14, 2);
  new_payment_id uuid;
begin
  select total_amount into invoice_total
  from public.invoices
  where id = p_invoice_id
  for update;

  if not found then
    raise exception 'Invoice tidak ditemukan.';
  end if;

  select coalesce(sum(amount), 0) into paid_total
  from public.payments
  where invoice_id = p_invoice_id;

  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2)
    or p_amount > invoice_total - paid_total then
    raise exception 'Pembayaran harus lebih besar dari 0 dan tidak boleh melebihi sisa saldo.';
  end if;

  insert into public.payments (invoice_id, amount, payment_date, payment_method)
  values (p_invoice_id, p_amount, p_payment_date, p_payment_method)
  returning id into new_payment_id;

  return new_payment_id;
end;
$$;

revoke all on function public.create_invoice_with_items(text, uuid, date, date, jsonb) from public, anon, authenticated;
grant execute on function public.create_invoice_with_items(text, uuid, date, date, jsonb) to service_role;
revoke all on function public.record_invoice_payment(uuid, numeric, date, text) from public, anon, authenticated;
grant execute on function public.record_invoice_payment(uuid, numeric, date, text) to service_role;

-- Akses data hanya melalui backend tepercaya yang menggunakan service role key.
-- Jangan pernah menaruh SUPABASE_SERVICE_ROLE_KEY di frontend/browser.
alter table public.customers enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments enable row level security;
