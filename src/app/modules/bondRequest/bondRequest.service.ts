/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';
import { isTextSafeBatch, assertTextAllowed } from '../../helper/isTextSafe';
import { generateEmbedding } from '../../utilities/embedding';
import NormalUser from '../normalUser/normalUser.model';
import { buildLooseRegex } from '../normalUser/normalUser.services';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import { IBondRequest } from './bondRequest.interface';
import BondRequest from './bondRequest.model';
import BondMatch from '../bondMatch/bondMatch.model';
import BondMatchFeed from '../bondMatch/bondMatchFeed.model';
import { IMatchScoreParts } from '../bondMatch/bondMatch.interface';
import { topMatchKeys } from './matching.feed';
import {
    bondMatchFeedRowsScanned,
    bondMatchServeDuration,
    bondMatchShadowDiffTotal,
    bondMatchShadowJaccard,
    bondMatchStatusTotal,
} from '../../middlewares/metrics';
import { logger } from '../../shared/logger';
import { getBlockedIdsFor } from '../userBlock/userBlock.service';
import { BondLink } from '../bondLink/bondLink.model';
import { agendaVencida } from './matching.schedule';
import { MATCHING } from './matching.config';
import { getMatchingSettings } from '../settings/matchingSettings.service';
import { selectMatchingCache } from './matching.cache';
import { COLOR_PALETTE, specialEntryColor, isEmptyToken } from './matching.colors';
import { clampLimit, clampPage } from '../../utilities/pagination';
import { publicMatchRequest } from './bondRequest.publicShape';
import {
    enqueueRecompute,
    invalidateAndRefresh,
    MATCH_PRIORITY_USER,
} from './matching.robot';
import sendNotification from '../../helper/sendNotification';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import { ENUM_SUBSCRIPTION_TYPE } from '../normalUser/normalUser.enum';
import { recalcularVinculosVivos } from '../normalUser/vinculosVivos';
import { hasBondIdentity } from './bondIdentity';
import { createBondIntegrity } from './bondIntegrity';
import Conversation from '../conversation/conversation.model';

// Single duplicate-bond message: used by the pre-check and the E11000 catch so the
// client always gets the same text, whichever layer caught it.
const DUPLICATE_BOND_MESSAGE =
    'Ya tenés un vínculo igual (mismo "ofrezco" y "busco").';

// Escape regex metacharacters so a literal user string can be matched
// case-insensitively/anchor without altering the pattern (no injection, no syntax errors).
const escapeRegex = (s: string) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* What counts toward `bondLimit`: every bond the user has not deleted (active or
 * paused). There is no "completed" state — finishing a trade does not retire the
 * bond, only pause/delete do, and the `BondLink` lifecycle is unrelated. An older
 * version filtered by `status`, which was inert (`BondRequest.status` is never
 * rewritten after create) and wrong in intent (it removed completed bonds from the
 * matching pool). One shared constant so the fast-fail and the in-transaction check
 * can never disagree. */
export const FILTRO_CUPO_VINCULOS = {
    isDeleted: { $ne: true },
};

const createBondRequestIntoDB = async (
    userId: string,
    payload: IBondRequest
) => {
    const [user, currentBondCount] = await Promise.all([
        NormalUser.findById(userId),
        // Only live bonds consume quota; see FILTRO_CUPO_VINCULOS for the rule.
        BondRequest.countDocuments({ user: userId, ...FILTRO_CUPO_VINCULOS }),
    ]);

    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Bond limit: default 25 (free tier). `>=` lets a free account create exactly
    // 25. 403 + 'BOND_LIMIT_REACHED' lets the front route to subscriptions.
    if (currentBondCount >= (user.bondLimit ?? 25)) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'Bond request limit reached. Please upgrade your subscription.',
            'BOND_LIMIT_REACHED'
        );
    }

    const offerTrimmed = (payload.offer ?? '').trim();
    const wantTrimmed = (payload.want ?? '').trim();
    // Both canonical and legacy identity checks finish before paid API calls.
    if (await hasBondIdentity(BondRequest, userId, offerTrimmed, wantTrimmed)) {
        throw new AppError(httpStatus.CONFLICT, DUPLICATE_BOND_MESSAGE);
    }
    // Censor all three visible texts (offer/want/description) in ONE batched call:
    // 2 OpenAI requests per bond instead of 6. Full pipeline, per-field verdict,
    // blocking (embeddings are discarded on failure). Empty description is safe.
    const [safety, offerVector, wantVector] = await Promise.all([
        isTextSafeBatch([offerTrimmed, wantTrimmed, payload.description ?? '']),
        generateEmbedding(offerTrimmed),
        generateEmbedding(wantTrimmed),
    ]);
    const [offerCheck, wantCheck, descCheck] = safety;

    // Moderation wins: assertTextAllowed distinguishes "not allowed" (400) from
    // "moderation down, retry" (503) — a transient OpenAI failure used to surface
    // as 400 "not allowed" on content that could be fine.
    assertTextAllowed(offerCheck, 'Offer');
    assertTextAllowed(wantCheck, 'Want');
    assertTextAllowed(descCheck, 'Description');

    // Location inheritance (best-effort): if the payload has no usable coords and
    // the creator has saved ones, the bond inherits them. Radius and modality are
    // untouched; online bonds stay global (matching ignores geo for online).
    const payloadCoords = (payload as any)?.location?.coordinates as
        | number[]
        | undefined;
    const hasUsableCoords =
        Array.isArray(payloadCoords) && payloadCoords.length >= 2;
    const userCoords = (user as any)?.location?.coordinates as
        | number[]
        | undefined;
    if (
        !hasUsableCoords &&
        Array.isArray(userCoords) &&
        userCoords.length >= 2
    ) {
        (payload as any).location = {
            type: 'Point',
            coordinates: userCoords,
        };
    } else if (!hasUsableCoords) {
        // No coords in payload and none inheritable: drop `location` entirely. A
        // partial one (type without coordinates) is rejected by the 2dsphere
        // index (500); matching tolerates a missing location.
        delete (payload as any).location;
    }

    // Atomic quota (race fix): the check above is a cheap fast-fail, not
    // authoritative — two concurrent requests could both insert. Re-count and
    // create inside a short transaction; the guard write ($inc bondSeq) forces a
    // WriteConflict so withTransaction retries the second one.
    let created: any;
    let countAfterCreate = 0;
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const countNow = await BondRequest.countDocuments({
                user: userId,
                // Exactly the fast-fail criterion, by construction.
                ...FILTRO_CUPO_VINCULOS,
            }).session(session);
            if (countNow >= (user.bondLimit ?? 25)) {
                throw new AppError(
                    httpStatus.FORBIDDEN,
                    'Bond request limit reached. Please upgrade your subscription.',
                    'BOND_LIMIT_REACHED'
                );
            }
            // Guard write: serializes concurrent creates of the same user (two
            // $inc on one doc → WriteConflict → retry). `hasActiveBonds: true` goes
            // in the same write inside the transaction; every bond is born alive.
            // See vinculosVivos.ts.
            const guardedUser = await NormalUser.updateOne(
                { _id: userId },
                { $inc: { bondSeq: 1 }, $set: { hasActiveBonds: true } },
                { session }
            );
            if (!guardedUser.matchedCount) throw new AppError(httpStatus.NOT_FOUND, 'User not found');
            if (await hasBondIdentity(BondRequest, userId, offerTrimmed, wantTrimmed, session)) {
                throw new AppError(httpStatus.CONFLICT, DUPLICATE_BOND_MESSAGE);
            }
            // Whitelist (anti mass-assignment): only user-settable fields. A
            // `{ ...payload }` spread let clients inject internal fields (`status`,
            // `isLinked`, `isPause`, `matchesComputedAt`) and corrupt state; those
            // are set only by the system or the model default.
            const [doc] = await BondRequest.create(
                [
                    {
                        offer: offerTrimmed,
                        want: wantTrimmed,
                        description: payload.description,
                        modality: payload.modality,
                        radius: (payload as any).radius,
                        location: (payload as any).location,
                        offerVector,
                        wantVector,
                        user: userId,
                    },
                ],
                { session }
            );
            created = doc;
            countAfterCreate = countNow + 1;
        });
    } catch (error: unknown) {
        // Anti-race net: a concurrent double submit passes the pre-check and hits
        // the partial unique index (E11000); map it to the friendly CONFLICT.
        if ((error as { code?: number })?.code === 11000) {
            throw new AppError(httpStatus.CONFLICT, DUPLICATE_BOND_MESSAGE);
        }
        throw error;
    } finally {
        await session.endSession();
    }

    // Robot: precompute this new bond's matches (does not block the response).
    enqueueRecompute(created._id.toString(), MATCH_PRIORITY_USER);

    // Upsell nudge when the plan cap is reached (25 Free / 100 Standard), not on
    // Premium (no higher tier). Best-effort: must not break bond creation.
    // Fires EVERY time the cap is hit: `subscriptionNudgeAt` is cleared on delete,
    // so a user who frees space and refills gets nudged again (it used to fire once
    // per `bondLimit` value and never again).
    try {
        const limit = user.bondLimit ?? 25;
        const isTopTier =
            user.subscriptionType === ENUM_SUBSCRIPTION_TYPE.Premium;
        if (
            !isTopTier &&
            countAfterCreate >= limit &&
            user.subscriptionNudgeAt !== limit
        ) {
            await NormalUser.updateOne(
                { _id: userId },
                { $set: { subscriptionNudgeAt: limit } }
            );
            await sendNotification({
                title: 'Llegaste al tope de tu plan',
                message:
                    limit >= 100
                        ? `¡Llegaste a ${limit} vínculos! Pasá a Premium y tené hasta 1000.`
                        : `¡Llegaste a ${limit} vínculos, el tope de tu plan! Pasá a Standard y tené hasta 100.`,
                receiver: userId.toString(),
                type: ENUM_NOTIFICATION_TYPE.SUBSCRIPTION,
            });
        }
    } catch {
        /* best-effort: the nudge must not break bond creation */
    }

    return created;
};

const getLastBond = async (userId: string) => {
    // Soft-deleted bonds don't count as "last bond": the user already removed them.
    return await BondRequest.findOne({ user: userId, isDeleted: { $ne: true } })
        .sort({ createdAt: -1 })
        .select('offer want location');
};

const getAllBondRequests = async (query: Record<string, unknown>) => {
    // Security: never expose embedding vectors or exact coordinates. Old code
    // returned the full doc (a dump of the matching dataset). Side note: search
    // used nonexistent 'give'/'get' fields, fixed to 'offer'/'want'.
    const resultQuery = new QueryBuilder(
        BondRequest.find({ isDeleted: { $ne: true } }).select(
            '-offerVector -wantVector -location'
        ),
        query
    )
        .search(['offer', 'want'])
        .fields()
        .filter()
        .paginate()
        .sort();

    const result = await resultQuery.modelQuery;
    const meta = await resultQuery.countTotal();

    return {
        meta,
        result,
    };
};
const myBondRequests = async (
    userId: string,
    query: Record<string, unknown>
) => {
    const resultQuery = new QueryBuilder(
        // `isDeleted` is redundant with `isLinked:false` (soft-delete sets both),
        // but this is the user's own list: a changed delete marker must never
        // let a removed bond reappear.
        BondRequest.find({
            user: userId,
            isLinked: false,
            isDeleted: { $ne: true },
        }).select('-offerVector -wantVector'),
        query
    )
        .search(['offer', 'want', 'location'])
        .fields()
        .filter()
        .paginate()
        .sort();

    const result = await resultQuery.modelQuery;
    const meta = await resultQuery.countTotal();

    return {
        meta,
        result,
    };
};

const getSingleBondRequest = async (id: string, viewerId?: string) => {
    // Security: no embedding vectors nor exact coordinates (same as the list endpoints).
    const bondRequest = await BondRequest.findById(id).select(
        '-offerVector -wantVector -location'
    );
    if (!bondRequest)
        throw new AppError(httpStatus.NOT_FOUND, 'BondRequest not found');
    // Visibility: by id only an active, available bond is visible (or the owner's own).
    const isOwner =
        !!viewerId && bondRequest.user?.toString() === viewerId.toString();
    const isVisible =
        !bondRequest.isPause &&
        bondRequest.isLinked !== true &&
        (bondRequest.status === ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK ||
            bondRequest.status === ENUM_BOND_REQUEST_STATUS.ONGOING);
    if (!isOwner && !isVisible) {
        throw new AppError(httpStatus.NOT_FOUND, 'BondRequest not found');
    }
    return bondRequest;
};

const updateBondRequestIntoDB = async (
    userId: string,
    id: string,
    payload: Partial<IBondRequest>
) => {
    const bondRequest = await BondRequest.findOne({ _id: id, user: userId });
    if (!bondRequest)
        throw new AppError(httpStatus.NOT_FOUND, 'BondRequest not found');

    // Editing a bond's CONTENT is forbidden by product; only pause/resume is
    // allowed here (the one switch that removes it from the matching pool).
    // Blocking per FIELD, not per route: a 403 on the whole route broke the
    // front's pause button, which calls this endpoint. The allowlist below still
    // handles mass-assignment.
    const CAMPOS_DE_CONTENIDO = [
        'offer',
        'want',
        'description',
        'location',
        'radius',
        'modality',
    ];
    const intentaEditarContenido = CAMPOS_DE_CONTENIDO.some(
        (k) => (payload as Record<string, unknown>)[k] !== undefined
    );
    if (intentaEditarContenido) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'La edición de vínculos está deshabilitada.'
        );
    }

    // Batched censorship (same optimization as create): one call, per-field verdicts.
    // A description-only edit is now filtered too (it used to slip through).
    const toCheck: { label: string; text: string }[] = [];
    if (payload.offer) toCheck.push({ label: 'Offer', text: payload.offer });
    if (payload.want) toCheck.push({ label: 'Want', text: payload.want });
    if (payload.description)
        toCheck.push({ label: 'Description', text: payload.description });
    if (toCheck.length) {
        const verdicts = await isTextSafeBatch(toCheck.map((c) => c.text));
        toCheck.forEach((c, i) => {
            assertTextAllowed(verdicts[i], c.label);
        });
    }

    // Mass-assignment: allowlist only. `findByIdAndUpdate(...payload)` let users
    // inject status/isLinked/vectors/user/matchesComputedAt and poison matching
    // with fabricated vectors. Embeddings are recomputed here from the text.
    const ALLOWED_UPDATE_FIELDS = [
        'offer',
        'want',
        'description',
        'location',
        'radius',
        'modality',
        'isPause',
    ];
    const safePayload: Partial<IBondRequest> = {};
    for (const k of ALLOWED_UPDATE_FIELDS) {
        if ((payload as any)[k] !== undefined) {
            (safePayload as any)[k] = (payload as any)[k];
        }
    }

    // Normalized duplicate check (same as create): the unique index is exact-string,
    // so compare the FINAL offer/want (new or existing), excluding this bond.
    if (safePayload.offer !== undefined || safePayload.want !== undefined) {
        const finalOffer = (safePayload.offer ?? bondRequest.offer ?? '').trim();
        const finalWant = (safePayload.want ?? bondRequest.want ?? '').trim();
        const dup = await BondRequest.findOne({
            _id: { $ne: id },
            user: userId,
            status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
            isLinked: { $ne: true },
            offer: new RegExp(`^${escapeRegex(finalOffer)}$`, 'i'),
            want: new RegExp(`^${escapeRegex(finalWant)}$`, 'i'),
        })
            .select('_id')
            .lean();
        if (dup) {
            throw new AppError(httpStatus.CONFLICT, DUPLICATE_BOND_MESSAGE);
        }
    }

    let updated;
    if (safePayload.offer && safePayload.want) {
        const [offerVector, wantVector] = await Promise.all([
            generateEmbedding(safePayload.offer),
            generateEmbedding(safePayload.want),
        ]);

        updated = await BondRequest.findByIdAndUpdate(
            id,
            { ...safePayload, offerVector, wantVector },
            { new: true }
        );
    } else if (safePayload.offer) {
        const offerVector = await generateEmbedding(safePayload.offer);
        updated = await BondRequest.findByIdAndUpdate(
            id,
            { ...safePayload, offerVector },
            { new: true }
        );
    } else if (safePayload.want) {
        const wantVector = await generateEmbedding(safePayload.want);
        updated = await BondRequest.findByIdAndUpdate(
            id,
            { ...safePayload, wantVector },
            { new: true }
        );
    } else {
        updated = await BondRequest.findByIdAndUpdate(id, safePayload, {
            new: true,
        });
    }

    // Robot: content/state changed → invalidate cache and recompute (fire-and-forget).
    const active =
        !!updated &&
        !updated.isPause &&
        updated.status === ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK;
    invalidateAndRefresh(id, active).catch(() => undefined);

    // Of the editable fields, only `isPause` affects liveness (`status` and
    // `isLinked` are not in ALLOWED_UPDATE_FIELDS).
    if (safePayload.isPause !== undefined) {
        await recalcularVinculosVivos(userId);
    }

    return updated;
};

const deleteBondRequestFromDB = async (userId: string, id: string) => {
    // The shared transaction guard prevents a link from referencing a concurrently deleted bond.
    // Completed history is soft-deleted; canceled-only/unreferenced bonds retain hard-delete behavior.
    const result = await createBondIntegrity({
        bonds: BondRequest, links: BondLink, conversations: Conversation,
        startSession: () => mongoose.startSession(),
    }).deleteBond(userId, id);

    // Rearm the subscription nudge: deleting is the only way quota drops, so the
    // `$unset` lets the nudge fire again the next time the cap is reached.
    // Best-effort on purpose: it must not fail the delete.
    NormalUser.updateOne(
        { _id: userId },
        { $unset: { subscriptionNudgeAt: '' } }
    ).catch(() => undefined);

    // Robot: drop this bond's cache and refresh the affected bonds.
    invalidateAndRefresh(id, false).catch(() => undefined);

    // Soft or hard delete: this may have been the user's last live bond.
    await recalcularVinculosVivos(userId);

    return result;
};

export const cosineSimilarity = (a: number[], b: number[]): number => {
    if (!Array.isArray(a) || !Array.isArray(b)) return 0;
    const minLen = Math.min(a.length, b.length);
    let dot = 0,
        magA = 0,
        magB = 0;
    for (let i = 0; i < minLen; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);
    if (!magA || !magB) return 0;
    return dot / (magA * magB);
};

export const normalizeText = (s?: string) =>
    (s || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

export const tokenOverlapRatio = (a?: string, b?: string): number => {
    const A = normalizeText(a).split(' ').filter(Boolean);
    const B = normalizeText(b).split(' ').filter(Boolean);
    if (!A.length || !B.length) return 0;
    const setB = new Set(B);
    const overlap = A.filter((t) => setB.has(t)).length;
    return overlap / Math.min(A.length, B.length);
};

export const calculateMatchScore = (
    wantVec: number[] = [],
    offerVec: number[] = []
): number => {
    const sim = cosineSimilarity(wantVec, offerVec);

    return sim;
};


type MatchType = 'entry' | 'surprise' | 'empty';

/** Shadow feed-vs-legacy comparison: sampled and run after serving, so the
 *  chosen path never waits for it. Measures top-N overlap. */
const shadowCompareMatches = async (
    bondRequestId: string,
    served: any[],
    servedMode: 'feed' | 'legacy'
): Promise<void> => {
    const other =
        servedMode === 'feed'
            ? await BondMatch.find({ bonds: bondRequestId })
                  .select('bonds score')
                  .sort({ size: 1, score: -1, _id: 1 })
                  .lean()
            : await BondMatchFeed.find({ bond: bondRequestId })
                  .sort({ score: -1, _id: 1 })
                  .limit(MATCHING.feedScanLimit)
                  .lean();

    const servedSet = new Set(topMatchKeys(served, MATCHING.maxResults));
    const otherSet = new Set(topMatchKeys(other as any[], MATCHING.maxResults));
    let inter = 0;
    for (const k of servedSet) if (otherSet.has(k)) inter++;
    const union = servedSet.size + otherSet.size - inter;
    const jaccard = union === 0 ? 1 : inter / union;

    bondMatchShadowJaccard.observe(jaccard);
    if (jaccard < 0.99) {
        bondMatchShadowDiffTotal.inc({ result: 'diff' });
        logger.warn(
            `[matching][shadow] ${bondRequestId} mode=${servedMode} jaccard=${jaccard.toFixed(3)} ` +
                `onlyServed=${[...servedSet].filter((k) => !otherSet.has(k)).length} ` +
                `onlyOther=${[...otherSet].filter((k) => !servedSet.has(k)).length}`
        );
    } else {
        bondMatchShadowDiffTotal.inc({ result: 'same' });
    }
};

export const getMatchingBondRequest = async (
    userId: string,
    bondRequestId: string,
    query: Record<string, unknown>
) => {
    // F3.6 (defensive): clamp page/limit. A negative `?page=` made startIndex
    // negative and `.slice()` counted from the END. Uses the shared helper
    // ([1,500]) instead of a hand-rolled clamp that let `?page=1e999` through.
    // Serving only: never affects matching.
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit, 10, 500);

    const normalize = (s?: string) => normalizeText(s);

    const startRequest = await BondRequest.findOne({
        _id: bondRequestId,
        user: userId,
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        // A soft-deleted bond must not come back here: the soft-delete sets
        // `isPause: true` and this function un-pauses the bond below, partially
        // resurrecting deleted bonds.
        isDeleted: { $ne: true },
    })
        .select(
            'matchesComputedAt matchesComputeRevision matchesNextAt lastServedAt isPause'
        )
        .lean();

    if (!startRequest) throw new AppError(404, 'Bond request not found');

    // Reactivate on search: hitting "find matches" on a paused bond signals
    // interest → un-pause it (back in the pool) and tell the front (reactivated).
    let reactivated = false;
    if ((startRequest as any).isPause) {
        // Also clear matchesComputedAt (a paused bond can have an empty cache with a
        // recent timestamp → false 'ready 0'), and expire the schedule: since the
        // adaptive TTL the sweep reads `matchesNextAt`, so clearing the timestamp
        // alone leaves the bond active, uncached and unscheduled (front polls for a
        // whole day). `invalidateAndRefresh` expires both fields together.
        await BondRequest.updateOne(
            { _id: bondRequestId, user: userId },
            {
                $set: { isPause: false, matchesNextAt: agendaVencida() },
                $unset: { matchesComputedAt: '' },
            }
        );
        (startRequest as any).isPause = false;
        (startRequest as any).matchesComputedAt = undefined;
        (startRequest as any).matchesNextAt = agendaVencida();
        reactivated = true;
        // Un-paused: the owner has a live bond again.
        await recalcularVinculosVivos(userId);
    }

    // Precomputed matches: this request is a plain READ; the robot keeps the cache warm.
    // FEED mode (MATCH_FEED_READ): top N rows of this bond's feed via the index,
    // ~150 KB instead of the whole `{ bonds: id }` superset (~4 MB); the rest of the
    // pipeline is identical. LEGACY mode is kept for rollback.
    const lecturaInicio = Date.now();
    let cached: any[];
    if (MATCHING.feedRead) {
        cached = await BondMatchFeed.find({ bond: bondRequestId,
            computedAt: { $gt: new Date(Date.now() - MATCHING.serveTtlMinutes * 60000) },
        })
            .sort({ computeRevision: -1, score: -1, _id: 1 })
            .limit(MATCHING.feedScanLimit)
            // Otherwise the driver fetches 101 docs then issues a getMore:
            // ~400 ms extra RTT on remote Atlas.
            .batchSize(MATCHING.feedScanLimit)
            .lean();
        bondMatchFeedRowsScanned.observe(cached.length);
    } else {
        cached = await BondMatch.find({ bonds: bondRequestId })
            .sort({ size: 1, score: -1, _id: 1 })
            .lean();
    }
    bondMatchServeDuration.observe(
        { mode: MATCHING.feedRead ? 'feed' : 'legacy' },
        (Date.now() - lecturaInicio) / 1000
    );
    const settings = await getMatchingSettings();

    // Real-interest signal: opening this screen is what keeps the bond HOT (1 h TTL
    // instead of 24 h). Guard 1: `timestamps: false` — otherwise the write bumps
    // `updatedAt`, which feeds `freshnessFactor` (0.1 of the score), so leaving the
    // screen open boosted your ranking for everyone (the front polls every 3 s).
    // Guard 2: throttle to one stamp every 5 min (the signal only needs a 72 h window)
    // instead of writing on every poll and page click. Fire-and-forget, placed before
    // the early return so bonds with nothing to show also get stamped.
    const servidoAntes = (startRequest as any)?.lastServedAt;
    const refrescoServidoMs =
        Math.max(Number(process.env.MATCH_SERVED_STAMP_MINUTES) || 5, 1) *
        60 *
        1000;
    if (
        !servidoAntes ||
        Date.now() - new Date(servidoAntes).getTime() > refrescoServidoMs
    ) {
        BondRequest.updateOne(
            { _id: bondRequestId },
            { $set: { lastServedAt: new Date() } },
            { timestamps: false }
        ).catch(() => undefined);
    }

    const selected = selectMatchingCache(cached, {
        computeRevision: settings.computeRevision,
        cacheTtlMinutes: settings.cacheTtlMinutes,
        serveTtlMinutes: MATCHING.serveTtlMinutes,
    }, startRequest);
    if (selected.shouldRefresh) enqueueRecompute(bondRequestId, MATCH_PRIORITY_USER);
    if (!selected.records.length) {
        const status = selected.shouldRefresh ? 'computing' : 'ready';
        bondMatchStatusTotal.inc({ status });
        return { status, reactivated, total: 0, page, limit, data: [] as any[] };
    }
    const records: any[] = selected.records;

    const matches: {
        ids: string[];
        users: string[];
        score: number;
        type: MatchType;
        parts: IMatchScoreParts;
    }[] = records.map((r: any) => ({
        ids: (r.bonds ?? r.ids).map((id: any) => id.toString()),
        // Owners are already stored per BondMatch → block filtering without populating.
        users: (r.users ?? []).map((id: any) => id.toString()),
        score: r.score,
        type: r.type as MatchType,
        // `parts` comes from the cache (BondMatch) or the on-the-fly compute; kept to
        // expose the "why you matched" breakdown. Defensive fallback if missing.
        parts: (r.parts ?? {
            sem: 0,
            rep: 0,
            prox: 0,
            fresh: 0,
        }) as IMatchScoreParts,
    }));

    // F3.3 — Backfill owners on LEGACY BondMatch docs. Old docs may have empty
    // `users`, which makes the block filter below always false and lets blocked
    // users through. One light query, run only if such docs exist, using the same
    // id space as the p2p/admin filters (`BondRequest.user` → `NormalUser`).
    const matchesSinDuenos = matches.filter((m) => m.users.length === 0);
    if (matchesSinDuenos.length > 0) {
        const bondIdsSinDueno = [
            ...new Set(matchesSinDuenos.flatMap((m) => m.ids)),
        ];
        const duenoDocs = await BondRequest.find({
            _id: { $in: bondIdsSinDueno },
        })
            .select('_id user')
            .lean();
        const duenoPorBond = new Map<string, string | undefined>(
            duenoDocs.map(
                (d: any): [string, string | undefined] => [
                    d._id.toString(),
                    d.user?.toString(),
                ]
            )
        );
        for (const m of matchesSinDuenos) {
            m.users = [
                ...new Set(
                    m.ids
                        .map((id) => duenoPorBond.get(id))
                        .filter((u): u is string => !!u)
                ),
            ];
        }
    }

    // Blocking (B.4 + C.5): filter over the full set before paginating so total and
    // pages stay correct, using the owners each BondMatch already stores (no need to
    // populate the bonds). Only the served page is populated later — populating every
    // bond of every match on each request was what made paging slow.
    //  - P2P (B.4): users blocked by/for the viewer (1 query).
    //  - Admin (C.5): owners with User.isBlocked === true (1 light query).
    const p2pBlockedIds = new Set(await getBlockedIdsFor(userId));
    const allOwners = [...new Set(matches.flatMap((m) => m.users))];
    const adminBlockedOwners = new Set<string>();
    if (allOwners.length > 0) {
        const owners = await NormalUser.find({ _id: { $in: allOwners } })
            .select('user')
            .populate({ path: 'user', select: 'isBlocked' })
            .lean();
        for (const o of owners as any[]) {
            if (o?.user?.isBlocked === true) {
                adminBlockedOwners.add(o._id.toString());
            }
        }
    }

    if (p2pBlockedIds.size > 0 || adminBlockedOwners.size > 0) {
        for (let i = matches.length - 1; i >= 0; i--) {
            const blocked = matches[i].users.some(
                (u) => p2pBlockedIds.has(u) || adminBlockedOwners.has(u)
            );
            if (blocked) matches.splice(i, 1);
        }
    }

    // Ghost / unavailable matches: the cache may hold deals whose other bonds are
    // gone (deleted → dangling id rendered as an empty match) or paused (rendered as
    // available). A match is valid only if all OTHER participants still exist and are
    // navigable. Filtered before counting/paging so `total` stays coherent; costs one
    // light `_id`-only query and populates nothing.
    const otherIds = [
        ...new Set(
            matches.flatMap((m) => m.ids).filter((id) => id !== bondRequestId)
        ),
    ];
    if (otherIds.length > 0) {
        const liveDocs = await BondRequest.find({
            _id: { $in: otherIds },
            status: {
                $in: [
                    ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
                    ENUM_BOND_REQUEST_STATUS.ONGOING,
                ],
            },
            isPause: false,
        })
            .select('_id')
            .lean();
        const liveSet = new Set(liveDocs.map((d) => d._id.toString()));
        for (let i = matches.length - 1; i >= 0; i--) {
            const allLive = matches[i].ids
                .filter((id) => id !== bondRequestId)
                .every((id) => liveSet.has(id));
            if (!allLive) matches.splice(i, 1);
        }
    }

    // Defensive dedup by participant SET (same bonds, any order): the cache may hold
    // a cycle and its reverse. Keep the highest score so the user never sees the same
    // match twice and `total` reflects reality (covers already-persisted rows).
    const bestBySet = new Map<string, (typeof matches)[number]>();
    for (const m of matches) {
        const key = [...m.ids].sort().join('|');
        const prev = bestBySet.get(key);
        if (!prev || m.score > prev.score) bestBySet.set(key, m);
    }
    if (bestBySet.size !== matches.length) {
        const deduped = [...bestBySet.values()];
        matches.length = 0;
        matches.push(...deduped);
    }

    //  ORDER. New default: by SCORE. `pairBias` is a SOFT preference for short
    //  chains (size 2 = 0, 3 = -pairBias, 4 = -2·pairBias, ...), a subtraction from
    //  the ranking, not an override: a much better cycle still beats a pair. Applied
    //  at serving, so tuning `pairBias` needs no recompute — just an API restart.
    //  LEGACY switch: hard size→type→score order.
    const typePriority: Record<MatchType, number> = {
        entry: 1,
        surprise: 2,
        empty: 3,
    };
    const legacy = MATCHING.legacyRanking;
    const rankScore = (m: (typeof matches)[number]) =>
        m.score - (legacy ? 0 : settings.pairBias * (m.ids.length - 2));

    matches.sort((a, b) => {
        if (legacy) {
            if (a.ids.length !== b.ids.length) {
                return a.ids.length - b.ids.length;
            }
            if (a.type !== b.type) {
                return typePriority[a.type] - typePriority[b.type];
            }
        }
        const ra = rankScore(a);
        const rb = rankScore(b);
        if (ra !== rb) {
            return rb - ra;
        }
        // STABLE tiebreak on the bond combination (unique per match): without it,
        // exact score ties could reorder between pages → a match duplicated on one
        // page and missing from another.
        return a.ids.join('-').localeCompare(b.ids.join('-'));
    });

    // Serve cap: matching is a bounded RANKING, not a catalog. Serving by `bonds`
    // merges chains from many sourceBonds (hundreds of them), so keep only the best
    // `maxResults` above `minServeScore` on the final score (both dashboard dials).
    // `matches` is already ranked desc, so filter+cut preserves order and `total` is
    // the capped set (never more than ceil(maxResults/limit) pages).
    const served = matches
        .filter((m) => m.score >= settings.minServeScore)
        .slice(0, settings.maxResults);

    const startIndex = (page - 1) * limit;
    const pageMatches = served.slice(startIndex, startIndex + limit);

    // ROTATION: a match may be stored under the counterpart's sourceBond, so the
    // bond being viewed can sit anywhere in the chain. Rotate the cycle cyclically so
    // YOUR bond is always first. It is a rotation (not a reorder): cycle order is
    // preserved, so prev/next and the swap colors stay correct. `users` rotates too
    // to stay aligned with `ids`.
    for (const m of pageMatches) {
        const pos = m.ids.indexOf(bondRequestId);
        if (pos > 0) {
            m.ids = [...m.ids.slice(pos), ...m.ids.slice(0, pos)];
            if (Array.isArray(m.users) && m.users.length === m.ids.length) {
                m.users = [...m.users.slice(pos), ...m.users.slice(0, pos)];
            }
        }
    }

    // Perf: populate only THIS page's bonds, so per-page cost stops scaling with the
    // total match count and becomes ~constant.
    const pageIds = [...new Set(pageMatches.flatMap((m) => m.ids))];
    const populated = await BondRequest.find({ _id: { $in: pageIds } })
        // Query whitelist (defense in depth): only offer, want and user. The old
        // `.select('-wantVector -offerVector')` did not exclude `location`, so the
        // `{...request}` below leaked each counterpart's exact GPS coordinates.
        // Output also goes through `publicMatchRequest`.
        .select('offer want user')
        // `reputation` must be selected: the card shows the star rating, and without
        // it the front read a nonexistent field (`avgRating`) and always showed "⭐ 0".
        .populate({ path: 'user', select: 'name profile_image reputation' })
        .lean();
    const populatedMap = new Map(
        populated.map((r) => [r._id.toString(), r])
    );

    const result = pageMatches.map((m) => {
        const cycleSize = m.ids.length;

        const colors = COLOR_PALETTE;

        const matchRequestsWithColors = m.ids.map((id, index) => {
            const request = populatedMap.get(id);
            if (!request) return null;

            const currentWant = normalize(request.want);
            const currentOffer = normalize(request.offer);

            const prevIndex = (index - 1 + cycleSize) % cycleSize;
            const nextIndex = (index + 1) % cycleSize;
            const prevWant = normalize(populatedMap.get(m.ids[prevIndex])?.want);
            const nextOffer = normalize(
                populatedMap.get(m.ids[nextIndex])?.offer
            );

            // Color rule: each box belongs to ONE pair — i's OFFER matches i-1's WANT
            // and i's WANT is matched by i+1's OFFER. `specialEntryColor` gives the
            // per-pair color (empty↔surprise violet, empty↔empty coral,
            // surprise↔surprise fuchsia, else palette pastel). Modulo: the cycle can
            // reach 6 and the palette has 5 colors.
            const wantColor =
                specialEntryColor(currentWant, nextOffer) ??
                colors[index % colors.length];
            const offerColor =
                specialEntryColor(currentOffer, prevWant) ??
                colors[prevIndex % colors.length];

            // `publicMatchRequest`: output whitelist (identity + offer/want + bounded
            // user). Pair colors are added here (they don't live in the doc).
            return {
                ...publicMatchRequest(request),
                offerColor,
                wantColor,
            };
        });

        const round3 = (n: number) => Number((n ?? 0).toFixed(3));

        // "Double empty" flag: ALL participants offer and want empty → the UI shows
        // the "still talking?" message.
        const isFullEmpty =
            cycleSize > 0 &&
            m.ids.every((id) => {
                const r = populatedMap.get(id);
                return isEmptyToken(r?.offer) && isEmptyToken(r?.want);
            });

        return {
            matchRequest: matchRequestsWithColors,
            matchScore: Number(m.score.toFixed(3)),
            type: m.type,
            isFullEmpty,
            size: m.ids.length,
            // Score breakdown for the UI "why you matched".
            scoreParts: {
                sem: round3(m.parts.sem),
                rep: round3(m.parts.rep),
                prox: round3(m.parts.prox),
                fresh: round3(m.parts.fresh),
            },
        };
    });

    // Sampled shadow comparison of feed vs legacy AFTER serving: never affects the
    // response nor the user's wait.
    if (MATCHING.feedShadow && Math.random() < MATCHING.feedShadowSample) {
        void shadowCompareMatches(
            bondRequestId,
            cached,
            MATCHING.feedRead ? 'feed' : 'legacy'
        ).catch((e) =>
            logger.warn(`[matching][shadow] fallo: ${(e as Error)?.message}`)
        );
    }

    bondMatchStatusTotal.inc({ status: 'ready' });

    return {
        // Fresh cache served: computation is done.
        status: 'ready',
        reactivated,
        // Real number of SERVED matches (capped at 100 and above threshold), coherent
        // with pagination → the front never shows more than ceil(100/limit) pages.
        total: served.length,
        page,
        limit,
        data: result,
    };
};

// Public bonds of a user for the "People"/profile cards. Only live, navigable
// bonds (WAITING_FOR_LINK or ONGOING, not paused); embedding vectors excluded by
// an inclusion projection.
const getBondRequestsByUser = async (
    userId: string,
    viewerId?: string,
    searchTerm?: string,
    pageArg?: unknown,
    limitArg?: unknown
) => {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }

    // Pagination: 10 per page by default; page >= 1 and limit capped to [1,50]. Same
    // shared helper as elsewhere — the hand-rolled clamp let `?page=1e999` through as
    // Infinity and, since this endpoint uses `.skip()`, that was a 500.
    const page = clampPage(pageArg);
    const limit = clampLimit(limitArg, 10, 50);
    const skip = (page - 1) * limit;

    const isOwner = !!viewerId && viewerId.toString() === userId.toString();

    const filter: Record<string, unknown> = {
        user: userId,
        status: {
            $in: [
                ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
                ENUM_BOND_REQUEST_STATUS.ONGOING,
            ],
        },
        isPause: false,
        // A soft-deleted bond is not listed on the profile nor in the cards.
        isDeleted: { $ne: true },
    };

    const target = await NormalUser.findById(userId)
        .select('bondsPublic')
        .lean();
    const bondsPublic = target ? (target as any).bondsPublic !== false : true;

    // Blocks FIRST: a blocked viewer must get neither the bonds nor the count. It must
    // run before the privacy branch, which otherwise leaked the real count.
    if (viewerId && !isOwner) {
        const blockedIds = await getBlockedIdsFor(viewerId);
        if (blockedIds.includes(userId)) {
            return { bondsPublic, count: 0, bonds: [], page, limit };
        }
    }

    // Privacy: hiding must really hide in discovery. If the owner hid their bonds and
    // the viewer is not the owner, send only the flag and the count. Matching is
    // unaffected: the engine ignores `bondsPublic`, so hidden bonds still match.
    if (!bondsPublic && !isOwner) {
        const count = await BondRequest.countDocuments(filter);
        return { bondsPublic, count, bonds: [], page, limit };
    }

    // In-profile search over offer/want/description, accent- and case-insensitive.
    // With a term it searches ALL of the user's bonds, not just the newest 20.
    const term = typeof searchTerm === 'string' ? searchTerm.trim() : '';
    if (term) {
        const rx = buildLooseRegex(term);
        filter.$or = [{ offer: rx }, { want: rx }, { description: rx }];
    }

    const count = await BondRequest.countDocuments(filter);

    const bonds = await BondRequest.find(filter)
        // Privacy: never expose `location` (coordinates), only offer/want/modality.
        .select('offer want description modality radius status createdAt')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

    return { bondsPublic, count, bonds, page, limit };
};

/* Visible plan quota: bonds used and remaining. Uses the same FILTRO_CUPO_VINCULOS
 * as create, so the shown number cannot diverge from the 403 check. Unlike
 * `myBondRequests`, linked bonds still consume quota; only deleting frees it. */
const getBondQuota = async (userId: string) => {
    const [user, used] = await Promise.all([
        NormalUser.findById(userId).select('bondLimit'),
        BondRequest.countDocuments({ user: userId, ...FILTRO_CUPO_VINCULOS }),
    ]);

    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    const limit = user.bondLimit ?? 25;

    return {
        used,
        limit,
        remaining: Math.max(0, limit - used),
    };
};

const bondRequestService = {
    createBondRequestIntoDB,
    getBondRequestsByUser,
    getAllBondRequests,
    getSingleBondRequest,
    updateBondRequestIntoDB,
    deleteBondRequestFromDB,
    myBondRequests,
    getBondQuota,
    getMatchingBondRequest,
    getLastBond,
};

export default bondRequestService;
