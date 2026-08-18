const API_URL = `${window.location.origin}/api`;

// Redirect if already logged in
const token = localStorage.getItem('token');
const user = JSON.parse(localStorage.getItem('user') || 'null');
const currentPath = window.location.pathname;

if (token && user && (currentPath.endsWith('login.html') || currentPath.endsWith('register.html') || currentPath.endsWith('/') || currentPath.endsWith('index.html'))) {
  if (user.role === 'admin') {
    window.location.href = 'admin.html';
  } else {
    window.location.href = 'menu.html';
  }
}

const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const errorMsg = document.getElementById('error-msg');

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    try {
      const res = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      
      if (!res.ok) {
        errorMsg.innerText = data.error;
        errorMsg.style.display = 'block';
      } else {
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        
        if (data.user.role === 'admin') {
          window.location.href = 'admin.html';
        } else {
          window.location.href = 'menu.html';
        }
      }
    } catch (err) {
      errorMsg.innerText = "Network error.";
      errorMsg.style.display = 'block';
    }
  });
}

if (registerForm) {
  const otpGroup = document.getElementById('otp-group');
  const otpInput = document.getElementById('otp');
  const infoMsg = document.getElementById('info-msg');
  const registerBtn = document.getElementById('register-btn');

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('name').value;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;

    errorMsg.style.display = 'none';
    infoMsg.style.display = 'none';

    // If OTP field is not yet visible, trigger the OTP generation and send
    if (otpGroup.style.display === 'none') {
      registerBtn.disabled = true;
      registerBtn.innerText = 'Sending OTP...';

      try {
        const res = await fetch(`${API_URL}/auth/send-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email })
        });
        const data = await res.json();

        if (!res.ok) {
          errorMsg.innerText = data.error || 'Failed to send verification code.';
          errorMsg.style.display = 'block';
          registerBtn.disabled = false;
          registerBtn.innerText = 'Register';
        } else {
          infoMsg.innerText = data.message;
          infoMsg.style.display = 'block';
          otpGroup.style.display = 'block';
          otpInput.setAttribute('required', 'true');
          registerBtn.disabled = false;
          registerBtn.innerText = 'Verify & Register';
        }
      } catch (err) {
        errorMsg.innerText = "Network error. Failed to send OTP.";
        errorMsg.style.display = 'block';
        registerBtn.disabled = false;
        registerBtn.innerText = 'Register';
      }
      return;
    }

    // If OTP field is visible, submit full registration details including OTP
    const otp = otpInput.value;
    if (!otp) {
      errorMsg.innerText = "Please enter the verification code.";
      errorMsg.style.display = 'block';
      return;
    }

    registerBtn.disabled = true;
    registerBtn.innerText = 'Registering...';

    try {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, otp })
      });
      const data = await res.json();
      
      if (!res.ok) {
        errorMsg.innerText = data.error;
        errorMsg.style.display = 'block';
        registerBtn.disabled = false;
        registerBtn.innerText = 'Verify & Register';
      } else {
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        window.location.href = 'menu.html';
      }
    } catch (err) {
      errorMsg.innerText = "Network error.";
      errorMsg.style.display = 'block';
      registerBtn.disabled = false;
      registerBtn.innerText = 'Verify & Register';
    }
  });
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = 'login.html';
}
window.logout = logout;

// --- Google Sign-In Integration ---
async function initGoogleSignIn() {
  const container = document.getElementById('google-auth-container');
  if (!container) return;

  try {
    const res = await fetch(`${API_URL}/auth/google-client-id`);
    if (!res.ok) return;
    const data = await res.json();
    
    if (data.clientId) {
      container.style.display = 'block';
      
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);

      window.handleGoogleCallback = async (response) => {
        try {
          const verifyRes = await fetch(`${API_URL}/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: response.credential })
          });
          const authData = await verifyRes.json();
          
          if (!verifyRes.ok) {
            if (errorMsg) {
              errorMsg.innerText = authData.error || 'Google login failed';
              errorMsg.style.display = 'block';
            }
          } else {
            localStorage.setItem('token', authData.token);
            localStorage.setItem('user', JSON.stringify(authData.user));
            
            if (authData.user.role === 'admin') {
              window.location.href = 'admin.html';
            } else {
              window.location.href = 'menu.html';
            }
          }
        } catch (err) {
          if (errorMsg) {
            errorMsg.innerText = "Network error during Google Sign In.";
            errorMsg.style.display = 'block';
          }
        }
      };

      script.onload = () => {
        google.accounts.id.initialize({
          client_id: data.clientId,
          callback: handleGoogleCallback,
          context: window.location.pathname.includes('register') ? 'signup' : 'signin'
        });
        
        google.accounts.id.renderButton(
          document.getElementById('google-btn-wrapper'),
          { theme: 'outline', size: 'large', width: '100%', text: window.location.pathname.includes('register') ? 'signup_with' : 'signin_with' }
        );
      };
    }
  } catch (e) {
    console.error("Failed to load Google Client ID", e);
  }
}

initGoogleSignIn();

