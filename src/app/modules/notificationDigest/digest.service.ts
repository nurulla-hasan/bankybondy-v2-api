/* eslint-disable @typescript-eslint/no-explicit-any */
// Weekly email digest (Phase 4): groups each user's last 7 days of notifications by
// category (honoring Tanda C mutes) and sends a warm summary through `sendEmail`.
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
// Hard guard: the cron sends nothing until this flag is on, so a deploy can't
// accidentally fire real emails.
const DIGEST_ENABLED = process.env.DIGEST_ENABLED === 'true';
// Throttle between emails (SES sandbox allows ~1/sec; 300ms is conservative).
const DIGEST_THROTTLE_MS = parseInt(process.env.DIGEST_THROTTLE_MS || '300');

// Public API base for the unsubscribe link (List-Unsubscribe); the router mounts at
// '/', so the route is <API>/notification/digest-unsubscribe/<token>.
const API_BASE = (config.base_url || 'https://api.bankybondy.com').replace(
    /\/+$/,
    ''
);

// DEDICATED key for unsubscribe tokens, derived from the access secret via HMAC with
// a fixed label. Signing with the access secret itself would leave a 10-year,
// session-valid JWT in every inbox — one auth middleware change away from a bypass.
const DIGEST_UNSUB_SECRET = crypto
    .createHmac('sha256', config.jwt_access_secret as string)
    .update('bankybondy:digest-unsub:v1')
    .digest('hex');

// Signed per-user unsubscribe token; only allows setting digestOptOut for that
// profile. 1 year keeps the email link long-lived without being eternal.
const buildDigestUnsubToken = (profileId: string): string =>
    jwt.sign({ purpose: 'digest-unsub', profileId }, DIGEST_UNSUB_SECRET, {
        expiresIn: '365d',
    });

const digestUnsubUrl = (profileId: string): string =>
    `${API_BASE}/notification/digest-unsubscribe/${buildDigestUnsubToken(
        profileId
    )}`;

/** Opt the token owner out of the digest (one-click List-Unsubscribe): verifies
 *  signature and purpose, sets NormalUser.digestOptOut = true. Idempotent; returns
 *  the email for the confirmation message (best-effort). */
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

// Category metadata: label, brand color, whether to show a count (matches NO,
// its count is volatile), and the warm line.
const CATEGORY_META: Record<
    string,
    { label: string; color: string; showCount: boolean; line: (n: number) => string }
> = {
    matches: {
        label: 'Matches',
        color: '#4f46e5',
        showCount: false,
        line: () => 'Aparecieron nuevos matches para tus vínculos.',
    },
    trueques: {
        label: 'Trueques',
        color: '#06b6d4',
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
        color: '#10b981',
        showCount: true,
        line: (n) =>
            n === 1
                ? 'Tenés 1 novedad de amistad.'
                : `Tenés ${n} novedades de amistad.`,
    },
};

// Sample sections for the PREVIEW when the user has no real activity, so the layout
// can still be seen.
const SAMPLE_SECTIONS: DigestSection[] = [
    { label: 'Matches', color: '#4f46e5', count: null, line: 'Aparecieron nuevos matches para tus vínculos.' },
    { label: 'Trueques', color: '#06b6d4', count: 2, line: 'Tenés 2 novedades en tus trueques.' },
    { label: 'Reseñas', color: '#f59e0b', count: 1, line: 'Alguien contó cómo fue encontrarse con vos.' },
    { label: 'Amistades', color: '#10b981', count: 3, line: 'Tenés 3 novedades de amistad.' },
];

/** Collect one user's last-7-day activity into sections (skipping muted categories).
 *  Returns [] when empty. */
export const buildUserSections = async (
    userId: string,
    mutedCategories: string[] = []
): Promise<DigestSection[]> => {
    const weekAgo = new Date(Date.now() - WEEK_MS);
    const rows: any[] = await Notification.aggregate([
        { $match: { receiver: userId, createdAt: { $gte: weekAgo } } },
        { $group: { _id: '$type', count: { $sum: 1 } } },
    ]);

    // type → count  ⇒  category → sum
    const perCategory: Record<string, number> = {};
    for (const r of rows) {
        const cat = categoryForType(r._id);
        if (!cat) continue; // types without a category (legacy GENERAL, etc.) don't count
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

/** Send (or simulate) ONE user's digest. `force` = send even with no activity
 *  (sample sections), used for the preview to your own inbox. */
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

    // Opted out: never send the weekly digest. The preview (force) still sends
    // because the user requests it from their preferences.
    if (user.digestOptOut && !force) {
        return { sent: false, reason: 'opted-out', email: user.email };
    }

    let sections = await buildUserSections(
        userId,
        user.mutedNotificationCategories || []
    );
    if (sections.length === 0) {
        if (!force) return { sent: false, reason: 'no-activity', email: user.email };
        sections = SAMPLE_SECTIONS; // preview: still show the layout
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

    // List-Unsubscribe (one-click opt-out) improves digest deliverability and matches
    // Gmail sender guidelines; the token-signed URL is the public endpoint.
    const unsubUrl = digestUnsubUrl(userId);
    const headers = {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };

    // sendEmail no longer throws (fails closed): it returns a boolean, so reflect the
    // real result instead of assuming success.
    const ok = await sendEmail({
        email: user.email,
        subject: 'Esta semana en BankyBondy 👋',
        html,
        from: config.smtp.from,
        headers,
    });
    return { sent: ok, email: user.email };
};

/** Run the weekly digest for EVERY user with recent activity. Gated by
 *  DIGEST_ENABLED (except dry-run) and throttled between sends. */
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
