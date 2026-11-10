/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-unused-vars */
/* eslint-disable prefer-const */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { File } from 'node:buffer';
globalThis.File = File as any;

import cookieParser from 'cookie-parser';
import cors from 'cors';
import mongoose from 'mongoose';
import helmet from 'helmet';
import express, { Application } from 'express';
import sendContactUsEmail from './app/helper/sendContactUsEmail';
import globalErrorHandler from './app/middlewares/globalErrorHandler';
import notFound from './app/middlewares/notFound';
import { contactLimiter } from './app/middlewares/rateLimiter';
import { metricsHandler, metricsMiddleware } from './app/middlewares/metrics';
import sanitizeMongo from './app/middlewares/sanitizeMongo';
import mercadopagoWebhook from './app/mercadopago/mercadopago.webhook';
import capturePayPalPayment from './app/paypal/capturePaypalPayment';
import paypalWebhook from './app/paypal/paypalWebhook';
import router from './app/routes';
import { estadoRedisPresencia } from './app/socket/presence';
const app: Application = express();
app.use(helmet());
// Behind a reverse proxy: real client IP and secure cookies.
app.set('trust proxy', 1);
app.use(metricsMiddleware);

// Stripe webhook was removed (never used); payments are PayPal/MercadoPago.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// Payments mount BEFORE the global sanitizer: webhooks must see the provider's
// ORIGINAL payload (sanitizeMongo strips dotted keys like `data.id` and may break
// PayPal signature verification).
app.get('/capture-payment', capturePayPalPayment);
app.post('/paypal-webhook', paypalWebhook);
app.post('/mercadopago-webhook', mercadopagoWebhook);

app.use(sanitizeMongo);
app.use(
    cors({
        // Production and local dev origins
        origin: [
            'https://bankybondy.com',
            'https://www.bankybondy.com',
            'https://admin.bankybondy.com',
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:3002',
        ],
        // origin: '*',
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
    })
);
app.use('/uploads', express.static('uploads'));
// Application routers
app.use('/', router);
// `contactLimiter`: public unauthenticated endpoint that sends an email per
// request; without a limit a loop floods the support inbox.
app.post('/contact-us', contactLimiter, sendContactUsEmail);
// PayPal/MercadoPago webhooks and /capture-payment mount above, before
// sanitizeMongo, to keep the original payload.
// Prometheus metrics
app.get('/metrics', metricsHandler);

// Liveness: process responds
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: Mongo always gates; Redis is reported but does not gate by default.
// A 503 on Redis would pull every instance out of rotation at once, turning a
// degraded dependency into a full outage. `READY_REQUIRE_REDIS=true` opts in.
app.get('/ready', (req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    const redis = estadoRedisPresencia();
    const redisGatea =
        (process.env.READY_REQUIRE_REDIS || '').toLowerCase() === 'true';
    const redisOk = redis !== 'caido';

    const listo = dbReady && (!redisGatea || redisOk);
    res.status(listo ? 200 : 503).json({
        status: listo ? 'ready' : 'not-ready',
        db: dbReady ? 'connected' : 'disconnected',
        redis,
        // Serving with a degraded dependency: let the external monitor alert
        // without taking the service out of rotation.
        degraded: listo && !redisOk,
    });
});

app.get('/', async (req, res) => {
    res.send({ message: 'Welcome to bankybondy  server' });
});

// Unmatched routes
app.use(notFound);
// Global error handler (must be last)
app.use(globalErrorHandler);

export default app;
