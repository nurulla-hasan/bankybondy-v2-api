/* eslint-disable @typescript-eslint/no-explicit-any */
// Digest semanal por email (Fase 4). Junta las notificaciones de los últimos 7
// días de cada usuario, las agrupa por categoría (respetando el SILENCIADO de la
// Tanda C) y manda un resumen cálido. Todo pasa por el mismo `sendEmail`, así que
// hereda el remitente que esté configurado (Gmail hoy, SES cuando se mude).
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import config from '../../config';
import { errorLogger, logger } from '../../shared/logger';
import sendEmail from '../../utilities/sendEmail';
import Notification from '../notification/notification.model';
import NormalUser from '../normalUser/normalUser.model';
import {
    categoryForType,
    NOTIFICATION_CATEGORIES,
} from '../notification/notification.categories';
import { buildDigestHtml, DigestSection } from './digest.template';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Guarda dura: el cron NO manda nada hasta que se prenda esta variable. Evita
// que un deploy dispare mails reales sin querer.
const DIGEST_ENABLED = process.env.DIGEST_ENABLED === 'true';
// Throttle entre mails (el sandbox de SES admite ~1/seg; 300ms es conservador).
const DIGEST_THROTTLE_MS = parseInt(process.env.DIGEST_THROTTLE_MS || '300');

// Base pública de la API para el link de baja (List-Unsubscribe). El router monta
// en '/', así que la ruta queda <API>/notification/digest-unsubscribe/<token>.
const API_BASE = (config.base_url || 'https://api.bankybondy.com').replace(
    /\/+$/,
    ''
);

// Clave DEDICADA para los tokens de baja, derivada del secreto de acceso por
// HMAC con una etiqueta fija. No requiere variable de entorno nueva, pero es
// criptográficamente independiente: firmar con el MISMO secreto que los access
// tokens dejaba un JWT de 10 años de vida, con validez de sesión, sentado en la
// casilla de correo de cada usuario para siempre. Bastaba un cambio futuro en el
// middleware de auth para convertirlo en un bypass de autenticación.
const DIGEST_UNSUB_SECRET = crypto
    .createHmac('sha256', config.jwt_access_secret as string)
    .update('bankybondy:digest-unsub:v1')
    .digest('hex');

// Token firmado de baja del digest (por usuario). Sólo habilita marcar
// digestOptOut de ESE perfil. 1 año: sigue siendo un link de correo de vida
// larga, pero deja de ser eterno.
const buildDigestUnsubToken = (profileId: string): string =>
    jwt.sign({ purpose: 'digest-unsub', profileId }, DIGEST_UNSUB_SECRET, {
        expiresIn: '365d',
    });

const digestUnsubUrl = (profileId: string): string =>
    `${API_BASE}/notification/digest-unsubscribe/${buildDigestUnsubToken(
        profileId
    )}`;

/** Da de baja del digest al dueño del token (List-Unsubscribe de un clic).
 *  Verifica la firma y el propósito; setea NormalUser.digestOptOut = true.
 *  Idempotente. Devuelve el email para el mensaje de confirmación (best-effort). */
export const unsubscribeFromDigest = async (
    token: string
): Promise<{ ok: boolean; email?: string }> => {
    try {
        const payload = jwt.verify(token, DIGEST_UNSUB_SECRET) as {
            purpose?: string;
            profileId?: string;
        };
        if (
            payload?.purpose !== 'digest-unsub' ||
            !payload.profileId ||
            !Types.ObjectId.isValid(payload.profileId)
        ) {
            return { ok: false };
        }
        const updated = await NormalUser.findByIdAndUpdate(
            payload.profileId,
            { digestOptOut: true },
            { new: true }
        ).select('email');
        return { ok: !!updated, email: (updated as any)?.email };
    } catch {
        return { ok: false };
    }
};

// Metadatos por categoría: etiqueta, color de marca, si muestra número (matches
// NO, porque su conteo es volátil), y la frase cálida.
const CATEGORY_META: Record<
    string,
    { label: string; color: string; showCount: boolean; line: (n: number) => string }
> = {
    matches: {
        label: 'Matches',
        color: '#1f4288',
        showCount: false,
        line: () => 'Aparecieron nuevos matches para tus vínculos.',
    },
    trueques: {
        label: 'Trueques',
        color: '#0ea5e9',
        showCount: true,
        line: (n) =>
            n === 1
                ? 'Tenés 1 novedad en tus trueques.'
                : `Tenés ${n} novedades en tus trueques.`,
    },
    resenas: {
        label: 'Reseñas',
        color: '#f59e0b',
        showCount: true,
        line: (n) =>
            n === 1
                ? 'Alguien contó cómo fue encontrarse con vos.'
                : `${n} personas contaron cómo fue encontrarse con vos.`,
    },
    amistades: {
        label: 'Amistades',
        color: '#8b5cf6',
        showCount: true,
        line: (n) =>
            n === 1
                ? 'Tenés 1 novedad de amistad.'
                : `Tenés ${n} novedades de amistad.`,
    },
};

// Secciones de muestra para el PREVIEW cuando el usuario no tiene actividad real
// (para poder ver el diseño igual).
const SAMPLE_SECTIONS: DigestSection[] = [
    { label: 'Matches', color: '#1f4288', count: null, line: 'Aparecieron nuevos matches para tus vínculos.' },
    { label: 'Trueques', color: '#0ea5e9', count: 2, line: 'Tenés 2 novedades en tus trueques.' },
    { label: 'Reseñas', color: '#f59e0b', count: 1, line: 'Alguien contó cómo fue encontrarse con vos.' },
    { label: 'Amistades', color: '#8b5cf6', count: 3, line: 'Tenés 3 novedades de amistad.' },
];

/** Junta la actividad de los últimos 7 días de un usuario y arma las secciones
 *  (excluyendo las categorías silenciadas). Devuelve [] si no hay nada. */
export const buildUserSections = async (
    userId: string,
    mutedCategories: string[] = []
): Promise<DigestSection[]> => {
    const weekAgo = new Date(Date.now() - WEEK_MS);
    const rows: any[] = await Notification.aggregate([
        { $match: { receiver: userId, createdAt: { $gte: weekAgo } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
    ]);

    // type → count  ⇒  categoría → suma
    const perCategory: Record<string, number> = {};
    for (const r of rows) {
        const cat = categoryForType(r._id);
        if (!cat) continue; // tipos sin categoría (viejos GENERAL, etc.) no cuentan
        perCategory[cat] = (perCategory[cat] || 0) + (r.count || 0);
    }

    const muted = new Set(mutedCategories || []);
    const sections: DigestSection[] = [];
    for (const cat of NOTIFICATION_CATEGORIES) {
        const n = perCategory[cat] || 0;
        if (n <= 0 || muted.has(cat)) continue;
        const meta = CATEGORY_META[cat];
        sections.push({
            label: meta.label,
            color: meta.color,
            count: meta.showCount ? n : null,
            line: meta.line(n),
        });
    }
    return sections;
};

/** Manda (o simula) el digest de UN usuario. `force` = mandar aunque no haya
 *  actividad (usa secciones de muestra), para el preview a la propia casilla. */
export const sendDigestToUser = async (
    userId: string,
    opts: { dryRun?: boolean; force?: boolean } = {}
): Promise<{ sent: boolean; reason?: string; email?: string }> => {
    const { dryRun = false, force = false } = opts;
    if (!Types.ObjectId.isValid(userId)) return { sent: false, reason: 'invalid-id' };

    const user: any = await NormalUser.findById(userId)
        .select('name email mutedNotificationCategories digestOptOut')
        .lean();
    if (!user?.email) return { sent: false, reason: 'no-email' };

    // Baja del digest: no mandar el semanal a quien se dio de baja. El preview
    // (force) SÍ se envía: lo pide el propio usuario desde sus preferencias.
    if (user.digestOptOut && !force) {
        return { sent: false, reason: 'opted-out', email: user.email };
    }

    let sections = await buildUserSections(
        userId,
        user.mutedNotificationCategories || []
    );
    if (sections.length === 0) {
        if (!force) return { sent: false, reason: 'no-activity', email: user.email };
        sections = SAMPLE_SECTIONS; // preview: mostrar el diseño igual
    }

    const html = buildDigestHtml({
        name: user.name,
        sections,
        siteUrl: config.web_url,
    });

    if (dryRun) {
        logger.info(
            `[digest] (dry-run) → ${user.email} · ${sections.length} secciones`
        );
        return { sent: false, reason: 'dry-run', email: user.email };
    }

    // List-Unsubscribe (baja de un clic) → mejora entregabilidad del digest y
    // cumple las guías de remitentes de Gmail. La URL apunta al endpoint público
    // token-firmado; el One-Click hace POST y da de baja sin pasos extra.
    const unsubUrl = digestUnsubUrl(userId);
    const headers = {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };

    // sendEmail ya no lanza (falla cerrada): devuelve booleano. Reflejamos el
    // resultado real en vez de asumir envío exitoso.
    const ok = await sendEmail({
        email: user.email,
        subject: 'Esta semana en BankyBondy 👋',
        html,
        from: config.smtp.from,
        headers,
    });
    return { sent: ok, email: user.email };
};

/** Corre el digest semanal para TODOS los usuarios con actividad reciente.
 *  Guardado por DIGEST_ENABLED (salvo dry-run). Throttle entre envíos. */
export const sendWeeklyDigests = async (
    opts: { dryRun?: boolean; limit?: number } = {}
): Promise<{ enabled: boolean; candidates?: number; sent?: number; skipped?: number }> => {
    const { dryRun = false, limit = 0 } = opts;
    if (!DIGEST_ENABLED && !dryRun) {
        logger.warn('[digest] DIGEST_ENABLED != true → no se envía nada.');
        return { enabled: false };
    }

    const weekAgo = new Date(Date.now() - WEEK_MS);
    let receivers: any[] = await Notification.distinct('receiver', {
        createdAt: { $gte: weekAgo },
    });
    receivers = receivers.filter(
        (r) => typeof r === 'string' && Types.ObjectId.isValid(r)
    );
    if (limit > 0) receivers = receivers.slice(0, limit);

    let sent = 0;
    let skipped = 0;
    for (const r of receivers) {
        try {
            const res = await sendDigestToUser(r, { dryRun });
            if (res.sent) sent++;
            else skipped++;
        } catch (e) {
            skipped++;
            errorLogger.error(
                '[digest] fallo enviando a un usuario:',
                (e as Error)?.message
            );
        }
        await new Promise((resolve) => setTimeout(resolve, DIGEST_THROTTLE_MS));
    }

    logger.info(
        `[digest] semanal: ${sent} enviados, ${skipped} salteados (de ${receivers.length} candidatos)`
    );
    return { enabled: true, candidates: receivers.length, sent, skipped };
};

export const digestService = {
    buildUserSections,
    sendDigestToUser,
    sendWeeklyDigests,
    DIGEST_ENABLED,
};

export default digestService;
