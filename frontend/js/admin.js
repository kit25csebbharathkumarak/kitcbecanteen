const API_URL = `${window.location.origin}/api`;
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user || user.role !== 'admin') {
  window.location.href = 'login.html';
}

// Connect to socket
const socket = io();

// DOM
const ordersBoard = document.getElementById('orders-board');
const adminMenuList = document.getElementById('admin-menu-list');
let orders = [];

// Initialize QR Scanner
const html5QrcodeScanner = new Html5QrcodeScanner(
  "reader",
  { fps: 10, qrbox: {width: 250, height: 250} },
  /* verbose= */ false
);

html5QrcodeScanner.render(onScanSuccess, onScanFailure);

function onScanSuccess(decodedText, decodedResult) {
  fetchOrderAndFulfill(decodedText);
}

function onScanFailure(error) {
  // handle scan failure quietly
}

async function fetchOrderAndFulfill(orderId) {
  try {
    const res = await fetch(`${API_URL}/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      alert('Order not found!');
      return;
    }
    const order = await res.json();
    if (order.status === 'Delivered') {
      alert(`Order ${orderId} is already delivered.`);
      return;
    }
    
    // Update status
    await updateOrderStatus(orderId, 'Delivered');
    alert(`Order ${orderId} verified and marked as Delivered!`);
  } catch (err) {
    console.error(err);
  }
}

async function updateOrderStatus(id, status) {
  try {
    await fetch(`${API_URL}/orders/${id}/status`, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ status })
    });
  } catch(err) {
    console.error(err);
  }
}
window.updateOrderStatus = updateOrderStatus;

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
  orders.forEach(order => {
    const items = JSON.parse(order.items);
    const itemsStr = items.map(i => `${i.quantity}x ${i.name}`).join(', ');
    
    const div = document.createElement('div');
    div.className = `order-card glass-panel ${order.status.toLowerCase()}`;
    div.innerHTML = `
      <div class="order-details">
        <h4>${order.id}</h4>
        <div class="order-items">${itemsStr}</div>
        <div style="font-weight: 600; margin-top: 0.5rem">₹${order.total}</div>
      </div>
      <div>
        <span class="badge ${order.status.toLowerCase()}">${order.status}</span>
        ${order.status === 'Pending' ? 
          `<button class="btn btn-secondary" style="margin-top: 0.5rem; display: block; font-size: 0.8rem; padding: 0.3rem 0.6rem" onclick="updateOrderStatus('${order.id}', 'Delivered')">Mark Delivered</button>` : ''}
      </div>
    `;
    ordersBoard.appendChild(div);
  });
}

// Socket Events
socket.on('new_order', (order) => {
  if (!orders.find(o => o.id === order.id)) {
    orders.unshift(order);
    renderOrders();
  }
});

socket.on('order_status_update', (data) => {
  const o = orders.find(x => x.id === data.id);
  if (o) {
    o.status = data.status;
    renderOrders();
  }
});

// Admin Menu Management
async function fetchAdminMenu() {
  try {
    const res = await fetch(`${API_URL}/items`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const items = await res.json();
    renderAdminMenu(items);
  } catch (err) {
    console.error(err);
  }
}

function renderAdminMenu(items) {
  adminMenuList.innerHTML = '';
  items.forEach(item => {
    const div = document.createElement('div');
    div.style.marginBottom = '1rem';
    div.style.paddingBottom = '1rem';
    div.style.borderBottom = '1px solid rgba(0,0,0,0.05)';
    div.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
        <strong>${item.name}</strong>
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn btn-secondary" style="padding: 0.2rem 0.5rem; font-size: 0.8rem;" onclick="editItem(${item.id})">Edit</button>
          <button class="btn btn-danger" style="padding: 0.2rem 0.5rem; font-size: 0.8rem;" onclick="deleteItem(${item.id}, '${item.name}')">Delete</button>
        </div>
      </div>
      <div style="font-size: 0.9rem; color: var(--text-muted);">
        Price: ₹${item.price} | Status: ${item.available ? 'Available' : 'Out of Stock'}
      </div>
    `;
    adminMenuList.appendChild(div);
  });
}

window.updateItem = async function(id) {
  const price = document.getElementById(`price-${id}`).value;
  const avail = document.getElementById(`avail-${id}`).value;
  
  const res = await fetch(`${API_URL}/items`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const items = await res.json();
  const original = items.find(i => i.id === id);

  try {
    await fetch(`${API_URL}/items/${id}`, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        name: original.name,
        image: original.image,
        price: parseFloat(price),
        available: parseInt(avail) === 1
      })
    });
    alert('Menu item updated!');
  } catch (err) {
    console.error(err);
  }
};

// New functions for enhanced admin functionality
window.editItem = function(id) {
  window.location.href = `edit-menu.html?id=${id}`;
};

window.deleteItem = async function(id, name) {
  if (!confirm(`Are you sure you want to delete "${name}"?`)) return;

  try {
    const res = await fetch(`${API_URL}/items/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      alert('Item deleted successfully!');
      fetchAdminMenu();
      fetchItemStats();
    } else {
      alert('Error deleting item');
    }
  } catch (err) {
    console.error(err);
    alert('Error deleting item');
  }
};

async function fetchItemStats() {
  try {
    const res = await fetch(`${API_URL}/items/stats`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const stats = await res.json();
    renderItemStats(stats);
  } catch (err) {
    console.error(err);
  }
}

function renderItemStats(stats) {
  const statsDiv = document.getElementById('item-stats');
  statsDiv.innerHTML = '';

  const statsArray = Object.entries(stats);
  if (statsArray.length === 0) {
    statsDiv.innerHTML = '<p style="color: var(--text-muted); font-style: italic;">No sales data available yet.</p>';
    return;
  }

  statsArray.sort((a, b) => b[1].totalQuantity - a[1].totalQuantity);

  statsArray.forEach(([itemId, stat]) => {
    const div = document.createElement('div');
    div.style.marginBottom = '1rem';
    div.style.paddingBottom = '0.5rem';
    div.style.borderBottom = '1px solid rgba(0,0,0,0.05)';
    div.innerHTML = `
      <div style="font-weight: 600;">${stat.name}</div>
      <div style="font-size: 0.9rem; color: var(--text-muted);">
        Quantity Sold: ${stat.totalQuantity} | Revenue: ₹${stat.totalRevenue.toFixed(2)}
      </div>
    `;
    statsDiv.appendChild(div);
  });
}

// Add item form submission
document.getElementById('add-item-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const name = document.getElementById('new-item-name').value;
  const price = parseFloat(document.getElementById('new-item-price').value);
  const image = document.getElementById('new-item-image').value;
  const available = document.getElementById('new-item-avail').value === '1';

  try {
    const res = await fetch(`${API_URL}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name, price, image, available })
    });

    if (res.ok) {
      alert('Item added successfully!');
      document.getElementById('add-item-form').reset();
      fetchAdminMenu();
      fetchItemStats();
    } else {
      alert('Error adding item');
    }
  } catch (err) {
    console.error(err);
    alert('Error adding item');
  }
});

// Add Logout logic to Admin
const nav = document.querySelector('nav');
if (nav) {
  const logoutBtn = document.createElement('a');
  logoutBtn.href = '#';
  logoutBtn.innerText = `Logout (Admin)`;
  logoutBtn.onclick = (e) => {
    e.preventDefault();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = 'login.html';
  };
  nav.appendChild(logoutBtn);
}

// Init
fetchOrders();
fetchAdminMenu();
fetchItemStats();
