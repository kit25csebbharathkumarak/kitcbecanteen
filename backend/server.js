require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const emailjs = require('@emailjs/nodejs');
const crypto = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const axios = require('axios');
const db = require('./database');
const { OAuth2Client } = require('google-auth-library');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET is required. Set JWT_SECRET in your environment.');
}
const JWT_SECRET = process.env.JWT_SECRET;

const app = express();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let isShopOpen = true;

// Initialize shop status from DB
setTimeout(() => {
  db.get("SELECT value FROM settings WHERE key = 'shop_open'", (err, row) => {
    if (row) isShopOpen = row.value === 'true';
  });
}, 2000); // slight delay to ensure DB is initialized

const activeCarts = {}; // activeCarts[userId] = { itemId: qty }
const activeConnections = {}; // activeConnections[userId] = count
const disconnectTimeouts = {}; // disconnectTimeouts[userId] = timerId

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Authentication error'));
    socket.userId = decoded.id;
    next();
  });
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  
  if (!activeCarts[userId]) activeCarts[userId] = {};
  if (!activeConnections[userId]) activeConnections[userId] = 0;
  
  activeConnections[userId]++;
  
  if (disconnectTimeouts[userId]) {
    clearTimeout(disconnectTimeouts[userId]);
    delete disconnectTimeouts[userId];
  }

  // Initial emit to restore cart state if any
  socket.emit('cart_updated', activeCarts[userId]);

  socket.on('update_cart', (data) => {
    const { itemId, change } = data;
    if (!itemId || typeof change !== 'number' || change === 0) return;

    if (change > 0) {
      // Atomic conditional decrement: only decrement if available stock >= change
      db.run('UPDATE items SET stock = stock - ? WHERE id = ? AND stock >= ?', [change, itemId, change], (err, info) => {
        if (err) return socket.emit('cart_error', 'Database error');
        if (!info || info.changes === 0) {
          return socket.emit('cart_error', 'Insufficient stock available.');
        }
        activeCarts[userId][itemId] = (activeCarts[userId][itemId] || 0) + change;
        io.emit('menu_updated');
        socket.emit('cart_updated', activeCarts[userId]);
      });
    } else if (change < 0) {
      const currentInCart = activeCarts[userId][itemId] || 0;
      const removeAmt = Math.min(Math.abs(change), currentInCart);
      if (removeAmt > 0) {
        db.run('UPDATE items SET stock = stock + ? WHERE id = ?', [removeAmt, itemId], (err) => {
          if (!err) {
            activeCarts[userId][itemId] -= removeAmt;
            if (activeCarts[userId][itemId] <= 0) delete activeCarts[userId][itemId];
            io.emit('menu_updated');
            socket.emit('cart_updated', activeCarts[userId]);
          }
        });
      }
    }
  });

  socket.on('disconnect', () => {
    activeConnections[userId]--;
    
    if (activeConnections[userId] === 0) {
      disconnectTimeouts[userId] = setTimeout(() => {
        const userCart = activeCarts[userId] || {};
        const itemIds = Object.keys(userCart);
        if (itemIds.length > 0) {
          const updatePromises = itemIds.map(itemId => {
            return new Promise(resolve => {
              const qty = userCart[itemId];
              if (qty > 0) {
                db.run('UPDATE items SET stock = stock + ? WHERE id = ?', [qty, itemId], resolve);
              } else {
                resolve();
              }
            });
          });
          Promise.all(updatePromises).then(() => {
            io.emit('menu_updated');
          });
        }
        delete activeCarts[userId];
        delete activeConnections[userId];
        delete disconnectTimeouts[userId];
      }, 5000);
    }
  });
});

let cachedZohoToken = null;
let zohoTokenExpiry = null;

const getZohoAccessToken = async () => {
  if (cachedZohoToken && zohoTokenExpiry && Date.now() < zohoTokenExpiry) {
    return cachedZohoToken;
  }

  try {
    const params = new URLSearchParams();
    params.append('refresh_token', process.env.ZOHO_REFRESH_TOKEN || '');
    params.append('client_id', process.env.ZOHO_CLIENT_ID || '');
    params.append('client_secret', process.env.ZOHO_CLIENT_SECRET || '');
    params.append('grant_type', 'refresh_token');

    // Use .in or .com depending on your Zoho region (defaulting to .in)
    const accountsUrl = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in';

    const res = await axios.post(`${accountsUrl}/oauth/v2/token`, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    cachedZohoToken = res.data.access_token;
    // Zoho returns expires_in in seconds (usually 3600). We subtract 5 minutes (300000ms) for a safety margin.
    const expiresInMs = (res.data.expires_in * 1000) || (60 * 60 * 1000);
    zohoTokenExpiry = Date.now() + expiresInMs - 300000;

    return cachedZohoToken;
  } catch (err) {
    console.error('Zoho Auth Error:', err.response?.data || err.message);
    throw new Error('Failed to get Zoho Access Token');
  }
};


// --- HELMET + CORS + STATIC FILES ---
app.use(helmet({
  contentSecurityPolicy: false, // Allows inline scripts/resources used by frontend
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend')));

// --- GLOBAL JSON PARSER (limit payload size) ---
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// --- RATE LIMITERS ---
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 25, // limit each IP to 25 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' }
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10, // limit each IP to 10 OTP requests per 10 mins
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests from this IP. Please try again after 10 minutes.' }
});

// --- AUTH MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access Denied. Please log in.' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
    next();
  });
}

// --- AUTH ROUTES ---
const otps = new Map(); // email -> { otp, expiresAt }

// Opportunistic cleanup of expired OTPs to prevent memory leak
function pruneExpiredOtps() {
  const now = Date.now();
  for (const [email, data] of otps.entries()) {
    if (now > data.expiresAt) {
      otps.delete(email);
    }
  }
}
setInterval(pruneExpiredOtps, 5 * 60 * 1000); // Clean every 5 minutes

app.post('/api/auth/send-otp', otpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Valid email is required' });

  // Generate 6-digit numeric OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  otps.set(email.toLowerCase().trim(), { otp, expiresAt });

  try {
    const templateParams = {
      to_email: email.trim(),
      otp: otp,
      message: `Your One-Time Password (OTP) for SRI CUMIN SEEDS CATERING SERVICES is: ${otp}. It is valid for 5 minutes.`
    };

    await emailjs.send(
      process.env.EMAILJS_SERVICE_ID,
      process.env.EMAILJS_TEMPLATE_ID,
      templateParams,
      {
        publicKey: process.env.EMAILJS_PUBLIC_KEY,
        privateKey: process.env.EMAILJS_PRIVATE_KEY,
      }
    );
    
    res.json({ success: true, message: 'Verification code sent to your email via EmailJS.' });
  } catch (err) {
    console.error('Send OTP Email exception:', err);
    return res.status(500).json({ error: 'Failed to send verification code via EmailJS.' });
  }
});

app.post('/api/auth/register', authLimiter, (req, res) => {
  let { name, email, password, otp } = req.body;
  if (!name || !email || !password || !otp) return res.status(400).json({ error: 'Missing fields' });

  // Sanitize name: string, max 60 chars, strip dangerous HTML angle brackets
  if (typeof name !== 'string') return res.status(400).json({ error: 'Invalid name format' });
  name = name.trim().replace(/[<>]/g, '');
  if (name.length === 0 || name.length > 60) {
    return res.status(400).json({ error: 'Name must be between 1 and 60 characters and contain no HTML tags.' });
  }

  email = String(email).toLowerCase().trim();
  const storedOtpData = otps.get(email);
  if (!storedOtpData) {
    return res.status(400).json({ error: 'No verification code sent for this email.' });
  }

  if (storedOtpData.otp !== String(otp).trim()) {
    return res.status(400).json({ error: 'Invalid verification code.' });
  }

  if (Date.now() > storedOtpData.expiresAt) {
    otps.delete(email);
    return res.status(400).json({ error: 'Verification code has expired.' });
  }

  // OTP verified, remove it
  otps.delete(email);

  const hash = bcrypt.hashSync(password, 10);
  db.run(
    "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'student') RETURNING id",
    [name, email, hash],
    function (err, info) {
      if (err) {
        if (err.message.includes('unique') || err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: 'Email already exists.' });
        }
        return res.status(500).json({ error: err.message });
      }
      const userId = info?.lastID || this?.lastID;
      const token = jwt.sign({ id: userId, email, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id: userId, name, email, role: 'student' } });
    }
  );
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(400).json({ error: 'Invalid email or password' });

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  });
});

app.get('/api/auth/google-client-id', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
});

app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();
    const name = payload.name;

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
      if (err) return res.status(500).json({ error: err.message });

      if (user) {
        // User exists, log them in
        const jwtToken = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        return res.json({ token: jwtToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
      } else {
        // User doesn't exist, create account
        const randomPassword = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, 10);
        
        db.run(
          'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?) RETURNING id',
          [name, email, hashedPassword, 'student'],
          (insertErr, info) => {
            if (insertErr) return res.status(500).json({ error: insertErr.message });
            
            const newUserId = info.lastID;
            const jwtToken = jwt.sign({ id: newUserId, email: email, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ token: jwtToken, user: { id: newUserId, name: name, email: email, role: 'student' } });
          }
        );
      }
    });

  } catch (error) {
    console.error('Google verification error:', error);
    res.status(401).json({ error: 'Invalid Google token' });
  }
});

app.post('/api/auth/forgot-password', authLimiter, (req, res) => {
  const { email } = req.body;
  db.get('SELECT id FROM users WHERE email = ?', [email], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 3600000).toISOString();

    db.run('UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?',
      [resetToken, expiry, user.id], async (err) => {
        if (err) return res.status(500).json({ error: err.message });

        const resetLink = `${req.protocol}://${req.get('host')}/reset-password.html?token=${resetToken}`;
        try {
          const templateParams = {
            to_email: email,
            reset_link: resetLink,
            message: `Click the following link to reset your password: ${resetLink}. The link is valid for 1 hour.`
          };

          await emailjs.send(
            process.env.EMAILJS_SERVICE_ID,
            process.env.EMAILJS_TEMPLATE_ID,
            templateParams,
            {
              publicKey: process.env.EMAILJS_PUBLIC_KEY,
              privateKey: process.env.EMAILJS_PRIVATE_KEY,
            }
          );

          res.json({ message: 'Password reset link sent to your email via EmailJS.' });
        } catch (err) {
          console.error('Email exception:', err);
          return res.status(500).json({ error: 'Failed to send reset link via EmailJS.' });
        }
      });
  });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  db.get('SELECT id, reset_token_expiry FROM users WHERE reset_token = ?', [token], async (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });
    if (new Date(user.reset_token_expiry) < new Date()) {
      return res.status(400).json({ error: 'Reset token has expired' });
    }
    try {
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      db.run(
        'UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?',
        [hashedPassword, user.id],
        (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, message: 'Password updated successfully' });
        }
      );
    } catch (hashError) {
      res.status(500).json({ error: hashError.message });
    }
  });
});

// --- MENU ITEM ROUTES ---
app.get('/api/items', authenticateToken, (req, res) => {
  db.all('SELECT * FROM items ORDER BY id ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/items', requireAdmin, (req, res) => {
  let { name, price, image, available, stock } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Valid item name is required' });
  }
  const numericPrice = parseFloat(price);
  if (isNaN(numericPrice) || numericPrice < 0) {
    return res.status(400).json({ error: 'Price must be a non-negative number' });
  }
  const numericStock = parseInt(stock, 10);
  if (isNaN(numericStock) || numericStock < 0) {
    return res.status(400).json({ error: 'Stock must be a non-negative integer' });
  }

  db.run(
    'INSERT INTO items (name, price, image, available, stock) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [name.trim(), numericPrice, image || '', available === undefined ? true : !!available, numericStock],
    function (err, info) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('menu_updated');
      res.json({ id: info?.lastID ?? null });
    }
  );
});

app.put('/api/items/:id', requireAdmin, (req, res) => {
  let { name, price, image, available, stock } = req.body;
  const { id } = req.params;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Valid item name is required' });
  }
  const numericPrice = parseFloat(price);
  if (isNaN(numericPrice) || numericPrice < 0) {
    return res.status(400).json({ error: 'Price must be a non-negative number' });
  }
  const numericStock = parseInt(stock, 10);
  if (isNaN(numericStock) || numericStock < 0) {
    return res.status(400).json({ error: 'Stock must be a non-negative integer' });
  }

  db.run(
    'UPDATE items SET name=?, price=?, image=?, available=?, stock=? WHERE id=?',
    [name.trim(), numericPrice, image || '', available === undefined ? true : !!available, numericStock, id],
    function (err, info) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('menu_updated');
      res.json({ updated: info?.changes ?? 0 });
    }
  );
});

app.delete('/api/items/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM items WHERE id=?', [id], function (err, info) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('menu_updated');
    res.json({ deleted: info?.changes ?? 0 });
  });
});

// --- ZOHO CONFIG ROUTE ---
app.get('/api/zoho-config', (req, res) => {
  res.json({
    api_key: process.env.ZOHO_API_KEY || '',
    account_id: process.env.ZOHO_ACCOUNT_ID || ''
  });
});

// --- ORDER ROUTES ---

// Create order — calls BS Solutions Gateway for payment link
// Shop Status Routes
app.get('/api/shop-status', (req, res) => {
  res.json({ isOpen: isShopOpen });
});

app.post('/api/shop-status', requireAdmin, (req, res) => {
  const { isOpen } = req.body;
  if (typeof isOpen !== 'boolean') return res.status(400).json({ error: 'isOpen must be a boolean' });
  
  isShopOpen = isOpen;
  db.run("INSERT INTO settings (key, value) VALUES ('shop_open', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [isOpen.toString()], (err) => {
    if (err) return res.status(500).json({ error: 'DB Error' });
    io.emit('shop_status_changed', isShopOpen);
    res.json({ success: true, isOpen: isShopOpen });
  });
});

app.post('/api/orders/create', authenticateToken, async (req, res) => {
  if (!isShopOpen) {
    return res.status(400).json({ error: 'The shop is currently closed. Please try again later.' });
  }
  const { items, total } = req.body;
  const userId = req.user.id;

  if (!items || !Array.isArray(items) || items.length === 0 || !total) {
    return res.status(400).json({ error: 'Invalid order details' });
  }

  // Acquire a dedicated client for transaction
  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch item prices and details with row-level locks
    const itemIds = items.map(i => i.id);
    const placeholders = itemIds.map((_, i) => `$${i + 1}`).join(',');
    const itemRes = await client.query(
      `SELECT id, name, price, image, stock FROM items WHERE id IN (${placeholders}) FOR UPDATE`,
      itemIds
    );
    const rows = itemRes.rows;

    let serverTotal = 0;
    const sanitizedItems = [];

    // Calculate serverTotal and validate quantities
    for (const item of items) {
      const dbItem = rows.find(r => r.id === item.id);
      if (!dbItem) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Item not found: ${item.id}` });
      }

      const requestedQty = parseInt(item.quantity, 10);
      if (isNaN(requestedQty) || requestedQty <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Invalid quantity for ${dbItem.name}` });
      }

      // If user had items reserved in cart socket, that was already decremented from stock
      const reservedInCart = (activeCarts[userId] && activeCarts[userId][item.id]) || 0;
      const additionalRequired = requestedQty - reservedInCart;

      if (additionalRequired > 0) {
        // Decrement atomically from remaining DB stock
        const decrRes = await client.query(
          'UPDATE items SET stock = stock - $1 WHERE id = $2 AND stock >= $1',
          [additionalRequired, item.id]
        );
        if (decrRes.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Not enough stock available for ${dbItem.name}` });
        }
      }

      serverTotal += Number(dbItem.price) * requestedQty;
      sanitizedItems.push({
        id: dbItem.id,
        name: dbItem.name,
        price: Number(dbItem.price),
        image: dbItem.image,
        quantity: requestedQty
      });
    }

    const orderId = 'ORD' + Date.now();
    const txnRef = orderId;
    const itemsStr = JSON.stringify(sanitizedItems);

    // 2. Obtain Payment Session or Gateway URL
    let paymentSessionId = null;
    let paymentUrl = null;

    // Check if Zoho is configured
    if (process.env.ZOHO_ACCOUNT_ID && process.env.ZOHO_CLIENT_ID && process.env.ZOHO_REFRESH_TOKEN) {
      try {
        const accessToken = await getZohoAccessToken();
        const zohoRes = await axios.post(
          `https://payments.zoho.in/api/v1/paymentsessions?account_id=${process.env.ZOHO_ACCOUNT_ID}`,
          {
            amount: serverTotal,
            currency: "INR"
          },
          {
            headers: {
              'Authorization': `Zoho-oauthtoken ${accessToken}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );
        paymentSessionId = zohoRes.data?.payments_session?.payments_session_id || 'zoho_' + orderId;
      } catch (zohoErr) {
        console.error('Zoho Payments session error:', zohoErr.response?.data || zohoErr.message);
        paymentSessionId = 'zoho_fallback_' + orderId;
      }
    } else if (process.env.UPI_GATEWAY_URL && process.env.UPI_GATEWAY_KEY) {
      // Check if UPI Gateway is configured
      try {
        const gatewayBaseUrl = process.env.UPI_GATEWAY_URL.replace(/\/+$/, '');
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        
        const paymentReq = await axios.post(`${gatewayBaseUrl}/api/gateway/payment/create`, {
          clientCode: process.env.UPI_GATEWAY_KEY,
          developerOrderId: orderId,
          amount: serverTotal,
          callbackUrl: `${frontendUrl}/api/payment-callback`
        }, { timeout: 8000 });
        
        paymentUrl = paymentReq.data?.payment_url || null;
      } catch (gatewayErr) {
        console.error('UPI Gateway Error:', gatewayErr.response?.data || gatewayErr.message);
        // Fallback session so student can proceed
        paymentSessionId = 'upi_session_' + orderId;
      }
    }

    if (!paymentSessionId && !paymentUrl) {
      paymentSessionId = 'session_' + orderId;
    }

    // 3. Insert order row into DB
    await client.query(
      "INSERT INTO orders (id, items, total, status, txn_ref, user_id, zoho_payment_session_id) VALUES ($1, $2, $3, 'Pending Payment', $4, $5, $6)",
      [orderId, itemsStr, serverTotal, txnRef, userId, paymentSessionId]
    );

    // Commit transaction
    await client.query('COMMIT');

    // 4. Update in-memory activeCarts
    if (activeCarts[userId]) {
      sanitizedItems.forEach(item => {
        if (activeCarts[userId][item.id]) {
          activeCarts[userId][item.id] -= item.quantity;
          if (activeCarts[userId][item.id] <= 0) {
            delete activeCarts[userId][item.id];
          }
        }
      });
      if (Object.keys(activeCarts[userId]).length === 0) {
        delete activeCarts[userId];
      }
    }

    // Broadcast new order to Admin Dashboard immediately
    io.emit('new_order', {
      id: orderId,
      items: itemsStr,
      total: serverTotal,
      status: 'Pending Payment',
      user_id: userId,
      user_name: req.user.name,
      created_at: new Date()
    });
    io.emit('menu_updated');

    return res.json({
      success: true,
      orderId,
      payment_url: paymentUrl,
      paymentSessionId,
      amount: serverTotal
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Order creation transaction failed:', err);
    return res.status(500).json({ error: 'Order creation failed: ' + err.message });
  } finally {
    client.release();
  }
});

// Zoho Payments Webhook Callback
app.post('/api/orders/zoho-webhook', (req, res) => {
  const payload = req.body;
  console.log('[Zoho Webhook] Received:', payload);

  const signingKey = process.env.ZOHO_SIGNING_KEY;
  if (!signingKey) {
    console.error('[Zoho Webhook] ERROR: ZOHO_SIGNING_KEY not configured on server.');
    return res.status(500).json({ error: 'Webhook signature verification not configured' });
  }

  const signatureHeader = req.headers['x-zoho-webhook-signature'];
  if (!signatureHeader || !req.rawBody) {
    console.error('[Zoho Webhook] ERROR: Missing signature or raw body.');
    return res.status(401).json({ error: 'Missing signature or body' });
  }

  try {
    const parts = signatureHeader.split(',');
    const t = parts[0]?.split('=')[1];
    const v = parts[1]?.split('=')[1];

    if (!t || !v) {
      return res.status(401).json({ error: 'Malformed signature header' });
    }

    const data = `${t}.${req.rawBody.toString()}`;
    const expectedSignature = crypto
      .createHmac('sha256', signingKey)
      .update(data)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expectedSignature))) {
      console.error('[Zoho Webhook] ERROR: Invalid signature.');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    console.error('[Zoho Webhook] ERROR: Signature verification error:', err.message);
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  let paymentSessionId = payload.payments_session_id || payload.payment_session_id;
  let paymentStatus = payload.status;
  let txnId = payload.payment_id;

  if (!paymentSessionId && payload.data && payload.data.payment) {
     paymentSessionId = payload.data.payment.payments_session_id || payload.data.payment.payment_session_id;
     paymentStatus = payload.data.payment.status;
     txnId = payload.data.payment.payment_id;
  }

  // Also check if status is part of event_name
  if (payload.event_name === 'payment.succeeded') {
     paymentStatus = 'success';
  }

  const validStatuses = ['success', 'completed', 'succeeded', 'paid', 'approved'];
  if (!paymentSessionId || !validStatuses.includes(String(paymentStatus).toLowerCase())) {
    console.error('[Zoho Webhook] Invalid payload or uncompleted payment:', { paymentSessionId, paymentStatus, payload });
    return res.status(400).json({ error: 'Invalid payment payload or uncompleted payment', receivedStatus: paymentStatus });
  }

  db.get('SELECT * FROM orders WHERE zoho_payment_session_id = ?', [paymentSessionId], (err, order) => {
    if (err || !order) {
      console.error('[Zoho Webhook] Order not found for session:', paymentSessionId);
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'Pending Payment') {
      console.log('[Zoho Webhook] Order already processed:', order.id);
      return res.json({ success: true });
    }

    const recordedTxnId = txnId || `ZOHO_${Date.now()}`;

    db.run(
      "UPDATE orders SET status = 'Pending', txn_id = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?",
      [recordedTxnId, order.id],
      (updateErr) => {
        if (updateErr) {
          console.error('[Zoho Webhook] DB Update error:', updateErr.message);
          return res.status(500).json({ error: 'DB Error' });
        }

        // Record into transactions table for audit and idempotency
        db.run(
          'INSERT INTO transactions (txn_id, order_id, status, amount) VALUES (?, ?, ?, ?) ON CONFLICT (txn_id) DO NOTHING',
          [recordedTxnId, order.id, 'SUCCESS', order.total]
        );

        io.emit('payment_confirmed', { orderId: order.id, txnId: recordedTxnId });
        io.emit('new_order', { ...order, status: 'Pending', txn_id: recordedTxnId });
        io.emit('menu_updated');

        console.log(`[Zoho Webhook] Order ${order.id} confirmed -  txnId: ${recordedTxnId}`);
        return res.json({ success: true, orderId: order.id });
      }
    );
  });
});

// Helper: confirm a paid order and record transaction
function confirmOrderInDb(orderId, txnId, callback) {
  const resolvedTxnId = (txnId && String(txnId).trim()) ? String(txnId).trim() : `TXN_${Date.now()}`;

  db.get('SELECT * FROM orders WHERE id = ?', [orderId], (err, order) => {
    if (err || !order) {
      if (callback) callback(err || new Error('Order not found'));
      return;
    }

    if (order.status !== 'Pending Payment') {
      if (callback) callback(null, order);
      return;
    }

    db.run(
      "UPDATE orders SET status = 'Pending', txn_id = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?",
      [resolvedTxnId, orderId],
      (updateErr) => {
        if (updateErr) {
          if (callback) callback(updateErr);
          return;
        }

        // Record in transactions table
        db.run(
          'INSERT INTO transactions (txn_id, order_id, status, amount) VALUES (?, ?, ?, ?) ON CONFLICT (txn_id) DO NOTHING',
          [resolvedTxnId, orderId, 'SUCCESS', order.total],
          () => {}
        );

        order.status = 'Pending';
        order.txn_id = resolvedTxnId;

        // Clean activeCart if user exists
        if (order.user_id && activeCarts[order.user_id]) {
          delete activeCarts[order.user_id];
        }

        // Broadcast to all connected clients in real-time
        io.emit('payment_confirmed', { orderId, txnId: resolvedTxnId, userId: order.user_id });
        io.emit('new_order', { ...order, status: 'Pending', txn_id: resolvedTxnId });
        io.emit('order_status_update', { id: orderId, status: 'Pending', userId: order.user_id });
        io.emit('menu_updated');

        console.log(`[Order Confirmed] Order ${orderId} confirmed — txnId: ${resolvedTxnId}`);
        if (callback) callback(null, order);
      }
    );
  });
}

// Fallback Verification Endpoint (Zoho & Frontend Payment Verification)
app.post('/api/orders/verify-zoho-payment', async (req, res) => {
  const { paymentSessionId, orderId, paymentId } = req.body;
  const targetOrderId = orderId;
  if (!targetOrderId && !paymentSessionId) return res.status(400).json({ error: 'Missing order or session ID' });

  const query = targetOrderId ? 'SELECT * FROM orders WHERE id = ?' : 'SELECT * FROM orders WHERE zoho_payment_session_id = ?';
  const param = targetOrderId || paymentSessionId;

  db.get(query, [param], async (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'Pending Payment') return res.json({ success: true, alreadyProcessed: true, status: order.status });

    const resolvedTxnId = paymentId || `VERIFIED_${Date.now()}`;
    confirmOrderInDb(order.id, resolvedTxnId, (confirmErr, confirmedOrder) => {
      if (confirmErr) return res.status(500).json({ error: 'Failed to confirm order' });
      res.json({ success: true, orderId: order.id, status: 'Pending', txnId: resolvedTxnId });
    });
  });
});

// Unified Payment callback from Gateway / Webhook (handles GET and POST)
const handlePaymentCallback = async (req, res) => {
  const params = { ...req.query, ...req.body };
  const callbackOrderId = params.orderId || params.developerOrderId || params.order_id || params.id;
  const rawStatus = (params.status || params.payment_status || 'SUCCESS').toUpperCase();
  const txnId = params.txnId || params.paytmTxnId || params.transactionId || params.refId || `UPI_${Date.now()}`;

  console.log('[Callback] Received:', { status: rawStatus, callbackOrderId, fullQuery: req.query, fullBody: req.body });

  if (!callbackOrderId) {
    return res.redirect('/orders.html?error=missing_order');
  }

  // Find the order by id, paytm_order_id, or txn_ref
  db.get(
    'SELECT * FROM orders WHERE id = ? OR paytm_order_id = ? OR txn_ref = ?',
    [callbackOrderId, callbackOrderId, callbackOrderId],
    async (err, order) => {
      if (err || !order) {
        console.error('[Callback] Order not found for identifier:', callbackOrderId);
        return res.redirect(`/orders.html?payment=success&orderId=${callbackOrderId}`);
      }

      const isSuccess = ['SUCCESS', 'COMPLETED', 'PAID', 'TRUE'].includes(rawStatus);

      if (isSuccess) {
        confirmOrderInDb(order.id, txnId, (confirmErr) => {
          if (confirmErr) console.error('Error confirming order on callback:', confirmErr);
          res.redirect(`/orders.html?payment=success&orderId=${order.id}`);
        });
      } else {
        db.run("UPDATE orders SET status = 'Failed' WHERE id = ?", [order.id], () => {
          if (order.status === 'Pending Payment') {
            try {
              const items = JSON.parse(order.items);
              items.forEach(item => {
                db.run('UPDATE items SET stock = stock + ? WHERE id = ?', [item.quantity, item.id]);
              });
              io.emit('menu_updated');
            } catch (e) {}
          }
          io.emit('order_status_update', { id: order.id, status: 'Failed' });
          res.redirect('/orders.html?error=payment_failed');
        });
      }
    }
  );
};

app.get('/api/payment-callback', handlePaymentCallback);
app.post('/api/payment-callback', handlePaymentCallback);

// Admin: manually confirm a payment after verifying in their UPI/Paytm app
app.post('/api/orders/:id/confirm-payment', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { txnId } = req.body;  // optional - admin can type the UTR number

  confirmOrderInDb(id, txnId, (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, orderId: id, txnId: order.txn_id });
  });
});

// --- PAYMENT SYNC HELPERS ---
async function checkZohoPaymentStatus(paymentSessionId) {
  if (!process.env.ZOHO_ACCOUNT_ID || !process.env.ZOHO_CLIENT_ID) return null;
  try {
    const accessToken = await getZohoAccessToken();
    const accountId = process.env.ZOHO_ACCOUNT_ID;
    const res = await axios.get(
      `https://payments.zoho.in/api/v1/paymentsessions/${paymentSessionId}?account_id=${accountId}`,
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`
        },
        timeout: 5000
      }
    );
    return res.data;
  } catch (err) {
    console.error('Error fetching Zoho payment session:', err.response?.data || err.message);
    return null;
  }
}

async function syncOrderIfPending(order) {
  if (order.status !== 'Pending Payment') return order;

  // Check Zoho payment if configured
  if (order.zoho_payment_session_id && process.env.ZOHO_ACCOUNT_ID && process.env.ZOHO_CLIENT_ID) {
    try {
      const data = await checkZohoPaymentStatus(order.zoho_payment_session_id);
      if (data) {
        let session = data.payments_session || data;
        let paymentStatus = session.status;
        let txnId = session.payment_id || session.txn_id || session.transaction_id || `SYNC_${Date.now()}`;
        
        if (session.payment && session.payment.status) {
          paymentStatus = session.payment.status;
          txnId = session.payment.payment_id || txnId;
        }

        const validStatuses = ['success', 'completed', 'succeeded', 'paid', 'approved'];
        if (validStatuses.includes(String(paymentStatus).toLowerCase())) {
          return new Promise((resolve) => {
            confirmOrderInDb(order.id, txnId, (err, updatedOrder) => {
              resolve(updatedOrder || order);
            });
          });
        }
      }
    } catch (e) {
      console.debug('Zoho sync check skipped:', e.message);
    }
  }

  return order;
}

// Poll order status (student polling while waiting on QR modal)
app.get('/api/orders/status/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.get('SELECT * FROM orders WHERE id = ?', [id], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Order not found' });
    const syncedRow = await syncOrderIfPending(row);
    res.json({ status: syncedRow.status });
  });
});

// Get orders for logged-in student (returns all recent orders, ensuring pending and paid are visible)
app.get('/api/orders/me', authenticateToken, (req, res) => {
  db.all(
    'SELECT orders.*, users.name AS user_name FROM orders JOIN users ON orders.user_id = users.id WHERE user_id = ? ORDER BY created_at DESC',
    [req.user.id],
    async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const syncedRows = await Promise.all(rows.map(row => syncOrderIfPending(row)));
      res.json(syncedRows);
    }
  );
});

// Get all orders (Admin dashboard - displays pending, paid, ready, and delivered orders)
app.get('/api/orders', requireAdmin, (req, res) => {
  db.all(
    'SELECT orders.*, users.name AS user_name FROM orders JOIN users ON orders.user_id = users.id ORDER BY created_at DESC',
    [],
    async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const syncedRows = await Promise.all(rows.map(row => syncOrderIfPending(row)));
      res.json(syncedRows);
    }
  );
});

// Update order status (Admin -  e.g. Pending -> Ready for Pickup -> Delivered)
app.put('/api/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  db.get('SELECT user_id, items FROM orders WHERE id=?', [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    db.run('UPDATE orders SET status=? WHERE id=?', [status, id], function (updateErr, info) {
      if (updateErr) return res.status(500).json({ error: updateErr.message });

      io.emit('order_status_update', { id, status, userId: order.user_id });

      if (status === 'Ready for Pickup') {
        io.emit('food_ready', {
          orderId: id,
          userId: order.user_id,
          message: `Your food for Order #${id} is ready for collection at the counter!`
        });
      }

      res.json({ updated: info?.changes ?? 0 });
    });
  });
});

// Delete all delivered orders (Admin)
app.delete('/api/orders/delivered', requireAdmin, (req, res) => {
  db.run("DELETE FROM orders WHERE status='Delivered'", [], function (err, info) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: info?.changes ?? 0 });
  });
});

// Get specific order by ID (Admin -  for QR scanner)
app.get('/api/orders/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.get(
    'SELECT orders.*, users.name AS user_name FROM orders JOIN users ON orders.user_id = users.id WHERE orders.id=?',
    [id],
    async (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Order not found' });
      const syncedRow = await syncOrderIfPending(row);
      res.json(syncedRow);
    }
  );
});

// Sales statistics (Admin)
app.get('/api/items/stats', requireAdmin, (req, res) => {
  db.all('SELECT * FROM orders', [], (err, orders) => {
    if (err) return res.status(500).json({ error: err.message });

    const itemStats = {};
    orders.forEach(order => {
      // Skip orders that haven't been paid for successfully
      if (order.status === 'Pending Payment' || order.status === 'Failed') {
        return;
      }

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

// --- DAILY ORDERS CLEANUP ---
// Only prune delivered or failed orders so pending orders past midnight are not lost
function cleanupDailyOrders() {
  const sql = "DELETE FROM orders WHERE created_at < current_date AND status IN ('Delivered', 'Failed')";

  db.run(sql, [], function (err, info) {
    if (err) {
      console.error('Cleanup failed:', err.message);
    } else {
      const changes = info?.changes ?? 0;
      if (changes > 0) console.log(`Cleaned up ${changes} completed/failed old order(s).`);
    }
  });
}

cleanupDailyOrders();
const now = new Date();
const nextMidnight = new Date(now);
nextMidnight.setHours(24, 0, 0, 0);
setTimeout(() => {
  cleanupDailyOrders();
  setInterval(cleanupDailyOrders, 24 * 60 * 60 * 1000);
}, nextMidnight - now);

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SRI CUMIN SEEDS CATERING SERVICES running on http://localhost:${PORT}`);
});
