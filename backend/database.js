const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');

const dbPath = path.resolve(__dirname, 'canteen.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Create Items Table
  db.run(`CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    image TEXT NOT NULL,
    available INTEGER DEFAULT 1
  )`);

  // Create Orders Table
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    items TEXT NOT NULL,
    total REAL NOT NULL,
    status TEXT DEFAULT 'Pending',
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Try to add the user_id column in case the table was created before the auth update
  db.run("ALTER TABLE orders ADD COLUMN user_id INTEGER", (err) => {
    // Ignore error if column already exists
  });

  // Seed default data if items are empty
  db.get("SELECT COUNT(*) as count FROM items", (err, row) => {
    if (row && row.count === 0) {
      const stmt = db.prepare("INSERT INTO items (name, price, image) VALUES (?, ?, ?)");
      const defaultItems = [
        ["Spicy Chicken Burger", 120, "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=500&q=80"],
        ["Margherita Pizza", 150, "https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=500&q=80"],
        ["French Fries", 60, "https://images.unsplash.com/photo-1576107232684-1279f3908594?auto=format&fit=crop&w=500&q=80"],
        ["Cold Coffee", 80, "https://images.unsplash.com/photo-1461023058943-07fcbe16d735?auto=format&fit=crop&w=500&q=80"],
        ["Grilled Sandwich", 90, "https://images.unsplash.com/photo-1528735602780-2552fd46c7af?auto=format&fit=crop&w=500&q=80"]
      ];
      defaultItems.forEach(item => stmt.run(item));
      stmt.finalize();
      console.log("Database seeded with default items.");
    }
  });

  // Create Users Table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'student',
    reset_token TEXT,
    reset_token_expiry DATETIME
  )`);

  // Try to add the reset token columns in case the table was created before
  db.run("ALTER TABLE users ADD COLUMN reset_token TEXT", (err) => {});
  db.run("ALTER TABLE users ADD COLUMN reset_token_expiry DATETIME", (err) => {});

  // Seed Admin user
  db.get("SELECT COUNT(*) as count FROM users WHERE role = 'admin'", (err, row) => {
    if (row && row.count === 0) {
      const hash = bcrypt.hashSync('admin123', 10);
      db.run("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
        ['Admin', 'admin@canteen.com', hash, 'admin']);
      console.log("Database seeded with default Admin user.");
    }
  });
});

module.exports = db;
