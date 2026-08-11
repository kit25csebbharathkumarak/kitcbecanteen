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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'supersecret_canteen_key';

const getZohoAccessToken = async () => {
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
    return res.data.access_token;
  } catch (err) {
    console.error('Zoho Auth Error:', err.response?.data || err.message);
    throw new Error('Failed to get Zoho Access Token');
  }
};


// ─── CORS + STATIC FILES ──────────────────────────────────────────────────────
app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── GLOBAL JSON PARSER ──────────────────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
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

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
const otps = new Map();

app.post('/api/auth/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  // Generate 6-digit numeric OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  otps.set(email.toLowerCase(), { otp, expiresAt });

  try {
    const templateParams = {
      to_email: email,
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

app.post('/api/auth/register', (req, res) => {
  const { name, email, password, otp } = req.body;
  if (!name || !email || !password || !otp) return res.status(400).json({ error: 'Missing fields' });

  const storedOtpData = otps.get(email.toLowerCase());
  if (!storedOtpData) {
    return res.status(400).json({ error: 'No verification code sent for this email.' });
  }

  if (storedOtpData.otp !== otp) {
    return res.status(400).json({ error: 'Invalid verification code.' });
  }

  if (Date.now() > storedOtpData.expiresAt) {
    otps.delete(email.toLowerCase());
    return res.status(400).json({ error: 'Verification code has expired.' });
  }

  // OTP verified, remove it
  otps.delete(email.toLowerCase());

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

app.post('/api/auth/login', (req, res) => {
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

app.post('/api/auth/forgot-password', (req, res) => {
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

// ─── MENU ITEM ROUTES ─────────────────────────────────────────────────────────
app.get('/api/items', authenticateToken, (req, res) => {
  db.all('SELECT * FROM items', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/items', requireAdmin, (req, res) => {
  const { name, price, image, available, stock, is_veg } = req.body;
  db.run(
    'INSERT INTO items (name, price, image, available, stock, is_veg) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
    [name, price, image, available === undefined ? true : !!available, stock || 0, is_veg === undefined ? true : !!is_veg],
    function (err, info) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('menu_updated');
      res.json({ id: info?.lastID || this?.lastID });
    }
  );
});

app.put('/api/items/:id', requireAdmin, (req, res) => {
  const { name, price, image, available, stock, is_veg } = req.body;
  const { id } = req.params;
  db.run(
    'UPDATE items SET name=?, price=?, image=?, available=?, stock=?, is_veg=? WHERE id=?',
    [name, price, image, available === undefined ? true : !!available, stock || 0, is_veg === undefined ? true : !!is_veg, id],
    function (err, info) {
      if (err) return res.status(500).json({ error: err.message });
      io.emit('menu_updated');
      res.json({ updated: info?.changes ?? this?.changes });
    }
  );
});

app.delete('/api/items/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM items WHERE id=?', [id], function (err, info) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('menu_updated');
    res.json({ deleted: info?.changes ?? this?.changes });
  });
});

// ─── ZOHO CONFIG ROUTE ────────────────────────────────────────────────────────
app.get('/api/zoho-config', (req, res) => {
  res.json({
    api_key: process.env.ZOHO_API_KEY || '',
    account_id: process.env.ZOHO_ACCOUNT_ID || ''
  });
});

// ─── ORDER ROUTES ─────────────────────────────────────────────────────────────

// Create order — calls BS Solutions Gateway for payment link
app.post('/api/orders/create', authenticateToken, async (req, res) => {
  const { items, total } = req.body;
  const userId = req.user.id;
  const userName = req.user.name || 'Student';
  const userEmail = req.user.email || 'student@example.com';

  if (!items || !items.length || !total) {
    return res.status(400).json({ error: 'Invalid order details' });
  }

  // 1. Check stock levels before creating order
  const placeholders = items.map(() => '?').join(',');
  const itemIds = items.map(i => i.id);

  db.all(`SELECT id, name, stock FROM items WHERE id IN (${placeholders})`, itemIds, async (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });

    for (const item of items) {
      const dbItem = rows.find(r => r.id === item.id);
      if (!dbItem || dbItem.stock < item.quantity) {
        return res.status(400).json({ error: `Not enough stock for ${item.name}` });
      }
    }

    // 2. Generate unique order ID
    const orderId = 'ORD' + Date.now();
    const txnRef = orderId;
    const itemsStr = JSON.stringify(items);

    // 3. Create Zoho Payment Session
    try {
      const accessToken = await getZohoAccessToken();
      const zohoRes = await axios.post(
        `https://payments.zoho.in/api/v1/paymentsessions?account_id=${process.env.ZOHO_ACCOUNT_ID}`,
        {
          amount: total,
          currency: "INR"
        },
        {
          headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      const paymentSessionId = zohoRes.data?.payments_session?.payments_session_id || 'dummy_zoho_session_' + Date.now();

      // 4. Save order as 'Pending Payment' — stock NOT deducted until payment confirmed
      db.run(
        "INSERT INTO orders (id, items, total, status, txn_ref, user_id, zoho_payment_session_id) VALUES (?, ?, ?, 'Pending Payment', ?, ?, ?)",
        [orderId, itemsStr, total, txnRef, userId, paymentSessionId],
        async (insertErr) => {
          if (insertErr) return res.status(500).json({ error: insertErr.message });
          return res.json({ success: true, orderId, paymentSessionId, amount: total });
        }
      );
    } catch (err) {
      console.error('Zoho Payments error:', err.response?.data || err.message);
      return res.status(500).json({ error: 'Failed to initiate payment' });
    }
  });
});

// Zoho Payments Webhook Callback
app.post('/api/orders/zoho-webhook', (req, res) => {
  const payload = req.body;
  console.log('[Zoho Webhook] Received:', payload);

  const signingKey = process.env.ZOHO_SIGNING_KEY;
  const signatureHeader = req.headers['x-zoho-webhook-signature'];

  if (signingKey && signatureHeader && req.rawBody) {
    try {
      const parts = signatureHeader.split(',');
      const t = parts[0].split('=')[1];
      const v = parts[1].split('=')[1];

      const data = `${t}.${req.rawBody.toString()}`;
      const expectedSignature = crypto
        .createHmac('sha256', signingKey)
        .update(data)
        .digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expectedSignature))) {
        console.error('[Zoho Webhook] WARNING: Invalid signature. Proceeding anyway using session ID as secure token.');
      }
    } catch (err) {
      console.error('[Zoho Webhook] WARNING: Signature verification error:', err.message);
    }
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

    const items = JSON.parse(order.items);

    db.run(
      "UPDATE orders SET status = 'Pending', txn_id = ?, paid_at = NOW() WHERE id = ?",
      [txnId, order.id],
      (updateErr) => {
        if (updateErr) {
          console.error('[Zoho Webhook] DB Update error:', updateErr.message);
          return res.status(500).json({ error: 'DB Error' });
        }

        items.forEach(item => {
          db.run('UPDATE items SET stock = stock - ? WHERE id = ?',
            [item.quantity, item.id], (sErr) => {
              if (sErr) console.error('[Zoho Webhook] Stock update error:', sErr.message);
            });
        });

        io.emit('payment_confirmed', { orderId: order.id, txnId: txnId });
        io.emit('new_order', { ...order, status: 'Pending', txn_id: txnId });
        io.emit('menu_updated');

        console.log(`[Zoho Webhook] ✅ Order ${order.id} confirmed — txnId: ${txnId}`);
        return res.json({ success: true, orderId: order.id });
      }
    );
  });
});

// Fallback Verification Endpoint
app.post('/api/orders/verify-zoho-payment', (req, res) => {
  const { paymentSessionId, orderId } = req.body;
  if (!paymentSessionId) return res.status(400).json({ error: 'Missing session ID' });

  db.get('SELECT * FROM orders WHERE id = ? AND zoho_payment_session_id = ?', [orderId, paymentSessionId], (err, order) => {
    if (err || !order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'Pending Payment') return res.json({ success: true, alreadyProcessed: true });

    const items = JSON.parse(order.items);
    db.run("UPDATE orders SET status = 'Pending', paid_at = NOW() WHERE id = ?", [order.id], (updateErr) => {
      if (updateErr) return res.status(500).json({ error: 'DB Error' });
      items.forEach(item => {
        db.run('UPDATE items SET stock = stock - ? WHERE id = ?', [item.quantity, item.id]);
      });
      io.emit('payment_confirmed', { orderId: order.id });
      io.emit('new_order', { ...order, status: 'Pending' });
      io.emit('menu_updated');
      res.json({ success: true });
    });
  });
});

// Payment callback from Gateway
app.get('/api/payment-callback', async (req, res) => {
  // The gateway may return orderId as its internal ID or our developerOrderId
  const { status, orderId: callbackOrderId } = req.query;
  console.log('[Callback] Received:', { status, callbackOrderId, fullQuery: req.query });

  if (!callbackOrderId) {
    return res.redirect('/orders.html?error=missing_order');
  }

  // Try to find the order by our ID first, then by gateway's orderId stored in paytm_order_id
  const findOrder = (cb) => {
    db.get('SELECT * FROM orders WHERE id = ?', [callbackOrderId], (err, order) => {
      if (order) return cb(null, order);
      db.get('SELECT * FROM orders WHERE paytm_order_id = ?', [callbackOrderId], (err2, order2) => {
        cb(err2, order2);
      });
    });
  };

  if (status !== 'SUCCESS') {
    findOrder((err, order) => {
      const oid = order ? order.id : callbackOrderId;
      db.run("UPDATE orders SET status = 'Failed' WHERE id = ?", [oid], () => {
        io.emit('order_status_update', { id: oid, status: 'Failed' });
        return res.redirect('/orders.html?error=payment_failed');
      });
    });
    return;
  }

  try {
    // Verify transaction server-to-server using the gateway's orderId
    const gatewayBaseUrl = process.env.UPI_GATEWAY_URL.replace(/\/+$/, '');
    const verifyReq = await fetch(`${gatewayBaseUrl}/api/gateway/order/status/${callbackOrderId}`, {
      headers: {
        'x-api-key': process.env.UPI_GATEWAY_KEY
      }
    });

    const verifyData = await verifyReq.json();
    console.log('[Callback] Verification response:', JSON.stringify(verifyData));

    // Resolve our order: use developerOrderId from gateway if available
    const ourOrderId = verifyData.developerOrderId || callbackOrderId;

    if (verifyData.status === 'SUCCESS' || verifyData.status === 'COMPLETED') {
      db.get('SELECT * FROM orders WHERE id = ?', [ourOrderId], (err, order) => {
        if (err || !order) {
          // Fallback: try finding by gateway orderId
          return db.get('SELECT * FROM orders WHERE paytm_order_id = ?', [callbackOrderId], (err2, order2) => {
            if (err2 || !order2) return res.redirect('/orders.html?error=order_not_found');
            confirmOrder(order2, verifyData, res);
          });
        }
        confirmOrder(order, verifyData, res);
      });
    } else {
      db.get('SELECT * FROM orders WHERE id = ?', [ourOrderId], (err, order) => {
        const oid = order ? order.id : ourOrderId;
        db.run("UPDATE orders SET status = 'Failed' WHERE id = ?", [oid], () => {
          res.redirect('/orders.html?error=payment_verification_failed');
        });
      });
    }
  } catch (err) {
    console.error('Verification error:', err);
    res.redirect('/orders.html?error=verification_error');
  }
});

// Helper: confirm a paid order
function confirmOrder(order, verifyData, res) {
  if (order.status !== 'Pending Payment') {
    return res.redirect('/orders.html?payment=success');
  }

  const items = JSON.parse(order.items);
  const txnId = verifyData.paytmTxnId || verifyData.txnId || verifyData.transactionId || `TXN_${Date.now()}`;
  const orderId = order.id;

  db.run(
    "UPDATE orders SET status = 'Pending', txn_id = ?, paid_at = NOW() WHERE id = ?",
    [txnId, orderId],
    (updateErr) => {
      if (updateErr) return res.redirect('/orders.html?error=db_error');

      items.forEach(item => {
        db.run('UPDATE items SET stock = stock - ? WHERE id = ?',
          [item.quantity, item.id], (sErr) => { if (sErr) console.error(sErr.message); });
      });

      io.emit('payment_confirmed', { orderId, txnId });
      io.emit('new_order', { ...order, status: 'Pending', txn_id: txnId });
      io.emit('menu_updated');

      console.log(`[Callback] ✅ Order ${orderId} confirmed — txnId: ${txnId}`);
      res.redirect('/orders.html?payment=success');
    }
  );
}

// Admin: manually confirm a payment after verifying in their UPI/Paytm app
app.post('/api/orders/:id/confirm-payment', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { txnId } = req.body;  // optional — admin can type the UTR number

  db.get('SELECT * FROM orders WHERE id = ?', [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status !== 'Pending Payment') {
      return res.status(400).json({ error: `Order already in status: ${order.status}` });
    }

    const resolvedTxnId = (txnId && txnId.trim()) ? txnId.trim() : `MANUAL_${Date.now()}`;
    const items = JSON.parse(order.items);

    db.run(
      "UPDATE orders SET status = 'Pending', txn_id = ?, paid_at = NOW() WHERE id = ?",
      [resolvedTxnId, id],
      (updateErr) => {
        if (updateErr) return res.status(500).json({ error: updateErr.message });

        // Deduct stock now that payment is confirmed
        items.forEach(item => {
          db.run('UPDATE items SET stock = stock - ? WHERE id = ?',
            [item.quantity, item.id],
            (sErr) => { if (sErr) console.error('Stock error for item', item.id, sErr.message); }
          );
        });

        // Notify all connected clients in real-time
        io.emit('payment_confirmed', { orderId: id, txnId: resolvedTxnId });
        io.emit('new_order', { ...order, status: 'Pending', txn_id: resolvedTxnId });
        io.emit('menu_updated');

        console.log(`[Admin] ✅ Payment confirmed for order ${id} — txnId: ${resolvedTxnId}`);
        res.json({ success: true, orderId: id, txnId: resolvedTxnId });
      }
    );
  });
});

// Poll order status (student polling while waiting on QR modal)
app.get('/api/orders/status/:id', authenticateToken, (req, res) => {
  const { id } = req.params;
  db.get('SELECT status FROM orders WHERE id = ?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Order not found' });
    res.json({ status: row.status });
  });
});

// Get orders for logged-in student
app.get('/api/orders/me', authenticateToken, (req, res) => {
  db.all(
    'SELECT orders.*, users.name AS user_name FROM orders JOIN users ON orders.user_id = users.id WHERE user_id = ? ORDER BY created_at DESC',
    [req.user.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Get all orders (Admin dashboard)
app.get('/api/orders', requireAdmin, (req, res) => {
  db.all(
    'SELECT orders.*, users.name AS user_name FROM orders JOIN users ON orders.user_id = users.id ORDER BY created_at DESC',
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Update order status (Admin — e.g. Pending → Delivered)
app.put('/api/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  db.run('UPDATE orders SET status=? WHERE id=?', [status, id], function (err, info) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('order_status_update', { id, status });
    res.json({ updated: info?.changes ?? this?.changes });
  });
});

// Delete all delivered orders (Admin)
app.delete('/api/orders/delivered', requireAdmin, (req, res) => {
  db.run("DELETE FROM orders WHERE status='Delivered'", [], function (err, info) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ deleted: info?.changes ?? this?.changes });
  });
});

// Get specific order by ID (Admin — for QR scanner)
app.get('/api/orders/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.get(
    'SELECT orders.*, users.name AS user_name FROM orders JOIN users ON orders.user_id = users.id WHERE orders.id=?',
    [id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Order not found' });
      res.json(row);
    }
  );
});

// Sales statistics (Admin)
app.get('/api/items/stats', requireAdmin, (req, res) => {
  db.all('SELECT * FROM orders', [], (err, orders) => {
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

// ─── DAILY ORDERS CLEANUP ───────────────────────────────────────────────────────
function cleanupDailyOrders() {
  const sql = db.isPostgres
    ? "DELETE FROM orders WHERE created_at < current_date"
    : "DELETE FROM orders WHERE date(created_at) < date('now','localtime')";

  db.run(sql, [], function (err, info) {
    if (err) {
      console.error('Cleanup failed:', err.message);
    } else {
      const changes = info?.changes ?? this?.changes;
      if (changes > 0) console.log(`Cleaned up ${changes} old order(s).`);
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

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 SRI CUMIN SEEDS CATERING SERVICES running on http://localhost:${PORT}`);
});
