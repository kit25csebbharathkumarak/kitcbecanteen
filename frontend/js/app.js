const API_URL = `${window.location.origin}/api`;

const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');

if (!token || !user) {
  window.location.href = 'login.html';
}

let cart = {};
let menuItems = [];
let searchQuery = '';

const socket = io();

// DOM Elements
const menuGrid = document.getElementById('menu-grid');
const cartItemsContainer = document.getElementById('cart-items');
const cartTotalElement = document.getElementById('cart-total');
const checkoutBtn = document.getElementById('checkout-btn');
const qrModal = document.getElementById('qr-modal');
const closeModalBtn = document.getElementById('close-modal');
const qrcodeContainer = document.getElementById('qrcode');
const orderIdDisplay = document.getElementById('order-id-display');
const menuSearchInput = document.getElementById('menu-search');

async function fetchMenu() {
  try {
    const res = await fetch(`${API_URL}/items`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    menuItems = await res.json();
    renderMenu();
  } catch (err) {
    console.error("Failed to fetch menu", err);
  }
}

function renderMenu() {
  menuGrid.innerHTML = '';
  const filteredItems = menuItems.filter(item => 
    item.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (filteredItems.length === 0) {
    menuGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 3rem; color: var(--text-muted);">No items found matching "${searchQuery}"</div>`;
    return;
  }

  filteredItems.forEach(item => {
    if (!item.available) return;
    
    const div = document.createElement('div');
    div.className = 'menu-item glass-panel';
    div.innerHTML = `
      <div class="item-img-wrap">
        <img src="${item.image}" alt="${item.name}">
      </div>
      <div class="item-info">
        <h3>${item.name}</h3>
        <div class="item-price">₹${item.price}</div>
      </div>
      <button class="btn btn-secondary btn-add" onclick="addToCart(${item.id})">Add to Cart</button>
    `;
    menuGrid.appendChild(div);
  });
}

function addToCart(id) {
  if (cart[id]) {
    cart[id].quantity += 1;
  } else {
    const item = menuItems.find(i => i.id === id);
    cart[id] = { ...item, quantity: 1 };
  }
  renderCart();
}

// Attach to window so onclick works in injected HTML
window.addToCart = addToCart;

function updateQuantity(id, change) {
  if (cart[id]) {
    cart[id].quantity += change;
    if (cart[id].quantity <= 0) {
      delete cart[id];
    }
  }
  renderCart();
}
window.updateQuantity = updateQuantity;

function renderCart() {
  cartItemsContainer.innerHTML = '';
  let total = 0;
  
  const keys = Object.keys(cart);
  if (keys.length === 0) {
    cartItemsContainer.innerHTML = '<p style="color: var(--text-muted); text-align: center; margin-top: 2rem;">Cart is empty</p>';
    checkoutBtn.disabled = true;
    cartTotalElement.innerText = '₹0';
    return;
  }

  keys.forEach(id => {
    const item = cart[id];
    total += item.price * item.quantity;
    
    const div = document.createElement('div');
    div.className = 'cart-item';
    div.innerHTML = `
      <div>
        <div style="font-weight: 500;">${item.name}</div>
        <div style="font-size: 0.9rem; color: var(--text-muted)">₹${item.price} x ${item.quantity}</div>
      </div>
      <div class="cart-item-controls">
        <button onclick="updateQuantity(${id}, -1)">-</button>
        <span>${item.quantity}</span>
        <button onclick="updateQuantity(${id}, 1)">+</button>
      </div>
    `;
    cartItemsContainer.appendChild(div);
  });

  cartTotalElement.innerText = `₹${total}`;
  checkoutBtn.disabled = false;
  checkoutBtn.onclick = () => processCheckout(total);
}

async function processCheckout(total) {
  checkoutBtn.disabled = true;
  checkoutBtn.innerText = 'Processing...';

  try {
    const itemsList = Object.values(cart);
    const res = await fetch(`${API_URL}/orders/create`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ items: itemsList, total })
    });
    
    const data = await res.json();
    
    if (data.dummy) {
      // Dummy flow if no keys provided
      verifyPayment(data.razorpayOrderId, 'dummy_payment', itemsList, total);
      return;
    }

    const options = {
      key: "rzp_test_SgyyhrkV5OUHHg", 
      amount: data.amount,
      currency: "INR",
      name: "Canteen Express",
      description: "Pre-order Food",
      order_id: data.razorpayOrderId,
      handler: function (response) {
        verifyPayment(response.razorpay_order_id, response.razorpay_payment_id, itemsList, total);
      },
      prefill: {
        name: "Student",
        email: "student@college.edu",
        contact: "9999999999"
      },
      theme: {
        color: "#e53935"
      }
    };
    
    const rzp = new Razorpay(options);
    rzp.on('payment.failed', function (response){
      alert("Payment Failed");
      checkoutBtn.disabled = false;
      checkoutBtn.innerText = 'Proceed to Pay';
    });
    rzp.open();

  } catch (err) {
    console.error(err);
    alert('Error processing payment. Simulating success for testing.');
    verifyPayment('dummy_order', 'dummy_payment', Object.values(cart), total);
  }
}

async function verifyPayment(orderId, paymentId, items, total) {
  try {
    const res = await fetch(`${API_URL}/orders/verify`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        items,
        total
      })
    });
    
    const data = await res.json();
    if (data.success) {
      showQRModal(data.orderId);
      cart = {};
      renderCart();
      checkoutBtn.innerText = 'Proceed to Pay';
    }
  } catch (err) {
    console.error(err);
    alert('Failed to verify payment');
  }
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

// Socket Events
socket.on('menu_updated', () => {
  fetchMenu();
});

// Init
fetchMenu();

const nav = document.querySelector('nav');
if (nav) {
  const ordersBtn = document.createElement('a');
  ordersBtn.href = 'orders.html';
  ordersBtn.innerText = 'My Orders';
  nav.appendChild(ordersBtn);

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

if (menuSearchInput) {
  menuSearchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    renderMenu();
  });
}
