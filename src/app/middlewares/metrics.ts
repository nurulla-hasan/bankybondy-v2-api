import client from 'prom-client';
import { NextFunction, Request, Response } from 'express';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duración de las peticiones HTTP en segundos',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});
register.registerMetric(httpDuration);

export const metricsMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
        const route = req.route?.path || req.path || 'unknown';
        end({ method: req.method, route, status: res.statusCode });
    });
    next();
};

export const metricsHandler = async (req: Request, res: Response) => {
    // Restringir por token opcional (defensa básica); a nivel de red,
    // exponer /metrics solo a la red interna / scraper de Prometheus.
    const token = process.env.METRICS_TOKEN;
    // fail-closed: sin token configurado NO se expone nada (404 ni revela que existe).
    if (!token) {
        res.status(404).end();
        return;
    }
    if (req.headers['authorization'] !== `Bearer ${token}`) {
        res.status(401).end();
        return;
    }
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
};
