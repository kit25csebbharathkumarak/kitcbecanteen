const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Set DATABASE_URL in your environment.');
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, ... style
const formatQuery = (sql, params = []) => {
  let index = 0;
  const formattedSql = sql.replace(/\?/g, () => `$${++index}`);
  return { sql: formattedSql, params };
};

const db = {
  isPostgres: true,
  run(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const { sql: formatted, params: converted } = formatQuery(sql, params);
    pool.query(formatted, converted)
      .then(result => {
        const info = { changes: result.rowCount, lastID: result.rows?.[0]?.id ?? null };
        if (callback) callback(null, info);
      })
      .catch(err => { if (callback) callback(err); });
  },
  get(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const { sql: formatted, params: converted } = formatQuery(sql, params);
    pool.query(formatted, converted)
      .then(result => callback(null, result.rows[0] || null))
      .catch(err => callback(err));
  },
  all(sql, params = [], callback) {
    if (typeof params === 'function') { callback = params; params = []; }
    const { sql: formatted, params: converted } = formatQuery(sql, params);
    pool.query(formatted, converted)
      .then(result => callback(null, result.rows))
      .catch(err => callback(err));
  },
  serialize(fn) { fn(); },
  close() { return pool.end(); }
};

// ─── DEFAULT SEED DATA ────────────────────────────────────────────────────────
const defaultItems = [
  ['Empty Biryani',   20,  'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=500&q=80', 50],
  ['Chicken Biryani', 110, 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=500&q=80', 30],
  ['Curd Rice',        30, 'https://images.unsplash.com/photo-1576107232684-1279f3908594?auto=format&fit=crop&w=500&q=80', 100],
  ['Parota Set',       30, 'https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=500&q=80', 40],
  ['Chicken Rice',    110, 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=500&q=80', 25],
];

// ─── DATABASE INITIALISATION ──────────────────────────────────────────────────
const initializeDatabase = async () => {
  // Users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                 SERIAL PRIMARY KEY,
      name               TEXT NOT NULL,
      email              TEXT UNIQUE NOT NULL,
      password           TEXT NOT NULL,
      role               TEXT DEFAULT 'student',
      reset_token        TEXT,
      reset_token_expiry TIMESTAMP
    )
  `);

  // Menu items table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      price     NUMERIC NOT NULL,
      image     TEXT NOT NULL,
      available BOOLEAN DEFAULT TRUE,
      stock     INTEGER DEFAULT 0
    )
  `);

  // Orders table

  // Settings table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  
  await pool.query(`
    INSERT INTO settings (key, value) 
    VALUES ('shop_open', 'true') 
    ON CONFLICT (key) DO NOTHING
  `);

  // Orders table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id              TEXT PRIMARY KEY,
      items           TEXT NOT NULL,
      total           NUMERIC NOT NULL,
      status          TEXT DEFAULT 'Pending',
      paytm_order_id  TEXT,
      paytm_payment_id TEXT,
      user_id         INTEGER REFERENCES users(id),
      created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      txn_ref         TEXT,
      txn_id          TEXT,
      paid_at         TIMESTAMP
    )
  `);

  // Add new UPI columns to existing orders table if they don't exist yet
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS txn_ref TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS txn_id  TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS zoho_payment_session_id TEXT`);

  // Transactions table — for webhook idempotency
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      txn_id     TEXT PRIMARY KEY,
      order_id   TEXT NOT NULL,
      status     TEXT NOT NULL,
      amount     NUMERIC NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed menu items if empty
  const itemsCount = await pool.query('SELECT COUNT(*)::int AS count FROM items');
  if (parseInt(itemsCount.rows[0].count, 10) === 0) {
    for (const item of defaultItems) {
      await pool.query(
        'INSERT INTO items (name, price, image, stock) VALUES ($1, $2, $3, $4)',
        item
      );
    }
    console.log('Database seeded with default menu items.');
  }

  // Seed admin user if none exists
  const adminCount = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
  if (parseInt(adminCount.rows[0].count, 10) === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query(
      'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)',
      ['Admin', 'admin@canteen.com', hash, 'admin']
    );
    console.log('Admin seeded — email: admin@canteen.com  password: admin123');
  }

  console.log('✅ Database initialised successfully.');
};

initializeDatabase().catch((error) => {
  console.error('PostgreSQL initialisation failed:', error);
  process.exit(1);
});

module.exports = db;
