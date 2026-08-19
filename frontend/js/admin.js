const API_URL = `${window.location.origin}/api`;
const token   = localStorage.getItem('token');
const user    = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user || user.role !== 'admin') {
  window.location.href = 'login.html';
}

const socket = io();

// ─── DOM ───────────────────────────────────────────────────────────────────────
const ordersBoard              = document.getElementById('orders-board');
const recentlyScannedContainer = document.getElementById('recently-scanned-container');
const scannedOrderDetails      = document.getElementById('scanned-order-details');
const orderSearchInput         = document.getElementById('order-search');

let orders          = [];
let lastScannedId   = null;
let searchQuery     = '';

// ─── QR Scanner ───────────────────────────────────────────────────────────────
const html5QrcodeScanner = new Html5QrcodeScanner(
  'reader',
  { fps: 10, qrbox: { width: 250, height: 250 } },
  false
);
html5QrcodeScanner.render(onScanSuccess, () => {});

function onScanSuccess(decodedText) {
  fetchOrderAndFulfill(decodedText);
}

async function fetchOrderAndFulfill(orderId) {
  try {
    const res = await fetch(`${API_URL}/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) { 
      scannedOrderDetails.innerHTML = `<div style="color: #c0392b; font-weight: bold; font-size: 1.1rem; padding: 1rem; background: #fadbd8; border-radius: var(--border-radius);"><i class="fa-solid fa-triangle-exclamation"></i> Order not found: ${orderId}</div>`;
      recentlyScannedContainer.style.display = 'flex';
      
      if (window.scanDismissTimeout) clearTimeout(window.scanDismissTimeout);
      window.scanDismissTimeout = setTimeout(() => {
        recentlyScannedContainer.style.display = 'none';
      }, 5000);
      return; 
    }

    const order = await res.json();

    if (order.status === 'Delivered') {
      // Do not scan again and do not show popup if already delivered
      return;
    }

    lastScannedId = order.id;
    renderScannedOrderDetails(order);
    
    // Add success message
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = 'color: #27ae60; font-weight: bold; margin-bottom: 1rem; background: #d5f5e3; padding: 0.5rem 1rem; border-radius: var(--border-radius); border-left: 4px solid #27ae60;';
    msgDiv.innerHTML = `<i class="fa-solid fa-check-circle"></i> Successfully marked Order ${orderId} as Delivered.`;
    scannedOrderDetails.prepend(msgDiv);

    await updateOrderStatus(orderId, 'Delivered');

    setTimeout(() => {
      const card = document.getElementById(`order-card-${orderId}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 500);
  } catch (err) {
    console.error(err);
  }
}

function renderScannedOrderDetails(order) {
  const items    = JSON.parse(order.items);
  const itemsStr = items.map(i =>
    `<li style="margin-bottom:0.8rem;font-size:2rem;line-height:1.2;"><strong>${i.quantity}×</strong> ${i.name}</li>`
  ).join('');

  const txnLine = order.txn_id
    ? `<div style="margin-bottom:0.8rem;font-size:0.85rem;color:var(--text-muted);font-family:monospace;border:1px dashed var(--text-main);padding:0.3rem 0.5rem;background:#fff;border-radius:var(--border-radius);display:inline-block;">
         <i class="fa-solid fa-receipt"></i> UPI Txn ID: ${order.txn_id}
       </div>`
    : '';

  scannedOrderDetails.innerHTML = `
    <div style="display:flex;gap:1.5rem;align-items:flex-start;flex-wrap:wrap;">
      <div style="flex:1;min-width:200px;">
        <div style="font-family:monospace;font-size:0.8rem;margin-bottom:0.2rem;color:var(--text-muted);">Order ID: ${order.id}</div>
        <div style="font-weight:600;font-size:0.9rem;color:var(--text-muted);margin-bottom:1rem;">Ordered by: ${order.user_name}</div>
        ${txnLine}
        <ul style="list-style:none;padding:0;color:var(--text-main);">${itemsStr}</ul>
      </div>
      <div style="text-align:right;">
        <div style="font-size:1.4rem;font-weight:700;color:var(--primary-color);">₹${order.total}</div>
        <div style="margin-top:0.5rem;"><span class="badge ${(order.status||'').toLowerCase().replace(/\s+/g,'-')}">${order.status}</span></div>
      </div>
    </div>
  `;
  recentlyScannedContainer.style.display = 'flex';
  
  // Auto dismiss after 5 seconds
  if (window.scanDismissTimeout) clearTimeout(window.scanDismissTimeout);
  window.scanDismissTimeout = setTimeout(() => {
    recentlyScannedContainer.style.display = 'none';
  }, 5000);

  renderOrders();
}

// ─── Order Status Update ───────────────────────────────────────────────────────
async function updateOrderStatus(id, status) {
  try {
    await fetch(`${API_URL}/orders/${id}/status`, {
      method:  'PUT',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ status })
    });
  } catch (err) {
    console.error('Status update failed:', err);
  }
}
window.updateOrderStatus = updateOrderStatus;

// ─── Confirm Payment (Admin manual verification) ───────────────────────────────
async function confirmPayment(orderId) {
  const txnId = prompt(
    `Enter UPI Transaction / UTR number for order ${orderId} (optional — leave blank to auto-generate):`,
    ''
  );
  if (txnId === null) return; // user pressed Cancel

  try {
    const res = await fetch(`${API_URL}/orders/${orderId}/confirm-payment`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ txnId: txnId.trim() })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Failed to confirm payment.');
      return;
    }

    // UI will update via socket event; just refresh list as backup
    fetchOrders();
  } catch (err) {
    console.error('Confirm payment error:', err);
    alert('Network error. Please try again.');
  }
}
window.confirmPayment = confirmPayment;

// ─── Fetch & Render All Orders ────────────────────────────────────────────────
async function fetchOrders() {
  try {
    const res = await fetch(`${API_URL}/orders`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    orders = await res.json();
    renderOrders();
  } catch (err) {
    console.error(err);
  }
}

function renderOrders() {
  ordersBoard.innerHTML = '';

  const filtered = orders.filter(o =>
    o.id.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (filtered.length === 0) {
    ordersBoard.innerHTML = `<div style="text-align:center;padding:3rem;color:var(--text-muted);">No orders found matching "${searchQuery}"</div>`;
    return;
  }

  filtered.forEach(order => {
    const items    = JSON.parse(order.items);
    const statusLc = (order.status || '').toLowerCase().replace(/\s+/g, '-');
    const isHighlight = lastScannedId === order.id;

    const txnLine = order.txn_id
      ? `<div style="margin-top:0.6rem;font-size:0.8rem;color:var(--text-muted);font-family:monospace;border:1px dashed var(--text-main);padding:0.2rem 0.4rem;background:var(--bg-color);border-radius:var(--border-radius);display:inline-block;">
           <i class="fa-solid fa-receipt"></i> UPI Txn: ${order.txn_id}
         </div>`
      : '';

    // Action buttons per status
    let actionBtns = '';
    if (order.status === 'Pending Payment') {
      actionBtns = `
        <button class="btn btn-primary"
          style="margin-top:0.6rem;display:block;font-size:0.8rem;padding:0.4rem 0.8rem;background:#2ecc71;border-color:#2ecc71;"
          onclick="confirmPayment('${order.id}')">
          <i class="fa-solid fa-check"></i> Confirm Payment
        </button>`;
    } else if (order.status === 'Pending') {
      actionBtns = `
        <button class="btn btn-secondary"
          style="margin-top:0.5rem;display:block;font-size:0.8rem;padding:0.3rem 0.6rem;"
          onclick="updateOrderStatus('${order.id}', 'Delivered')">
          Mark Delivered
        </button>`;
    }

    const div = document.createElement('div');
    div.id        = `order-card-${order.id}`;
    div.className = `order-card glass-panel ${statusLc} ${isHighlight ? 'highlight' : ''}`;
    div.innerHTML = `
      <div class="order-details">
        <h4 style="margin-bottom:0.2rem;">${order.id}</h4>
        <div style="font-weight:600;font-size:0.9rem;color:var(--primary-color);margin-bottom:0.5rem;">${order.user_name}</div>
        <div class="order-items" style="display:flex;flex-direction:column;gap:0.2rem;">
          ${items.map(i => `<div>• ${i.quantity}× ${i.name}</div>`).join('')}
        </div>
        <div style="font-weight:700;margin-top:0.8rem;font-size:1.1rem;">₹${order.total}</div>
        ${txnLine}
      </div>
      <div style="text-align:right;">
        <span class="badge ${statusLc}">${order.status}</span>
        ${actionBtns}
      </div>
    `;
    ordersBoard.appendChild(div);
  });
}

// ─── Socket Events ────────────────────────────────────────────────────────────
socket.on('new_order', (order) => {
  if (!orders.find(o => o.id === order.id)) {
    orders.unshift(order);
    renderOrders();
  }
});

socket.on('order_status_update', (data) => {
  const o = orders.find(x => x.id === data.id);
  if (o) { o.status = data.status; renderOrders(); }
});

socket.on('payment_confirmed', (data) => {
  const o = orders.find(x => x.id === data.orderId);
  if (o) {
    o.status = 'Pending';
    if (data.txnId) o.txn_id = data.txnId;
    renderOrders();
  }
});

socket.on('menu_updated', () => { /* menu change doesn't affect admin orders view */ });

// ─── Clear Delivered Orders ───────────────────────────────────────────────────
async function clearDeliveredOrders() {
  if (!confirm('Delete all delivered orders? This cannot be undone.')) return;
  try {
    const res = await fetch(`${API_URL}/orders/delivered`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) { alert('Failed to clear delivered orders.'); return; }
    alert('Delivered orders cleared successfully.');
    fetchOrders();
  } catch (err) {
    console.error(err);
    alert('Error clearing delivered orders.');
  }
}

// ─── Logout ───────────────────────────────────────────────────────────────────
const nav = document.getElementById('admin-nav');
if (nav) {
  const logoutBtn   = document.createElement('a');
  logoutBtn.href    = '#';
  logoutBtn.innerText = 'Logout';
  logoutBtn.style.cssText = 'color:var(--primary-color);font-weight:700;';
  logoutBtn.onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
  };
  nav.appendChild(logoutBtn);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
fetchOrders();

document.getElementById('clear-delivered-btn').addEventListener('click', clearDeliveredOrders);

orderSearchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderOrders();
});
