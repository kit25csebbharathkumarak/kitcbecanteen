const API_URL = `${window.location.origin}/api`;
const token   = localStorage.getItem('token');
const user    = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user) {
  window.location.href = 'login.html';
}

const socket = io({
  auth: { token }
});
let orders   = [];

// ─── URL Params for Payment Callback ─────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('payment') === 'success') {
  alert('Payment successful! Your order has been placed.');
  window.history.replaceState({}, document.title, window.location.pathname);
}
if (urlParams.get('error')) {
  alert('Payment Error: ' + urlParams.get('error').replace(/_/g, ' '));
  window.history.replaceState({}, document.title, window.location.pathname);
}

// ─── DOM Elements ──────────────────────────────────────────────────────────────
const userOrdersBoard = document.getElementById('user-orders-board');
const qrModal         = document.getElementById('qr-modal');
const closeModalBtn   = document.getElementById('close-modal');
const qrcodeContainer = document.getElementById('qrcode');
const orderIdDisplay  = document.getElementById('order-id-display');

let qrCodeInstance = null;

window.showPickupQR = function(orderId) {
  qrcodeContainer.innerHTML = ''; 
  if (!qrCodeInstance) {
    qrCodeInstance = new QRCode(qrcodeContainer, {
      text: orderId,
      width: 200,
      height: 200,
      colorDark : "#000000",
      colorLight : "#ffffff",
      correctLevel : QRCode.CorrectLevel.H
    });
  } else {
    qrCodeInstance.clear();
    qrCodeInstance.makeCode(orderId);
  }
  orderIdDisplay.innerText = orderId;
  qrModal.classList.add('active');
};

// ─── Fetch & Render My Orders ──────────────────────────────────────────────────
async function fetchMyOrders() {
  try {
    const res = await fetch(`${API_URL}/orders/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to fetch orders');
    orders = await res.json();
    renderOrders();
  } catch (err) {
    console.error(err);
    userOrdersBoard.innerHTML = '<p style="color:red">Failed to load orders. Please refresh.</p>';
  }
}

function renderOrders() {
  userOrdersBoard.innerHTML = '';

  if (orders.length === 0) {
    userOrdersBoard.innerHTML = `
      <div style="text-align:center;padding:3rem;color:var(--text-muted);">
        <img src="logo.png" alt="Logo" style="height:80px; margin-bottom:1.5rem; filter: grayscale(0.2); opacity: 0.8; display:block; margin-left:auto; margin-right:auto;">
        You have no orders yet.
      </div>`;
    return;
  }

  orders.forEach(order => {
    const items    = JSON.parse(order.items);
    const statusLc = (order.status || '').toLowerCase().replace(/\s+/g, '-');

    const div = document.createElement('div');
    div.className = `order-card glass-panel ${statusLc}`;
    div.style.cssText = 'flex-direction:column;align-items:flex-start;gap:1rem;';

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;justify-content:space-between;width:100%;flex-wrap:wrap;gap:0.5rem;';

    // UPI Transaction ID (if available)
    const txnLine = order.txn_id
      ? `<div style="margin-top:0.6rem;font-size:0.8rem;color:var(--text-muted);font-family:monospace;border:1px dashed var(--text-main);padding:0.2rem 0.5rem;background:var(--bg-color);border-radius:var(--border-radius);display:inline-block;">
           <i class="fa-solid fa-receipt"></i> UPI Txn ID: ${order.txn_id}
         </div>`
      : '';

    headerRow.innerHTML = `
      <div class="order-details">
        <h4 style="margin-bottom:0.2rem;font-family:monospace;">${order.id}</h4>
        <div style="font-weight:600;font-size:0.9rem;color:var(--primary-color);margin-bottom:0.8rem;">${order.user_name}</div>
        <div class="order-items" style="display:flex;flex-direction:column;gap:0.3rem;">
          ${items.map(i => `<div><strong>${i.quantity}×</strong> ${i.name}</div>`).join('')}
        </div>
        <div style="font-weight:700;margin-top:1rem;font-size:1.1rem;">₹${order.total}</div>
        ${txnLine}
      </div>
      <div>
        <span class="badge ${statusLc}">${order.status}</span>
      </div>
    `;

    div.appendChild(headerRow);

    // Hint for orders still awaiting payment
    if (order.status === 'Pending Payment') {
      const note = document.createElement('div');
      note.style.cssText = 'color:var(--text-muted);font-size:0.9rem;margin-top:0.5rem;';
      note.innerHTML = `<i class="fa-solid fa-clock"></i> Waiting for payment confirmation.`;
      div.appendChild(note);
    } else if (order.status === 'PAID' || order.status === 'Pending') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.cssText = 'margin-top:0.5rem; background: var(--primary-color); border: none; padding: 0.5rem 1rem; border-radius: 4px; color: #fff; cursor: pointer; font-weight: bold;';
      btn.innerHTML = '<i class="fa-solid fa-qrcode"></i> View QR Code to Collect Food';
      btn.onclick = () => showPickupQR(order.id);
      div.appendChild(btn);
    }

    userOrdersBoard.appendChild(div);
  });
}

// ─── Close Modal ──────────────────────────────────────────────────────────────
if (closeModalBtn) {
  closeModalBtn.onclick = () => qrModal.classList.remove('active');
}

// ─── Nav Logout ───────────────────────────────────────────────────────────────
const nav = document.querySelector('nav');
if (nav) {
  const logoutBtn   = document.createElement('a');
  logoutBtn.href    = '#';
  logoutBtn.innerText = `Logout (${user ? user.name : ''})`;
  logoutBtn.onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
  };
  nav.appendChild(logoutBtn);
}

// ─── Socket Updates ───────────────────────────────────────────────────────────
socket.on('order_status_update', (data) => {
  const o = orders.find(x => x.id === data.id);
  if (o) {
    o.status = data.status;
    renderOrders();
  }
});

socket.on('payment_confirmed', (data) => {
  const o = orders.find(x => x.id === data.orderId);
  if (o) {
    o.status = 'PAID';
    if (data.txnId) o.txn_id = data.txnId;
    renderOrders();
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
fetchMyOrders();
