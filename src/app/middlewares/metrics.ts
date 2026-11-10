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

// ── Matching: bounded serving and per-participant read model ────────────────
export const bondMatchServeDuration = new client.Histogram({
    name: 'bond_match_serve_duration_seconds',
    help: 'Duración de la lectura de matches (legacy vs feed)',
    labelNames: ['mode'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});
register.registerMetric(bondMatchServeDuration);

export const bondMatchFeedRowsScanned = new client.Histogram({
    name: 'bond_match_feed_rows_scanned',
    help: 'Filas leídas por request en el modo feed (debe quedar <= scan limit)',
    buckets: [0, 10, 50, 100, 200, 400, 800, 1600, 3200],
});
register.registerMetric(bondMatchFeedRowsScanned);

export const bondMatchStatusTotal = new client.Counter({
    name: 'bond_match_status_total',
    help: 'Respuestas del endpoint de matches por status',
    labelNames: ['status'],
});
register.registerMetric(bondMatchStatusTotal);

export const bondMatchFeedUpsertsTotal = new client.Counter({
    name: 'bond_match_feed_upserts_total',
    help: 'Filas del read model escritas por recomputes',
});
register.registerMetric(bondMatchFeedUpsertsTotal);

export const bondMatchFeedTrimDeletedTotal = new client.Counter({
    name: 'bond_match_feed_trim_deleted_total',
    help: 'Filas eliminadas por la poda por participante',
});
register.registerMetric(bondMatchFeedTrimDeletedTotal);

export const bondMatchFeedWriteErrorsTotal = new client.Counter({
    name: 'bond_match_feed_write_errors_total',
    help: 'Fallos al escribir el read model',
});
register.registerMetric(bondMatchFeedWriteErrorsTotal);

export const bondMatchShadowDiffTotal = new client.Counter({
    name: 'bond_match_shadow_diff_total',
    help: 'Comparaciones shadow feed-vs-legacy',
    labelNames: ['result'],
});
register.registerMetric(bondMatchShadowDiffTotal);

export const bondMatchShadowJaccard = new client.Histogram({
    name: 'bond_match_shadow_jaccard',
    help: 'Jaccard del top-N entre feed y legacy (1 = idénticos)',
    buckets: [0.5, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99, 0.995, 0.999, 1],
});
register.registerMetric(bondMatchShadowJaccard);

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
    // Optional token gate (basic defense); at the network level expose /metrics
    // only to the internal network / Prometheus scraper.
    const token = process.env.METRICS_TOKEN;
    // fail-closed: with no token configured nothing is exposed (404 hides it).
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
