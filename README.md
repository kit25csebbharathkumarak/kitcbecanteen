# SRI CUMIN SEEDS CATERING SERVICES - Food Ordering System

A modern, real-time food ordering system for educational institutions with QR code verification and admin management.

## Features

- 🛒 Real-time food ordering with cart checkout
- 📱 QR code pickup verification
- 👨‍💼 Admin dashboard with menu, stock, and order management
- 💳 UPI Gateway dynamic QR payment integration
- 📧 Email notifications for password reset and registration
- 🔐 JWT-based authentication
- 📊 Sales analytics and order insights

## Tech Stack

- **Backend**: Node.js, Express, Socket.io
- **Database**: PostgreSQL
- **Frontend**: HTML, CSS, JavaScript
- **Payments**: UPI Gateway dynamic QR integration
- **Authentication**: JWT

## Local Development

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file with your configuration.
4. Run the server:
   ```bash
   npm start
   ```
5. Open `http://localhost:3000` in your browser.

## Deployment

### Render Deployment

This repository includes a `render.yaml` manifest for Render.

1. Fork this repository.
2. Create a Render account at [render.com](https://render.com).
3. Connect your GitHub repository.
4. Configure the service:
   - **Name**: canteen-express
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. Add environment variables.
6. Deploy the service.

### Important Notes

- **Node version**: Use Node 18.x or newer.
- **Database**: This app now uses PostgreSQL via `DATABASE_URL`, which is the correct production approach on Render.
- **Email**: Use Gmail app passwords for `EMAIL_PASS` if using Gmail SMTP.
- **Payments**: UPI Gateway dynamic QR payments require a valid API key and webhook configuration.
- **Email**: Use Gmail app passwords for `EMAIL_PASS` if using Gmail SMTP.

## Environment Variables

Create a `.env` file in the root directory:

```env
DATABASE_URL=postgres://username:password@hostname:port/databasename
UPIGATEWAY_API_KEY=your_upigateway_api_key
UPIGATEWAY_BASE_URL=https://merchant.upigateway.com
UPIGATEWAY_CREATE_PATH=/api/v1/dynamic-qr
UPIGATEWAY_API_KEY_HEADER=Authorization
JWT_SECRET=your_jwt_secret
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password
PORT=3000
```

Optional fields:

```env
ADMIN_UPI_NAME=SRI CUMIN SEEDS CATERING SERVICES
UPIGATEWAY_WEBHOOK_SECRET=your_upigateway_webhook_secret  # optional; if absent, webhook auth is not enforced
UPIGATEWAY_WEBHOOK_HEADER=x-api-key  # optional; used only when webhook secret is configured
```}

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
- `POST /api/orders/create` - Create order and initiate UPI Gateway QR payment
- `GET /api/orders` - Get all orders (Admin)
- `GET /api/orders/me` - Get user's orders
- `PUT /api/orders/:id/status` - Update order status

## Contributing

1. Fork the repository.
2. Create a feature branch.
3. Make your changes.
4. Submit a pull request.

## License

ISC License