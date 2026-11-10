/* eslint-disable @typescript-eslint/no-explicit-any */
import paypal from '@paypal/checkout-server-sdk';
import { clampLimit, clampPage } from '../../utilities/pagination';
import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import config from '../../config';
import AppError from '../../error/appError';
import { isTextSafe, assertTextAllowed } from '../../helper/isTextSafe';
import { createSubscriptionPreference } from '../../mercadopago/mercadopago.service';
import { getDollarRate } from '../../mercadopago/dollarRate';
import { esObjectIdUsable } from '../../utilities/objectId';
import { filtrarOnline, muestraOnline } from '../../socket/presence';
import { ENUM_PAYMENT_PURPOSE } from '../../utilities/enum';
import paypalClient from '../../utilities/paypal';
import { bayesianReputation } from '../bondRequest/matching.scoring';
import { ENUM_BOND_REQUEST_STATUS } from '../bondRequest/bondRequest.enum';
import BondRequest from '../bondRequest/bondRequest.model';
import BondRating from '../bondRating/bondRating.model';
import { ENUM_FRIEND_REQUEST_STATUS } from '../friendRequest/friendRequest.enum';
import FriendRequest from '../friendRequest/friendRequest.model';
import { Skill } from '../skill/skill.model';
import { USER_ROLE } from '../user/user.constant';
import {
    getBlockedIdsFor,
    getBlockedObjectIdsFor,
} from '../userBlock/userBlock.service';
import { ENUM_SUBSCRIPTION_TYPE } from './normalUser.enum';
import {
    esTipoPlan,
    nivelDe,
    PLANES,
    type TipoPlan,
} from './subscriptionPlans';
import {
    construirFiltroClaim,
    esCheckoutReutilizable,
    normalizarProveedor,
} from './subscriptionCheckout';
import { INormalUser } from './normalUser.interface';
import NormalUser from './normalUser.model';
import { User } from '../user/user.model';

// Escape regex metacharacters from user-supplied search terms.
const escapeRegex = (input: string): string =>
    input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Accent/case-insensitive substring search: pure normalization, no AI.
// e.g. "filosofia" also matches "Filosofía" and "FILOSOFIA".
const DIACRITIC_CLASSES: Record<string, string> = {
    a: '[aàáâãäå]',
    e: '[eèéêë]',
    i: '[iìíîï]',
    o: '[oòóôõö]',
    u: '[uùúûü]',
    n: '[nñ]',
    c: '[cç]',
};
// Exported: bondRequest.service reuses the same matching criteria.
export const buildLooseRegex = (term: string): RegExp => {
    const stripped = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const escaped = escapeRegex(stripped);
    const pattern = escaped.replace(
        /[aeiounc]/gi,
        (ch) => DIACRITIC_CLASSES[ch.toLowerCase()] ?? ch
    );
    return new RegExp(pattern, 'i');
};

// Great-circle distance (km) between GeoJSON [lng, lat] points. Local copy: the
// matching helper is not exported. Only feeds `distanceKm` in "near" mode.
const haversineKm = (a?: number[], b?: number[]): number | undefined => {
    if (!a || !b || a.length < 2 || b.length < 2) return undefined;
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

// Whitelist for self-editing; prevents mass-assignment of subscriptionType,
// bondLimit, reputation, user, email, role, etc.
const PROFILE_EDITABLE_FIELDS: (keyof INormalUser)[] = [
    'name',
    'phone',
    'profile_image',
    'cover_image',
    'gender',
    'dateOfBirth',
    'address',
    'bio',
    'skills',
    'socialLinks',
];

// PII/internal fields hidden when a user views someone else's profile.
// `address` is kept: it is the city shown on Personas/public cards.
const PRIVATE_USER_FIELDS = [
    // Internal featured ordering key; also leaks whether a hidden user has bonds.
    'hasActiveBonds',
    'email',
    'phone',
    'dateOfBirth',
    'subscriptionType',
    'bondLimit',
    // Checkout URL embeds the user id (custom_id / external_reference).
    'pendingSubscriptionCheckout',
    'bondSeq',
    'digestOptOut',
    'mutedNotificationCategories',
    'locationUpdatedAt',
    'locationMode',
    // Admin audit trail: internal, and the reason may mention disputes.
    'subscriptionSetBy',
    'subscriptionSetAt',
    'subscriptionSetReason',
    'subscriptionHistory',
];
// Must match the `personas_destacados` index (normalUser.model.ts).
const ORDEN_DESTACADOS: Record<string, 1 | -1> = {
    hasActiveBonds: -1,
    'reputation.score': -1,
    updatedAt: -1,
    _id: 1,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stripPrivateUserFields = (obj: any) => {
    if (!obj) return obj;
    for (const f of PRIVATE_USER_FIELDS) delete obj[f];
    return obj;
};

const updateUserProfile = async (id: string, payload: Partial<INormalUser>) => {
    if (payload.email) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'You can not change the email'
        );
    }
    const user = await NormalUser.findById(id);
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'Profile not found');
    }

    // Whitelist: drop any non-editable payload field.
    const safeUpdate: Partial<INormalUser> = {};
    for (const key of PROFILE_EDITABLE_FIELDS) {
        if (payload[key] !== undefined) {
            (safeUpdate as Record<string, unknown>)[key] = payload[key];
        }
    }

    // Bio is moderated before saving with the full layer (hard list + free
    // moderation + gpt-4o-mini intent). Fails closed (retryable) on errors.
    if (typeof safeUpdate.bio === 'string' && safeUpdate.bio.trim()) {
        const bioCheck = await isTextSafe(safeUpdate.bio);
        assertTextAllowed(bioCheck, 'Bio');
    }

    const result = await NormalUser.findByIdAndUpdate(id, safeUpdate, {
        new: true,
        runValidators: true,
    });
    return result;
};

const getAllUser = async (
    userData: JwtPayload,
    query: Record<string, unknown>
) => {
    if (
        userData.role == USER_ROLE.admin ||
        userData.role == USER_ROLE.superAdmin
    ) {
        const userQuery = new QueryBuilder(
            NormalUser.find().populate({ path: 'user', select: 'isBlocked' }),
            query
        )
            .search(['name'])
            .fields()
            .filter()
            .paginate()
            .sort();

        const rawResult = await userQuery.modelQuery;
        const meta = await userQuery.countTotal();
        // Privacy: never expose raw coordinates.
        const result = (rawResult as any[]).map((doc) => {
            const obj =
                typeof doc?.toObject === 'function' ? doc.toObject() : doc;
            delete obj.location;
            return obj;
        });
        return {
            meta,
            result,
        };
    } else {
        const page = clampPage(query?.page);
        const limit = clampLimit(query?.limit);
        const skip = (page - 1) * limit;
        const searchTerm =
            typeof query?.searchTerm === 'string'
                ? query.searchTerm.trim()
                : '';

        // Additive search: name, bio, skill names, and live bond offer/want/
        // description. Empty term leaves the stage {} (default listing intact).
        let searchMatchStage: any = {};
        if (searchTerm) {
            const rx = buildLooseRegex(searchTerm);

            // Two cheap indexed pre-queries in parallel: matching skill ids and
            // owners of live bonds whose content matches.
            const [skillDocs, matchedBondOwnerIds] = await Promise.all([
                Skill.find({ name: rx }).select('_id').lean(),
                BondRequest.find({
                    $or: [{ offer: rx }, { want: rx }, { description: rx }],
                    status: {
                        $in: [
                            ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
                            ENUM_BOND_REQUEST_STATUS.ONGOING,
                        ],
                    },
                    isPause: false,
                    isLinked: { $ne: true },
                }).distinct('user'),
            ]);
            const matchedSkillIds = skillDocs.map((s) => s._id);

            // Content discovery respects privacy: owners with hidden bonds
            // (`bondsPublic === false`) are not searchable in Personas.
            let visibleBondOwnerIds: any[] = [];
            if (matchedBondOwnerIds.length) {
                visibleBondOwnerIds = await NormalUser.find({
                    _id: { $in: matchedBondOwnerIds },
                    bondsPublic: { $ne: false },
                }).distinct('_id');
            }

            // Email is not searchable: it allowed account enumeration
            // (email → identity through name/photo presence).
            const orBranches: any[] = [{ name: rx }, { bio: rx }];
            if (matchedSkillIds.length) {
                orBranches.push({ skills: { $in: matchedSkillIds } });
            }
            if (visibleBondOwnerIds.length) {
                orBranches.push({ _id: { $in: visibleBondOwnerIds } });
            }
            searchMatchStage = { $or: orBranches };
        }

        // B.4: hide users I blocked and users who blocked me.
        const blockedIds = await getBlockedObjectIdsFor(userData.profileId);

        // online=true: sample up to PEOPLE_ONLINE_SAMPLE_MAX connected users via
        // SRANDMEMBER. A full SMEMBERS plus an equally huge $in was a hard scale
        // wall. Above the cap the listing is approximate and not page-coherent
        // (near+online stays exact, below). `||` not `??`: an empty env var gives
        // 0 and `??` would silently return exactly one user.
        const TOPE_ONLINE = Math.max(
            Number(process.env.PEOPLE_ONLINE_SAMPLE_MAX) || 2000,
            1
        );
        let onlineObjectIds: mongoose.Types.ObjectId[] | null = null;
        if (query?.online === 'true') {
            const onlineIds = await muestraOnline(TOPE_ONLINE);
            onlineObjectIds = onlineIds
                .filter((id: string) => mongoose.Types.ObjectId.isValid(id))
                .map((id: string) => new mongoose.Types.ObjectId(id));
        }

        const callerObjectId = new mongoose.Types.ObjectId(userData.profileId);

        // near=true: restrict and order by distance to the caller. Without a
        // stored location returns needsLocation:true. Coordinates never exposed.
        const isNear = query?.near === 'true';
        let nearIds: mongoose.Types.ObjectId[] | null = null;
        let distanceByUser: Map<string, number> | null = null;
        if (isNear) {
            const caller = await NormalUser.findById(userData.profileId)
                .select('location')
                .lean();
            const callerCoords = (caller as any)?.location?.coordinates as
                | number[]
                | undefined;
            if (!callerCoords || callerCoords.length < 2) {
                return {
                    meta: { page, limit, total: 0, totalPages: 0 },
                    result: [],
                    needsLocation: true,
                };
            }

            const nearDocs = await NormalUser.find({
                _id: {
                    $ne: callerObjectId,
                    ...(blockedIds.length ? { $nin: blockedIds } : {}),
                },
                // Privacy: hide users who opted out of Personas; $ne:false keeps
                // legacy docs and true visible.
                listedInPeople: { $ne: false },
                location: {
                    $near: {
                        $geometry: {
                            type: 'Point',
                            coordinates: callerCoords,
                        },
                    },
                },
            })
                .select('_id location')
                .limit(300)
                .lean();

            nearIds = (nearDocs as any[]).map(
                (d) => d._id as mongoose.Types.ObjectId
            );
            distanceByUser = new Map<string, number>();
            for (const d of nearDocs as any[]) {
                const km = haversineKm(callerCoords, d.location?.coordinates);
                if (typeof km === 'number') {
                    distanceByUser.set(
                        d._id.toString(),
                        Number(km.toFixed(1))
                    );
                }
            }
        }

        // Combine the near/online _id filters; near order is preserved.
        let idInList: mongoose.Types.ObjectId[] | null = null;
        if (nearIds && query?.online === 'true') {
            // Near+online: exact `filtrarOnline` over the in-memory neighbour
            // list. Intersecting a sample here would return a dozen random
            // neighbours, different on every refresh — noise, not approximation.
            const onlineSet = await filtrarOnline(
                nearIds.map((id) => id.toString())
            );
            idInList = nearIds.filter((id) => onlineSet.has(id.toString()));
        } else if (nearIds) {
            idInList = nearIds;
        } else if (onlineObjectIds) {
            idInList = onlineObjectIds;
        }

        // Global $sort before $facet, so $skip/$limit apply to the whole
        // ordering. No sort param → no $sort stage (default order unchanged).
        let sortStages: mongoose.PipelineStage[] = [];
        if (query?.sort === 'reputation') {
            // Missing scores sort last via the _id tiebreak.
            sortStages = [{ $sort: { 'reputation.score': -1, _id: 1 } }];
        } else if (query?.sort === 'featured') {
            // Featured: has a live bond, then reputation, then recent activity.
            // `hasActiveBonds` is precomputed (vinculosVivos.ts); computing it
            // per load was the first measured scale wall.
            sortStages = [{ $sort: ORDEN_DESTACADOS }];
        }

        // near takes precedence over sort=reputation/featured.
        if (isNear && idInList) {
            sortStages = [
                {
                    $addFields: {
                        _nearRank: { $indexOfArray: [idInList, '$_id'] },
                    },
                },
                { $sort: { _nearRank: 1 } },
                { $project: { _nearRank: 0 } },
            ];
        }

        // Per-card enrichment (friend status, skill names) runs only on the page,
        // after $limit — it used to run for every user (2s vs 0.3s at 3k users).
        const enrichStages: mongoose.PipelineStage.FacetPipelineStage[] = [
            {
                $lookup: {
                    from: 'friendrequests',
                    let: { otherUserId: '$_id' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $or: [
                                        {
                                            $and: [
                                                {
                                                    $eq: [
                                                        '$sender',
                                                        '$$otherUserId',
                                                    ],
                                                },
                                                {
                                                    $eq: [
                                                        '$receiver',
                                                        new mongoose.Types.ObjectId(
                                                            userData.profileId
                                                        ),
                                                    ],
                                                },
                                            ],
                                        },
                                        {
                                            $and: [
                                                {
                                                    $eq: [
                                                        '$receiver',
                                                        '$$otherUserId',
                                                    ],
                                                },
                                                {
                                                    $eq: [
                                                        '$sender',
                                                        new mongoose.Types.ObjectId(
                                                            userData.profileId
                                                        ),
                                                    ],
                                                },
                                            ],
                                        },
                                    ],
                                },
                            },
                        },
                    ],
                    as: 'friendRequests',
                },
            },
            {
                $addFields: {
                    friendRequestStatus: {
                        $switch: {
                            branches: [
                                {
                                    case: {
                                        $anyElementTrue: {
                                            $map: {
                                                input: '$friendRequests',
                                                as: 'req',
                                                in: {
                                                    $eq: [
                                                        '$$req.status',
                                                        ENUM_FRIEND_REQUEST_STATUS.Accepted,
                                                    ],
                                                },
                                            },
                                        },
                                    },
                                    then: 'friend',
                                },
                                {
                                    case: {
                                        $anyElementTrue: {
                                            $map: {
                                                input: '$friendRequests',
                                                as: 'req',
                                                in: {
                                                    $and: [
                                                        {
                                                            $eq: [
                                                                '$$req.sender',
                                                                new mongoose.Types.ObjectId(
                                                                    userData.profileId
                                                                ),
                                                            ],
                                                        },
                                                        {
                                                            $eq: [
                                                                '$$req.status',
                                                                ENUM_FRIEND_REQUEST_STATUS.Pending,
                                                            ],
                                                        },
                                                    ],
                                                },
                                            },
                                        },
                                    },
                                    then: 'following',
                                },
                                {
                                    case: {
                                        $anyElementTrue: {
                                            $map: {
                                                input: '$friendRequests',
                                                as: 'req',
                                                in: {
                                                    $and: [
                                                        {
                                                            $eq: [
                                                                '$$req.receiver',
                                                                new mongoose.Types.ObjectId(
                                                                    userData.profileId
                                                                ),
                                                            ],
                                                        },
                                                        {
                                                            $eq: [
                                                                '$$req.status',
                                                                ENUM_FRIEND_REQUEST_STATUS.Pending,
                                                            ],
                                                        },
                                                    ],
                                                },
                                            },
                                        },
                                    },
                                    then: 'follower',
                                },
                                {
                                    case: {
                                        $anyElementTrue: {
                                            $map: {
                                                input: '$friendRequests',
                                                as: 'req',
                                                in: {
                                                    $and: [
                                                        {
                                                            $eq: [
                                                                '$$req.sender',
                                                                new mongoose.Types.ObjectId(
                                                                    userData.profileId
                                                                ),
                                                            ],
                                                        },
                                                        {
                                                            $eq: [
                                                                '$$req.status',
                                                                ENUM_FRIEND_REQUEST_STATUS.Rejected,
                                                            ],
                                                        },
                                                    ],
                                                },
                                            },
                                        },
                                    },
                                    then: 'following',
                                },
                                {
                                    case: {
                                        $anyElementTrue: {
                                            $map: {
                                                input: '$friendRequests',
                                                as: 'req',
                                                in: {
                                                    $and: [
                                                        {
                                                            $eq: [
                                                                '$$req.receiver',
                                                                new mongoose.Types.ObjectId(
                                                                    userData.profileId
                                                                ),
                                                            ],
                                                        },
                                                        {
                                                            $eq: [
                                                                '$$req.status',
                                                                ENUM_FRIEND_REQUEST_STATUS.Rejected,
                                                            ],
                                                        },
                                                    ],
                                                },
                                            },
                                        },
                                    },
                                    then: 'follower',
                                },
                            ],
                            default: 'none',
                        },
                    },
                },
            },
            {
                $project: { friendRequests: 0 },
            },
            // Resolve skill ids to { _id, name }; no field is dropped.
            {
                $lookup: {
                    from: 'skills',
                    localField: 'skills',
                    foreignField: '_id',
                    as: 'skills',
                },
            },
            {
                $addFields: {
                    skills: {
                        $map: {
                            input: '$skills',
                            as: 'skill',
                            in: {
                                _id: '$$skill._id',
                                name: '$$skill.name',
                            },
                        },
                    },
                },
            },
        ];

        // Default Personas screen (featured, no filters): index-driven path —
        // $match → $sort on `personas_destacados` → $skip/$limit → page
        // enrichment, plus a separate countDocuments (~0.8s p95 at 30k users).
        // Admin bans are excluded with $nin on `user` (not `profileId`, which can
        // be null); a $lookup before $sort would prevent index usage.
        const destacadosPorIndice = async () => {
            const baneados = await User.distinct('_id', { isBlocked: true });
            const filtro = {
                listedInPeople: { $ne: false },
                _id: {
                    $ne: callerObjectId,
                    ...(blockedIds.length ? { $nin: blockedIds } : {}),
                },
                ...(baneados.length ? { user: { $nin: baneados } } : {}),
            };
            const [total, data] = await Promise.all([
                NormalUser.countDocuments(filtro),
                NormalUser.aggregate([
                    { $match: filtro },
                    { $sort: ORDEN_DESTACADOS },
                    { $skip: skip },
                    { $limit: limit },
                    ...enrichStages,
                ]),
            ]);
            // Same shape as the general path's $facet (falls back to default meta).
            return [
                {
                    meta: total
                        ? {
                              total,
                              page,
                              limit,
                              totalPages: Math.ceil(total / limit),
                          }
                        : undefined,
                    data,
                },
            ];
        };
        const porIndice =
            query?.sort === 'featured' &&
            !searchTerm &&
            !isNear &&
            !onlineObjectIds;

        const aggResult = porIndice
            ? await destacadosPorIndice()
            : await NormalUser.aggregate([
            {
                $match: {
                    ...searchMatchStage,
                    // Privacy: hide users who opted out of Personas; $ne:false
                    // keeps legacy docs and true visible. Does not affect matching.
                    listedInPeople: { $ne: false },
                    _id: {
                        $ne: callerObjectId,
                        ...(blockedIds.length ? { $nin: blockedIds } : {}),
                        ...(idInList ? { $in: idInList } : {}),
                    },
                },
            },
            // C.5: exclude admin-banned users (User.isBlocked), resolved via
            // NormalUser.user.
            {
                $lookup: {
                    from: 'users',
                    localField: 'user',
                    foreignField: '_id',
                    as: 'accountStatus',
                },
            },
            {
                $match: {
                    'accountStatus.isBlocked': { $ne: true },
                },
            },
            { $project: { accountStatus: 0 } },
            ...sortStages,
            {
                $facet: {
                    meta: [
                        { $count: 'total' },
                        {
                            $addFields: {
                                page,
                                limit,
                                totalPages: {
                                    $ceil: { $divide: ['$total', limit] },
                                },
                            },
                        },
                    ],
                    data: [
                        { $skip: skip },
                        { $limit: limit },
                        ...enrichStages,
                    ],
                },
            },
            {
                $project: {
                    meta: { $arrayElemAt: ['$meta', 0] },
                    data: 1,
                },
            },
        ]);

        const data = (aggResult[0]?.data || []) as any[];
        for (const u of data) {
            // near mode: expose distance only, never coordinates.
            if (distanceByUser) {
                const km = distanceByUser.get(u._id?.toString());
                if (typeof km === 'number') u.distanceKm = km;
            }
            // Privacy: never expose raw coordinates.
            delete u.location;
            // PII: this branch is for regular users only (admins get the full doc).
            stripPrivateUserFields(u);
        }

        return {
            meta: aggResult[0]?.meta || {
                page,
                limit,
                total: 0,
                totalPages: 0,
            },
            result: data,
        };
    }
};

const getSingleUser = async (viewer: JwtPayload, id: string) => {
    const user = await getSingleUserWithStatus(viewer.profileId, id);
    // Strip PII unless the viewer is the owner or an admin.
    const isSelf = String(viewer.profileId) === String(id);
    const isAdmin =
        viewer.role === USER_ROLE.admin ||
        viewer.role === USER_ROLE.superAdmin;
    const result = { ...user };
    if (!isSelf && !isAdmin) {
        stripPrivateUserFields(result);
    }
    // Operator notes are internal: not even the owner receives them (the reason
    // may describe a chargeback or dispute). Same for the full history.
    if (!isAdmin) {
        delete (result as any).subscriptionSetReason;
        delete (result as any).subscriptionSetBy;
        delete (result as any).subscriptionHistory;
    }
    return result;
};

export async function getSingleUserWithStatus(
    currentProfileId: string,
    targetUserId: string
) {
    if (!mongoose.Types.ObjectId.isValid(currentProfileId)) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Invalid current profile id'
        );
    }
    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }

    // Treat profiles with a block in either direction as nonexistent (404).
    if (currentProfileId) {
        const blockedIds = await getBlockedIdsFor(currentProfileId);
        if (blockedIds.includes(targetUserId)) {
            throw new AppError(httpStatus.NOT_FOUND, 'User not found');
        }
    }

    const currentId = new mongoose.Types.ObjectId(currentProfileId);
    const targetId = new mongoose.Types.ObjectId(targetUserId);

    // Admin suspension (User.isBlocked) must 404 here too: banned profiles used
    // to vanish from listings but stayed reachable via direct URL.
    const targetAccount = await NormalUser.findById(targetId)
        .select('user listedInPeople')
        .populate({ path: 'user', select: 'isBlocked' })
        .lean();

    // Admin ban first: 404 must win over PROFILE_HIDDEN so a suspended and
    // hidden account does not reveal its existence.
    if ((targetAccount as any)?.user?.isBlocked === true) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Hidden profile (listedInPeople === false): owner and accepted friends can
    // view; anyone else gets 403 PROFILE_HIDDEN. Matching and audio uploads
    // ignore this flag.
    const isSelf =
        !!currentProfileId &&
        currentProfileId.toString() === targetUserId.toString();
    if (!isSelf && (targetAccount as any)?.listedInPeople === false) {
        const esAmigo = await FriendRequest.exists({
            status: ENUM_FRIEND_REQUEST_STATUS.Accepted,
            $or: [
                { sender: currentId, receiver: targetId },
                { sender: targetId, receiver: currentId },
            ],
        });
        if (!esAmigo) {
            throw new AppError(
                httpStatus.FORBIDDEN,
                'Este perfil está oculto.',
                'PROFILE_HIDDEN'
            );
        }
    }

    const pipeline: any = [
        { $match: { _id: targetId } },

        // Friend requests in both directions.
        {
            $lookup: {
                from: 'friendrequests',
                let: { otherUserId: '$_id' },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $or: [
                                    // other -> current
                                    {
                                        $and: [
                                            {
                                                $eq: [
                                                    '$sender',
                                                    '$$otherUserId',
                                                ],
                                            },
                                            { $eq: ['$receiver', currentId] },
                                        ],
                                    },
                                    // current -> other
                                    {
                                        $and: [
                                            {
                                                $eq: [
                                                    '$receiver',
                                                    '$$otherUserId',
                                                ],
                                            },
                                            { $eq: ['$sender', currentId] },
                                        ],
                                    },
                                ],
                            },
                        },
                    },
                    { $project: { status: 1, sender: 1, receiver: 1, _id: 0 } },
                ],
                as: 'friendRequests',
            },
        },

        // friendRequestStatus precedence: friend > following > follower > none.
        {
            $addFields: {
                friendRequestStatus: {
                    $switch: {
                        branches: [
                            // Accepted in either direction => "friend"
                            {
                                case: {
                                    $anyElementTrue: {
                                        $map: {
                                            input: '$friendRequests',
                                            as: 'req',
                                            in: {
                                                $eq: [
                                                    '$$req.status',
                                                    ENUM_FRIEND_REQUEST_STATUS.Accepted,
                                                ],
                                            },
                                        },
                                    },
                                },
                                then: 'friend',
                            },

                            // current -> other, Pending => "following"
                            {
                                case: {
                                    $anyElementTrue: {
                                        $map: {
                                            input: '$friendRequests',
                                            as: 'req',
                                            in: {
                                                $and: [
                                                    {
                                                        $eq: [
                                                            '$$req.sender',
                                                            currentId,
                                                        ],
                                                    },
                                                    {
                                                        $eq: [
                                                            '$$req.status',
                                                            ENUM_FRIEND_REQUEST_STATUS.Pending,
                                                        ],
                                                    },
                                                ],
                                            },
                                        },
                                    },
                                },
                                then: 'following',
                            },

                            // other -> current, Pending => "follower"
                            {
                                case: {
                                    $anyElementTrue: {
                                        $map: {
                                            input: '$friendRequests',
                                            as: 'req',
                                            in: {
                                                $and: [
                                                    {
                                                        $eq: [
                                                            '$$req.receiver',
                                                            currentId,
                                                        ],
                                                    },
                                                    {
                                                        $eq: [
                                                            '$$req.status',
                                                            ENUM_FRIEND_REQUEST_STATUS.Pending,
                                                        ],
                                                    },
                                                ],
                                            },
                                        },
                                    },
                                },
                                then: 'follower',
                            },

                            // My outgoing request was rejected => 'none', not
                            // 'following': otherwise the button dead-ends and the
                            // user can never re-send (allowed by design — the unique
                            // index is partial on Pending).
                            {
                                case: {
                                    $anyElementTrue: {
                                        $map: {
                                            input: '$friendRequests',
                                            as: 'req',
                                            in: {
                                                $and: [
                                                    {
                                                        $eq: [
                                                            '$$req.sender',
                                                            currentId,
                                                        ],
                                                    },
                                                    {
                                                        $eq: [
                                                            '$$req.status',
                                                            ENUM_FRIEND_REQUEST_STATUS.Rejected,
                                                        ],
                                                    },
                                                ],
                                            },
                                        },
                                    },
                                },
                                then: 'none',
                            },

                            // Incoming rejected request => "follower"
                            {
                                case: {
                                    $anyElementTrue: {
                                        $map: {
                                            input: '$friendRequests',
                                            as: 'req',
                                            in: {
                                                $and: [
                                                    {
                                                        $eq: [
                                                            '$$req.receiver',
                                                            currentId,
                                                        ],
                                                    },
                                                    {
                                                        $eq: [
                                                            '$$req.status',
                                                            ENUM_FRIEND_REQUEST_STATUS.Rejected,
                                                        ],
                                                    },
                                                ],
                                            },
                                        },
                                    },
                                },
                                then: 'follower',
                            },
                        ],
                        default: 'none',
                    },
                },
            },
        },

        // Don't leak the raw requests array.
        { $project: { friendRequests: 0 } },

        // Resolve skill ids to { _id, name }; no field is dropped.
        {
            $lookup: {
                from: 'skills',
                localField: 'skills',
                foreignField: '_id',
                as: 'skills',
            },
        },
        {
            $addFields: {
                skills: {
                    $map: {
                        input: '$skills',
                        as: 'skill',
                        in: {
                            _id: '$$skill._id',
                            name: '$$skill.name',
                        },
                    },
                },
            },
        },
    ] as const;

    const [doc] = await NormalUser.aggregate(pipeline).exec();

    if (!doc) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Privacy: never expose raw coordinates.
    delete (doc as any).location;

    // Reputation is recomputed live so the header always matches the visible
    // reviews even if the cached value is stale. `applied:true` counts only
    // settled reviews (same as reputation.util), else header, list and matching
    // would show three different numbers.
    const repAgg = await BondRating.aggregate([
        { $match: { rated: targetId, applied: true } },
        {
            $group: {
                _id: '$rated',
                avg: { $avg: '$rating' },
                count: { $sum: 1 },
            },
        },
    ]);
    const liveAvg = repAgg[0]?.avg ?? 0;
    const liveCount = repAgg[0]?.count ?? 0;
    (doc as any).reputation = {
        ...((doc as any).reputation || {}),
        avg: liveAvg,
        count: liveCount,
        score: bayesianReputation(liveAvg, liveCount),
    };

    return doc;
}

// Store a GeoJSON Point [lng, lat] plus timestamp and mode (auto/manual).
// Returns the compact view the front needs — never raw coordinates.
const updateLocation = async (
    profileId: string,
    payload: { lat: number; lng: number; mode?: 'auto' | 'manual' }
) => {
    const { lat, lng, mode } = payload;

    const locationUpdatedAt = new Date();
    const locationMode: 'auto' | 'manual' = mode || 'auto';

    const updated = await NormalUser.findByIdAndUpdate(
        profileId,
        {
            location: { type: 'Point', coordinates: [lng, lat] },
            locationUpdatedAt,
            locationMode,
        },
        { new: true, runValidators: true }
    ).select('_id');

    if (!updated) {
        throw new AppError(httpStatus.NOT_FOUND, 'Profile not found');
    }

    return { lat, lng, locationUpdatedAt, locationMode };
};

/* PLAN PRICES shown on the subscription page. Single source of truth: computed
 * with the same cached dollar rate used for charging, so displayed and charged
 * prices always match. If the rate fails, `mercadopago` is null and PayPal is
 * still shown — better no price than an invented one. */
const getSubscriptionPrices = async () => {
    const tipos: TipoPlan[] = ['Free', 'Standard', 'Premium'];

    let rate: number | null = null;
    try {
        rate = await getDollarRate();
    } catch {
        rate = null;
    }

    const plans = tipos.map((tipo) => {
        const p = PLANES[tipo];
        return {
            type: tipo,
            bondLimit: p.bondLimit,
            paypal:
                p.usdPaypal > 0
                    ? { currency: 'USD', amount: p.usdPaypal }
                    : null,
            mercadopago:
                p.usdMercadopago > 0 && rate
                    ? {
                          currency: config.mercadopago.currency || 'ARS',
                          // Same rounding as `usdToPesos` (sent as `unit_price`);
                          // a different rounding here reintroduces the mismatch.
                          amount: Math.round(p.usdMercadopago * rate),
                          usdBase: p.usdMercadopago,
                      }
                    : null,
        };
    });

    return { plans, dollarRate: rate };
};

/* ADMIN MANUAL PLAN LEVER. Subscriptions are lifetime, so this is the only
 * deliberate, audited way a plan can go DOWN (e.g. a chargeback) and the rescue
 * path when a legitimate payment was rejected. It records who, when and why. */
const setSubscriptionByAdmin = async (
    adminUserId: string,
    profileId: string,
    tipo: string,
    motivo?: string
) => {
    if (!esTipoPlan(tipo)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid subscription plan');
    }
    // Same rule as creditPayment: an unusable id could match the first document
    // and grant a plan to someone who never paid.
    if (!esObjectIdUsable(profileId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }

    const plan = PLANES[tipo];
    const ahora = new Date();
    const razon = (motivo || '').slice(0, 500);

    // Read the previous plan first so the history row shows up/downgrade direction.
    const previo = await NormalUser.findById(profileId)
        .select('subscriptionType')
        .lean();
    if (!previo) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    const actualizado = await NormalUser.findByIdAndUpdate(
        profileId,
        {
            $set: {
                subscriptionType: plan.tipo,
                bondLimit: plan.bondLimit,
                // Denormalized last change (list without opening the array).
                subscriptionSetBy: adminUserId,
                subscriptionSetAt: ahora,
                subscriptionSetReason: razon,
            },
            // History is what reconstructs a dispute; capped at 50 entries since
            // this is a manual lever with no volume.
            $push: {
                subscriptionHistory: {
                    $each: [
                        {
                            type: plan.tipo,
                            by: adminUserId,
                            at: ahora,
                            reason: razon,
                            // Explicit fallback: mongoose drops undefined keys from
                            // $push, which would leave the row without `from`.
                            from:
                                (previo as any).subscriptionType ||
                                ENUM_SUBSCRIPTION_TYPE.Free,
                        },
                    ],
                    $slice: -50,
                },
            },
        },
        { new: true, runValidators: true }
    ).select('_id name subscriptionType bondLimit subscriptionSetAt');

    if (!actualizado) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // eslint-disable-next-line no-console
    console.error(
        `[subscription] ADMIN ${adminUserId} puso ${plan.tipo} a ${profileId}. Motivo: ${
            motivo || '(sin motivo)'
        }`
    );

    return actualizado;
};

const crearCheckoutMercadopago = async (
    userId: string,
    type: 'Standard' | 'Premium'
): Promise<string> => {
    // Returns the MercadoPago Checkout Pro URL. try/catch mirrors the PayPal
    // branch: raw SDK errors are not AppErrors and would surface as a generic 500
    // on the payment screen.
    try {
        const { url } = await createSubscriptionPreference(userId, type);
        return url;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('MercadoPago Preference Error:', error);
        // Keep existing AppErrors: their message is more useful than a generic one.
        if (error instanceof AppError) throw error;
        throw new AppError(
            httpStatus.INTERNAL_SERVER_ERROR,
            'No se pudo iniciar el pago con MercadoPago. Probá de nuevo en un momento.'
        );
    }
};

const crearCheckoutPaypal = async (
    userId: string,
    type: 'Standard' | 'Premium'
): Promise<string> => {
    // Price comes from `subscriptionPlans`, not a literal: creditPayment maps
    // amount→plan, so a mismatch charges without crediting. Explicit guard
    // instead of the old implicit else.
    if (PLANES[type].usdPaypal <= 0) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid subscription plan');
    }
    const totalAmount = PLANES[type].usdPaypal;

    let response;
    try {
        const request = new paypal.orders.OrdersCreateRequest();
        request.prefer('return=representation');
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [
                {
                    amount: {
                        currency_code: 'USD',
                        value: totalAmount.toFixed(2),
                    },
                    description: `Payment for subscription: ${type}`,
                    custom_id: userId,
                    reference_id: ENUM_PAYMENT_PURPOSE.SUBSCRIPTION,
                },
            ],
            application_context: {
                // `brand_name` is what PayPal shows on the payment screen (was the
                // literal template placeholder "Your Business Name" in production).
                brand_name: 'Bankybondy',
                landing_page: 'LOGIN',
                user_action: 'PAY_NOW',
                return_url: `${config.paypal.payment_capture_url}`,
                cancel_url: `${config.paypal.donation_cancel_url}`,
            },
        });

        response = await paypalClient.execute(request);
    } catch (error) {
        console.error('PayPal Payment Error:', error);
        throw new AppError(
            httpStatus.INTERNAL_SERVER_ERROR,
            'Failed to create PayPal order'
        );
    }

    const approvalUrl = response.result.links.find(
        (link: any) => link.rel === 'approve'
    )?.href;

    if (!approvalUrl) {
        throw new AppError(
            httpStatus.INTERNAL_SERVER_ERROR,
            'PayPal payment creation failed: No approval URL found'
        );
    }

    return approvalUrl;
};

const purchaseSubscription = async (
    profileId: string,
    type: string,
    provider?: string
) => {
    const user = await NormalUser.findById(profileId);
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Validate the type before claiming a checkout: an invalid type must not
    // leave a pending claim (nivelDe would treat it as Free).
    if (!esTipoPlan(type) || PLANES[type].nivel === 0) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid subscription plan');
    }

    /* Do not charge for what cannot be delivered. The anti-downgrade guard in
     * creditPayment only covers the webhook side; here the checkout is blocked,
     * so nobody pays for a plan they already own. Compared by level, not equality,
     * to also cover Premium buying Standard. */
    if (nivelDe(type) <= nivelDe((user as any).subscriptionType)) {
        throw new AppError(
            httpStatus.CONFLICT,
            'You already have this plan or a higher one.',
            'PLAN_ALREADY_OWNED'
        );
    }

    const proveedor = normalizarProveedor(provider);
    const ahora = Date.now();

    // Reuse a live checkout: a double click must not create a second payable order.
    if (
        esCheckoutReutilizable(
            user.pendingSubscriptionCheckout,
            type,
            proveedor,
            ahora
        )
    ) {
        return { url: user.pendingSubscriptionCheckout?.url as string };
    }

    // Atomic claim before creating the order: a concurrent request with a fresh
    // claim for the same plan+provider fails to match. `url: ''` marks "creating";
    // it self-expires after 30 s (subscriptionCheckout.ts).
    const claim = await NormalUser.findOneAndUpdate(
        { _id: profileId, ...construirFiltroClaim(type, proveedor, ahora) },
        {
            $set: {
                pendingSubscriptionCheckout: {
                    plan: type,
                    provider: proveedor,
                    url: '',
                    createdAt: new Date(ahora),
                },
            },
        },
        { new: true }
    ).select('pendingSubscriptionCheckout');

    if (!claim) {
        // Lost the claim: reuse the URL if another request already wrote it,
        // otherwise 409 (no second order while one is being created).
        const actual = await NormalUser.findById(profileId)
            .select('pendingSubscriptionCheckout')
            .lean();
        if (
            esCheckoutReutilizable(
                actual?.pendingSubscriptionCheckout,
                type,
                proveedor,
                Date.now()
            )
        ) {
            return {
                url: actual?.pendingSubscriptionCheckout?.url as string,
            };
        }
        throw new AppError(
            httpStatus.CONFLICT,
            'A checkout is already in progress.',
            'CHECKOUT_IN_PROGRESS'
        );
    }

    const claimCreatedAt =
        claim.pendingSubscriptionCheckout?.createdAt ?? new Date(ahora);
    const filtroReclamo = {
        _id: profileId,
        'pendingSubscriptionCheckout.plan': type,
        'pendingSubscriptionCheckout.provider': proveedor,
        'pendingSubscriptionCheckout.createdAt': claimCreatedAt,
    };

    try {
        const url =
            proveedor === 'mercadopago'
                ? await crearCheckoutMercadopago(
                      user._id.toString(),
                      type as 'Standard' | 'Premium'
                  )
                : await crearCheckoutPaypal(
                      user._id.toString(),
                      type as 'Standard' | 'Premium'
                  );

        // Write only if the claim is still ours (not expired or taken by another plan).
        await NormalUser.updateOne(filtroReclamo, {
            $set: { 'pendingSubscriptionCheckout.url': url },
        });
        return { url };
    } catch (error) {
        // Release the claim for an immediate retry.
        try {
            await NormalUser.updateOne(filtroReclamo, {
                $unset: { pendingSubscriptionCheckout: '' },
            });
        } catch {
            // best-effort: the claim also self-expires after 30 s.
        }
        throw error;
    }
};

const updateBondsVisibility = async (id: string, bondsPublic: unknown) => {
    const updated = await NormalUser.findByIdAndUpdate(
        id,
        // Strict boolean: 'false' as a string would become true via Boolean().
        { bondsPublic: bondsPublic === true || bondsPublic === 'true' },
        { new: true, runValidators: true }
    ).select('bondsPublic');
    if (!updated) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }
    return { bondsPublic: (updated as any).bondsPublic };
};

const updatePeopleVisibility = async (id: string, listedInPeople: unknown) => {
    const updated = await NormalUser.findByIdAndUpdate(
        id,
        // Strict boolean, same as bondsPublic: 'false' string must not list the user.
        { listedInPeople: listedInPeople === true || listedInPeople === 'true' },
        { new: true, runValidators: true }
    ).select('listedInPeople');
    if (!updated) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }
    return { listedInPeople: (updated as any).listedInPeople };
};

const NormalUserServices = {
    updateUserProfile,
    getAllUser,
    getSingleUser,
    getSingleUserWithStatus,
    purchaseSubscription,
    getSubscriptionPrices,
    setSubscriptionByAdmin,
    updateLocation,
    updateBondsVisibility,
    updatePeopleVisibility,
};

export default NormalUserServices;
