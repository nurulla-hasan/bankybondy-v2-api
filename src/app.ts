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
// Detras de reverse proxy (Nginx/ALB): IP real y cookies secure correctas
app.set('trust proxy', 1);
app.use(metricsMiddleware);

// (Webhook de Stripe desmontado: nunca se usó. Los pagos van por PayPal y
// MercadoPago, con sus webhooks firmados más abajo.)
// parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// Pagos ANTES del sanitizador global: los webhooks deben ver el payload/query
// ORIGINAL del proveedor. `sanitizeMongo` borra claves con punto como `data.id`
// (MercadoPago) y puede alterar el body que PayPal re-verifica contra su firma.
// Estos handlers tratan la entrada como strings (no la usan como query de Mongo).
app.get('/capture-payment', capturePayPalPayment);
app.post('/paypal-webhook', paypalWebhook);
app.post('/mercadopago-webhook', mercadopagoWebhook);

app.use(sanitizeMongo);
app.use(
    cors({
        // Dominios de produccion y desarrollo local
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
//
app.use('/uploads', express.static('uploads'));
// application routers ----------------
app.use('/', router);
// `contactLimiter`: endpoint público y sin auth que dispara un email por
// request. Sin límite, un bucle inundaba la casilla de soporte.
app.post('/contact-us', contactLimiter, sendContactUsEmail);
// (Los webhooks de PayPal/MercadoPago y /capture-payment se montan ARRIBA, antes
// de sanitizeMongo — fuente de verdad de la acreditación, con payload original.)
// Metricas Prometheus
app.get('/metrics', metricsHandler);

// Liveness: el proceso responde
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: dependencias listas.
//
// Mongo SIEMPRE gatea: sin base no se puede servir nada útil.
//
// Redis se REPORTA pero NO gatea por defecto, y es una desviación deliberada de
// cómo estaba anotado el pendiente ("/ready no chequea Redis"). El motivo: con
// Redis caído esta API sigue sirviendo casi todo —los rate limits abren
// (`passOnStoreError`), el encolado falla y el sweep lo recupera, los sockets
// funcionan single-instance—. Si `/ready` devolviera 503 por Redis, el balanceador
// sacaría de rotación a TODAS las instancias a la vez y convertiría una
// dependencia degradada en una caída total. Sería el mismo error de criterio que
// el fail-fast que ya se corrigió en `server.ts`: matar todo por algo parcial.
//
// Lo que sí cambia: ahora el estado de Redis es VISIBLE, que era el problema real
// —antes el server se declaraba listo sin decir una palabra— y el monitor externo
// puede alertar sobre `redis: "caido"` sin tirar el servicio.
//
// `READY_REQUIRE_REDIS=true` lo mete en el gate, para quien opere con otra
// política (p. ej. un despliegue donde Redis sea imprescindible de verdad).
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
        // Sirve y anda, pero con una dependencia caída: es lo que el monitor
        // externo tiene que ver para avisar sin sacar el servicio de rotación.
        degraded: listo && !redisOk,
    });
});

app.get('/', async (req, res) => {
    res.send({ message: 'Welcome to bankybondy  server' });
});

// not found (rutas no encontradas)
app.use(notFound);
// global error handler (debe ir el ultimo)
app.use(globalErrorHandler);

export default app;
