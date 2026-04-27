const API_URL = `${window.location.origin}/api`;
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user) {
  window.location.href = 'login.html';
}

const socket = io();

let orders = [];

// DOM Elements
const userOrdersBoard = document.getElementById('user-orders-board');
const qrModal = document.getElementById('qr-modal');
const closeModalBtn = document.getElementById('close-modal');
const qrcodeContainer = document.getElementById('qrcode');
const orderIdDisplay = document.getElementById('order-id-display');

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
    userOrdersBoard.innerHTML = '<p style="color:red">Failed to load orders.</p>';
  }
}

function renderOrders() {
  userOrdersBoard.innerHTML = '';
  
  if (orders.length === 0) {
    userOrdersBoard.innerHTML = '<p>You have no orders yet.</p>';
    return;
  }

  orders.forEach(order => {
    const items = JSON.parse(order.items);
    const itemsStr = items.map(i => `${i.quantity}x ${i.name}`).join(', ');
    
    const div = document.createElement('div');
    div.className = `order-card glass-panel ${order.status.toLowerCase()}`;
    div.style.flexDirection = 'column';
    div.style.alignItems = 'flex-start';
    div.style.gap = '1rem';
    
    const headerRow = document.createElement('div');
    headerRow.style.display = 'flex';
    headerRow.style.justifyContent = 'space-between';
    headerRow.style.width = '100%';
    
    headerRow.innerHTML = `
      <div class="order-details">
        <h4>${order.id}</h4>
        <div class="order-items">${itemsStr}</div>
        <div style="font-weight: 600; margin-top: 0.5rem">₹${order.total}</div>
      </div>
      <div>
        <span class="badge ${order.status.toLowerCase()}">${order.status}</span>
      </div>
    `;
    
    div.appendChild(headerRow);
    
    if (order.status === 'Pending') {
      const qrBtn = document.createElement('button');
      qrBtn.className = 'btn btn-primary';
      qrBtn.style.width = '100%';
      qrBtn.innerText = 'View QR Code';
      qrBtn.onclick = () => showQRModal(order.id);
      div.appendChild(qrBtn);
    }

    userOrdersBoard.appendChild(div);
  });
}

function showQRModal(orderId) {
  qrcodeContainer.innerHTML = '';
  new QRCode(qrcodeContainer, {
    text: orderId,
    width: 200,
    height: 200,
    colorDark : "#e53935",
    colorLight : "#ffffff",
    correctLevel : QRCode.CorrectLevel.H
  });
  orderIdDisplay.innerText = orderId;
  qrModal.classList.add('active');
}

closeModalBtn.onclick = () => {
  qrModal.classList.remove('active');
};

// Add Logout logic to Nav
const nav = document.querySelector('nav');
if (nav) {
  // Add Admin link ONLY if the user is an admin
  if (user && user.role === 'admin') {
    const adminBtn = document.createElement('a');
    adminBtn.href = 'admin.html';
    adminBtn.innerText = 'Admin Portal';
    nav.appendChild(adminBtn);
  }

  const logoutBtn = document.createElement('a');
  logoutBtn.href = '#';
  logoutBtn.innerText = `Logout (${user ? user.name : ''})`;
  logoutBtn.onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
  };
  nav.appendChild(logoutBtn);
}

// Socket updates
socket.on('order_status_update', (data) => {
  const o = orders.find(x => x.id === data.id);
  if (o) {
    o.status = data.status;
    renderOrders();
    // If the modal is open for this order, we can close it
    if (qrModal.classList.contains('active') && orderIdDisplay.innerText === data.id && data.status === 'Delivered') {
      qrModal.classList.remove('active');
      // Adding a small delay so user isn't too shocked
      setTimeout(() => alert('Order marked as Delivered!'), 100);
    }
  }
});

fetchMyOrders();
