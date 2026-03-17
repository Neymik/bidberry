import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/bun';
import authRoutes from './auth-routes';
import { authMiddleware } from './auth-middleware';
import dashboardRoutes from './dashboard-routes';
import campaignRoutes from './campaign-routes';
import productRoutes from './product-routes';
import keywordRoutes from './keyword-routes';
import financialRoutes from './financial-routes';
import biddingRoutes from './bidding-routes';
import exportRoutes from './export-routes';
import importRoutes from './import-routes';
import ordersRoutes from './orders-routes';
import stockRoutes from './stock-routes';
import eventsRoutes from './events-routes';
import cabinetRoutes from './cabinet-routes';
import adminRoutes from './admin-routes';
import monitoringRoutes from './monitoring-routes';
import emuIngestRoutes from './emulator-ingest-routes';

const app = new Hono();

// Middleware
app.use('/*', cors());

// Static files
app.use('/static/*', serveStatic({ root: './public' }));

// Public routes (no auth required)
app.route('/', authRoutes);

// Protected routes (auth required)
app.use('/api/*', async (c, next) => {
  // Skip auth for auth endpoints
  if (c.req.path.startsWith('/api/auth/') ||
      c.req.path === '/api/orders/ingest' ||
      c.req.path === '/api/orders/heartbeat') return next();
  return authMiddleware(c, next);
});

app.route('/', dashboardRoutes);
app.route('/', campaignRoutes);
app.route('/', productRoutes);
app.route('/', keywordRoutes);
app.route('/', financialRoutes);
app.route('/', biddingRoutes);
app.route('/', exportRoutes);
app.route('/', importRoutes);
app.route('/', ordersRoutes);
app.route('/', stockRoutes);
app.route('/', eventsRoutes);
app.route('/', cabinetRoutes);
app.route('/', adminRoutes);
app.route('/', monitoringRoutes);
app.route('/api/orders', emuIngestRoutes);

export default app;
