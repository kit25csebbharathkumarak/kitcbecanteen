# Canteen Express - Food Ordering System

A modern, real-time food ordering system for educational institutions with QR code verification and admin management.

## Features

- 🛒 Real-time food ordering
- 📱 QR code verification for order pickup
- 👨‍💼 Admin dashboard with menu management
- 💳 Razorpay payment integration
- 📧 Email notifications
- 🔐 JWT authentication
- 📊 Sales analytics

## Tech Stack

- **Backend**: Node.js, Express, Socket.io
- **Database**: SQLite
- **Frontend**: HTML, CSS, JavaScript
- **Payments**: Razorpay
- **Authentication**: JWT

## Local Development

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with your configuration
4. Run the server:
   ```bash
   npm start
   ```
5. Open `http://localhost:3000` in your browser

## Deployment

### Free Deployment on Render

This repo includes a `render.yaml` manifest so Render can build and deploy it more reliably.

1. **Fork this repository** to your GitHub account

2. **Create a Render account** at [render.com](https://render.com)

3. **Connect your GitHub repository**:
   - Go to Dashboard → New → Web Service
   - Connect your GitHub account
   - Select this repository

4. **Configure the service**:
   - **Name**: canteen-express
   - **Environment**: Node
   - **Build Command**: `npm install --build-from-source=sqlite3`
   - **Start Command**: `npm start`
   - **Plan**: Free

5. **Add Environment Variables**:
   ```
   RAZORPAY_KEY_ID=your_razorpay_key_id
   RAZORPAY_KEY_SECRET=your_razorpay_key_secret
   JWT_SECRET=your_jwt_secret
   EMAIL_USER=your_email@gmail.com
   EMAIL_PASS=your_app_password
   ```

6. **Deploy**: Click "Create Web Service"

### Important Notes

- **Node version**: This repo now targets `node 18.x`, which is compatible with Render's free environment.
- **Database**: SQLite is stored on the service filesystem and may reset after redeploy or container restart.
- **Email**: Use Gmail app passwords for `EMAIL_PASS`.
- **Payments**: This project currently runs Razorpay in test mode.

## Environment Variables

Create a `.env` file in the root directory:

```env
RAZORPAY_KEY_ID=rzp_test_your_key
RAZORPAY_KEY_SECRET=your_secret_key
JWT_SECRET=your_super_secret_key
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `POST /api/auth/forgot-password` - Password reset

### Menu Management (Admin)
- `GET /api/items` - Get all menu items
- `POST /api/items` - Add new item
- `PUT /api/items/:id` - Update item
- `DELETE /api/items/:id` - Delete item
- `GET /api/items/stats` - Get sales statistics

### Orders
- `POST /api/orders/create` - Create order
- `GET /api/orders` - Get all orders (Admin)
- `GET /api/orders/me` - Get user's orders
- `PUT /api/orders/:id/status` - Update order status

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

ISC License