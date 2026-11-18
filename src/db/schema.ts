export const MIGRATIONS: string[] = [
  `
  create table if not exists product (
    id integer primary key,
    store text not null,
    glovo_id text not null,
    name text not null,
    barcode text,
    unit text,
    last_price integer,
    last_seen text not null,
    unique(store, glovo_id)
  );
  create table if not exists product_match (
    glovo_key text primary key,
    dazoge_id text not null,
    confidence real not null,
    confirmed_at text not null
  );
  create table if not exists delivery (
    id integer primary key,
    glovo_order_id text not null unique,
    store text not null,
    placed_at text not null,
    total integer not null,
    status text not null default 'placed'
  );
  create table if not exists delivery_item (
    id integer primary key,
    delivery_id integer not null references delivery(id),
    product_name text not null,
    ingredient text,
    qty real not null,
    unit text not null,
    line_total integer not null
  );
  create table if not exists meal (
    id integer primary key,
    date text not null,
    slot text not null check (slot in ('breakfast','lunch','dinner')),
    title text not null,
    notes text,
    status text not null default 'planned' check (status in ('planned','cooked','skipped')),
    pantry_decremented integer not null default 0 check (pantry_decremented in (0,1))
  );
  create table if not exists meal_ingredient (
    id integer primary key,
    meal_id integer not null references meal(id),
    ingredient text not null,
    qty real not null,
    unit text not null
  );
  create table if not exists pantry (
    ingredient text primary key,
    qty real not null,
    unit text not null,
    updated_at text not null
  );
  create table if not exists note (
    id integer primary key,
    created_at text not null,
    text text not null
  );
  create table if not exists checkout_log (
    id integer primary key,
    created_at text not null,
    cart_json text not null,
    outcome text not null,
    glovo_order_id text,
    screenshot text
  );
  `,
];
