require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Razorpay = require('razorpay');
const cors = require('cors');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const db = require('./database');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend')));

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_canteen_key';

// Razorpay config
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_dummy_key',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'rzp_test_dummy_secret'
});

// Middleware to verify JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access Denied. Please log in." });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid or expired token." });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required." });
    }
    next();
  });
}

// --- Auth Routes ---

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });

  const hash = bcrypt.hashSync(password, 10);
  db.run("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, hash], function(err) {
    if (err) {
      if (err.message.includes('UNIQUE')) return res.status(400).json({ error: "Email already exists." });
      return res.status(500).json({ error: err.message });
    }
    
    // Generate token
    const token = jwt.sign({ id: this.lastID, email, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: this.lastID, name, email, role: 'student' } });
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(400).json({ error: "Invalid email or password" });

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.status(400).json({ error: "Invalid email or password" });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });
});

// Forgot Password
app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  db.get("SELECT id FROM users WHERE email = ?", [email], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: "User not found" });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

    db.run("UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?", [resetToken, expiry, user.id], (err) => {
      if (err) return res.status(500).json({ error: err.message });

      const protocol = req.protocol;
      const host = req.get('host');
      const resetLink = `${protocol}://${host}/reset-password.html?token=${resetToken}`;
      
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Password Reset - Canteen Express',
        html: `
          <h2>Password Reset Request</h2>
          <p>You requested to reset your password. Click the link below to set a new password:</p>
          <a href="${resetLink}">${resetLink}</a>
          <p>This link will expire in 1 hour.</p>
          <p>If you did not request this, please ignore this email.</p>
        `
      };

      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.error("Email error:", error);
          return res.status(500).json({ error: "Failed to send email. Please check your SMTP configuration in .env." });
        }
        res.json({ message: "Password reset link sent to your email." });
      });
    });
  });
});

// Reset Password
app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  
  db.get("SELECT id, reset_token_expiry FROM users WHERE reset_token = ?", [token], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(400).json({ error: "Invalid or expired reset token" });
    
    if (new Date(user.reset_token_expiry) < new Date()) {
      return res.status(400).json({ error: "Reset token has expired" });
    }

    try {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      db.run("UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?", [hashedPassword, user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: "Password updated successfully" });
      });
    } catch (hashError) {
      res.status(500).json({ error: hashError.message });
    }
  });
});

// --- API Routes ---

// Get all menu items (Public or Students? User requested students should log in to view and order)
app.get('/api/items', authenticateToken, (req, res) => {
  db.all("SELECT * FROM items", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Add new item (Admin)
app.post('/api/items', requireAdmin, (req, res) => {
  const { name, price, image, available } = req.body;
  db.run("INSERT INTO items (name, price, image, available) VALUES (?, ?, ?, ?)",
    [name, price, image, available === undefined ? 1 : available], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('menu_updated');
      res.json({ id: this.lastID });
  });
});

// Update item (Admin)
app.put('/api/items/:id', requireAdmin, (req, res) => {
  const { name, price, image, available } = req.body;
  const { id } = req.params;
  db.run("UPDATE items SET name=?, price=?, image=?, available=? WHERE id=?", 
    [name, price, image, available ? 1 : 0, id], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('menu_updated');
      res.json({ updated: this.changes });
    }
  );
});

// Delete item (Admin)
app.delete('/api/items/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM items WHERE id=?", [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('menu_updated');
    res.json({ deleted: this.changes });
  });
});

// Create Order (Initialize Razorpay Payment)
app.post('/api/orders/create', authenticateToken, async (req, res) => {
  const { items, total } = req.body;
  try {
    const options = {
      amount: Math.round(total * 100),
      currency: "INR",
      receipt: "receipt_order_" + Date.now()
    };
    try {
      const order = await razorpay.orders.create(options);
      res.json({ razorpayOrderId: order.id, amount: options.amount });
    } catch(rzpError) {
      res.json({ razorpayOrderId: 'order_dummy_' + Date.now(), amount: options.amount, dummy: true });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify Payment and Save Order
app.post('/api/orders/verify', authenticateToken, (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, items, total } = req.body;
  const userId = req.user.id;
  
  const orderId = 'ORD' + Date.now();
  const itemsStr = JSON.stringify(items);
  
  db.run("INSERT INTO orders (id, items, total, status, razorpay_order_id, razorpay_payment_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [orderId, itemsStr, total, 'Pending', razorpay_order_id, razorpay_payment_id, userId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      db.get("SELECT * FROM orders WHERE id = ?", [orderId], (err, row) => {
        if (!err && row) {
          io.emit('new_order', row);
        }
      });

      res.json({ success: true, orderId });
    }
  );
});

// Get orders for current user (Student)
app.get('/api/orders/me', authenticateToken, (req, res) => {
  db.all("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC", [req.user.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get all orders (Admin)
app.get('/api/orders', requireAdmin, (req, res) => {
  db.all("SELECT * FROM orders ORDER BY created_at DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Update order status (Admin)
app.put('/api/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  db.run("UPDATE orders SET status=? WHERE id=?", [status, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('order_status_update', { id, status });
    res.json({ updated: this.changes });
  });
});

// Delete all delivered orders (Admin)
app.delete('/api/orders/delivered', requireAdmin, (req, res) => {
  db.run("DELETE FROM orders WHERE status='Delivered'", [], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: this.changes });
  });
});

// Fetch specific order details via ID (For QR Scan - Admin only)
app.get('/api/orders/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM orders WHERE id=?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Order not found" });
    res.json(row);
  });
});

// Get item sales statistics (Admin)
app.get('/api/items/stats', requireAdmin, (req, res) => {
  db.all("SELECT * FROM orders", [], (err, orders) => {
    if (err) return res.status(500).json({ error: err.message });
    
    const itemStats = {};
    
    orders.forEach(order => {
      const items = JSON.parse(order.items);
      items.forEach(item => {
        if (!itemStats[item.id]) {
          itemStats[item.id] = {
            name: item.name,
            orderedQuantity: 0,
            deliveredQuantity: 0,
            totalRevenue: 0
          };
        }
        itemStats[item.id].orderedQuantity += item.quantity;
        if (order.status === 'Delivered') {
          itemStats[item.id].deliveredQuantity += item.quantity;
          itemStats[item.id].totalRevenue += item.quantity * item.price;
        }
      });
    });
    
    res.json(itemStats);
  });
});

function cleanupDeliveredOrders() {
  db.run("DELETE FROM orders WHERE status='Delivered' AND date(created_at) < date('now','localtime')", [], function(err) {
    if (err) {
      console.error('Delivered orders cleanup failed:', err.message);
    } else if (this.changes > 0) {
      console.log(`Cleaned up ${this.changes} delivered orders from previous days.`);
    }
  });
}

// Remove delivered orders from previous days immediately on startup
cleanupDeliveredOrders();

// Schedule cleanup at midnight local time every day
const now = new Date();
const nextMidnight = new Date(now);
nextMidnight.setHours(24, 0, 0, 0);
const msUntilMidnight = nextMidnight - now;
setTimeout(() => {
  cleanupDeliveredOrders();
  setInterval(cleanupDeliveredOrders, 24 * 60 * 60 * 1000);
}, msUntilMidnight);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
