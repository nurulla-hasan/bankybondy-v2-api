import httpStatus from 'http-status';
import mongoose from 'mongoose';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';
import { analyzeConversationAudio } from '../../helper/audioAnalyzer';
import { deleteFileFromS3 } from '../../helper/deleteFromS3';
import { errorLogger, logger } from '../../shared/logger';
import { clampLimit, clampPage } from '../../utilities/pagination';
import { getMediaUrl } from '../../utilities/signedUrl';
import AudioBookmark from '../audioBookmark/audio.bookmark.model';
import {
    getBlockedIdsFor,
    getBlockedObjectIdsFor,
} from '../userBlock/userBlock.service';
import {
    ENUM_AUDIO_MODERATION_STATUS,
    IAudio,
} from './audio.interface';
import Audio, { AudioComment, AudioListen, AudioRating } from './audio.model';
import {
    FEELING_TAGS,
    isValidFeelingTag,
    normalizeFeelingTags,
} from './feelingTags';
import { isTextSafeBatch, assertTextAllowed } from '../../helper/isTextSafe';
import { collectAudioTexts } from './audio.moderation';
import { moderateImageUrl } from '../../helper/moderateImage';
import { isQualifiedListen, dayBucketFor } from './audio.listen';

// Rounds to 1 decimal from the stored totalRating/ratingCount; 0 if no votes.
const computeAverageRating = (
    totalRating?: number,
    ratingCount?: number
): number => {
    if (!ratingCount || ratingCount <= 0) return 0;
    return Math.round(((totalRating || 0) / ratingCount) * 10) / 10;
};

// Aggregates feeling tags over all feedback: [{ tag, count }] desc, optional limit.
const getFeelingCountsForAudio = async (
    audioId: mongoose.Types.ObjectId | string,
    limit?: number,
    blockedCommentorIds?: mongoose.Types.ObjectId[]
): Promise<{ tag: string; count: number }[]> => {
    // Exclude blocked commenters so aggregates match the visible list (no phantoms).
    const match: Record<string, unknown> = {
        audio: new mongoose.Types.ObjectId(audioId),
    };
    if (blockedCommentorIds && blockedCommentorIds.length) {
        match.commentor = { $nin: blockedCommentorIds };
    }
    const pipeline: mongoose.PipelineStage[] = [
        { $match: match },
        { $unwind: '$feelingTags' },
        { $group: { _id: '$feelingTags', count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
    ];
    if (limit && limit > 0) pipeline.push({ $limit: limit });
    pipeline.push({
        $project: { _id: 0, tag: '$_id', count: 1 },
    });
    return AudioComment.aggregate(pipeline);
};

// Signs media URLs (CloudFront) when the key pair is configured.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withSignedMedia = (doc: any) => {
    if (!doc) return doc;
    const o = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    if (o.audio_url) o.audio_url = getMediaUrl(o.audio_url);
    if (o.cover_image) o.cover_image = getMediaUrl(o.cover_image);
    return o;
};

// Two-step upload (/upload-audio, then /create-audio): these helpers are the trust
// boundary for client-supplied URLs (same rule as `file.controller.deleteFiles`).
const AUDIO_UPLOAD_DIRS = {
    audio: 'uploads/audios',
    cover: 'uploads/images/audio_cover',
} as const;

// Returns the S3 key only if the URL is on the configured CDN and under the owner's
// folder; decodes pathname like `deleteFileFromS3` so checks and deletes match.
const ownedUploadKey = (
    url: string,
    ownerId: string,
    kind: keyof typeof AUDIO_UPLOAD_DIRS
): string | null => {
    if (typeof url !== 'string' || !url) return null;
    let key: string;
    try {
        const parsed = new URL(url);
        const cdnHost = new URL(process.env.CLOUDFRONT_URL as string).host;
        if (parsed.host !== cdnHost) return null;
        key = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    } catch {
        return null;
    }
    if (!key || key.includes('..')) return null;
    return key.startsWith(`${AUDIO_UPLOAD_DIRS[kind]}/${ownerId}/`)
        ? key
        : null;
};

// A staged file can be published once: reject if another audio already points to it.
const assertAudioUploadsClaimable = async (urls: string[]): Promise<void> => {
    if (!urls.length) return;
    const claimed = await Audio.exists({
        $or: [{ audio_url: { $in: urls } }, { cover_image: { $in: urls } }],
    });
    if (claimed) {
        throw new AppError(
            httpStatus.CONFLICT,
            'This file was already published'
        );
    }
};

// Validates a pre-uploaded URL before creating the audio (host + prefix + claim).
const assertPreparedAudioUpload = async (
    ownerId: string,
    url: string,
    kind: keyof typeof AUDIO_UPLOAD_DIRS
): Promise<void> => {
    if (!ownedUploadKey(url, ownerId, kind)) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            `You can only use ${kind} files you uploaded`
        );
    }
    await assertAudioUploadsClaimable([url]);
};

// Deletes unpublished staged files; rejects the whole batch if any URL is foreign
// or already claimed.
const deleteUploadedAudioFiles = async (
    ownerId: string,
    urls: string[]
): Promise<{ deleted: number }> => {
    const keys = urls.map((url) => {
        const key =
            ownedUploadKey(url, ownerId, 'audio') ??
            ownedUploadKey(url, ownerId, 'cover');
        if (!key) {
            throw new AppError(
                httpStatus.FORBIDDEN,
                'You can only delete files you uploaded'
            );
        }
        return key;
    });
    await assertAudioUploadsClaimable(urls);
    await Promise.all(urls.map((url) => deleteFileFromS3(url)));
    return { deleted: keys.length };
};

// D.5 (Tanda 2): upload does not block the UI — the record starts as 'processing'
// and AI moderation runs in the background. Throws 400 on a disallowed text verdict,
// but does not fail when moderation is down (assertTextAllowed tells both apart).
const moderateAudioTexts = async (payload: Partial<IAudio>): Promise<void> => {
    const texts = collectAudioTexts(payload);
    if (!texts.length) return;
    const verdicts = await isTextSafeBatch(texts.map((t) => t.text));
    verdicts.forEach((v, i) => assertTextAllowed(v, texts[i].label));
};

const createAudio = async (userId: string, payload: IAudio) => {
    // Server-controlled fields: never from the client.
    const {
        totalPlay,
        trendingScore,
        totalRating,
        ratingCount,
        isBlocked,
        // Moderation state is server-controlled.
        moderationStatus,
        moderationReason,
        ...safePayload
    } = payload as Partial<IAudio>;

    // Moderate title/description/tags BEFORE create (public client text bypassed T&S).
    await moderateAudioTexts(safePayload);

    const result = await Audio.create({
        ...safePayload,
        user: userId,
        moderationStatus: ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
        moderationReason: '',
    });
    return result;
};

/**
 * Background moderation of the S3 file (transcode + transcribe + content verdict),
 * fire-and-forget from the controller. Reuses the existing analyzer.
 */
// Verdicts are never written by _id alone: always against what was analyzed.
// The analysis takes minutes and the owner can replace the file meanwhile from
// "Editar" (Mi contenido hides moderation status). Keyed by _id only, a stale
// verdict published an unanalyzed file and, on rejection, deleted the NEW object.
// All S3 deletes happen only after the seal succeeds.
const processAudioModeration = async (
    audioId: string,
    audioUrl: string
): Promise<void> => {
    // Writes only if the audio is still the one analyzed and still 'processing'
    // (first-writer-wins vs. a concurrent sweep pass). Returns whether it wrote.
    const sellarVeredicto = async (campos: Record<string, unknown>) => {
        const r = await Audio.updateOne(
            {
                _id: audioId,
                audio_url: audioUrl,
                moderationStatus: ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
            },
            campos
        );
        if (r.matchedCount === 0) {
            // Log the fact, not the cause: file changed, other pass won, or doc deleted.
            logger.info(
                `[audio] veredicto descartado: ${audioId} ya no está esperando este análisis.`
            );
        }
        return r.matchedCount > 0;
    };

    try {
        // Technical errors (network/S3/ffmpeg/OpenAI/timeout/bad JSON) propagate to
        // the catch; the analyzer only returns a boolean content verdict.
        const analysis = await analyzeConversationAudio(audioUrl);
        // Approve only for a valid dialogue with no prohibited content.
        if (
            analysis?.valid_conversation === true &&
            analysis?.prohibited_content === false
        ) {
            // Sign the cover URL (getMediaUrl) so OpenAI can fetch it even if the CDN
            // is locked down; an unsigned 403 would silently fail open.
            const doc = await Audio.findById(audioId)
                .select('cover_image')
                .lean();
            const cover = await moderateImageUrl(
                getMediaUrl(doc?.cover_image || '')
            );
            if (!cover.checked) {
                // Cover unverifiable (OpenAI down/429): throw to the technical catch
                // → FAILED → sweep retries; never publish an unmoderated cover.
                throw new Error('Cover moderation unavailable — will retry');
            }
            if (!cover.safe) {
                // Only this branch also seals on `cover_image`: a cover rejection must
                // not land on a cover the owner already replaced. Adding it to
                // `sellarVeredicto` would no-op every READY on any cover change.
                const r = await Audio.updateOne(
                    {
                        _id: audioId,
                        audio_url: audioUrl,
                        cover_image: doc?.cover_image,
                        moderationStatus:
                            ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
                    },
                    {
                        moderationStatus:
                            ENUM_AUDIO_MODERATION_STATUS.REJECTED,
                        moderationReason: `Cover image rejected: ${cover.reason}`,
                    }
                );
                const sello = r.matchedCount > 0;
                if (!sello) {
                    // Discard log for the only T&S verdict that used to leave no trace.
                    logger.info(
                        `[audio] veredicto de portada descartado: ${audioId} ya no está esperando este análisis.`
                    );
                }
                // Delete only the NSFW cover; keep the audio (it passed moderation).
                // Must stay behind the seal: if the seal no-ops the document may still
                // point at this cover (a required field), so deleting would leave a
                // dangling reference and burn retries on every following pass.
                if (sello && doc?.cover_image) deleteFileFromS3(doc.cover_image);
                return;
            }
            // Approved by content (audio + cover).
            await sellarVeredicto({
                moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
                moderationReason: '',
            });
        } else {
            // Content rejection: seal first (the atomic decision on whether this
            // verdict still applies), then delete S3 files. The old order re-read the
            // document and could delete a freshly uploaded file.
            const audio = await Audio.findById(audioId).lean();
            const sello = await sellarVeredicto({
                moderationStatus: ENUM_AUDIO_MODERATION_STATUS.REJECTED,
                moderationReason:
                    analysis?.reason ||
                    'Audio rejected: it must be a real conversation and must not contain prohibited content.',
            });
            if (sello) {
                // `audioUrl`, not `audio.audio_url`: delete exactly what was judged.
                deleteFileFromS3(audioUrl);
                if (audio?.cover_image) deleteFileFromS3(audio.cover_image);
            }
        }
    } catch (e) {
        // Technical failure, not a content verdict: mark 'failed' and keep the S3
        // files so the audio can be retried.
        errorLogger.error(
            '[audio] moderacion en background fallo (tecnico):',
            (e as Error)?.message
        );
        try {
            // Also sealed: a stale failure must not overwrite the new file's 'processing'.
            await sellarVeredicto({
                moderationStatus: ENUM_AUDIO_MODERATION_STATUS.FAILED,
                moderationReason:
                    'Could not process audio due to a technical error. It will be retried.',
            });
            // Do NOT delete S3 here: the audio may be valid.
        } catch {
            /* noop */
        }
    }
};

// D.5: moderation status for front-end progress polling.
const getModerationStatus = async (userId: string, audioId: string) => {
    const audio = await Audio.findOne({ _id: audioId, user: userId })
        .select('moderationStatus moderationReason')
        .lean();
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    return {
        _id: audioId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        moderationStatus: (audio as any).moderationStatus,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        moderationReason: (audio as any).moderationReason || '',
    };
};

// Feed "Estamos charlando"; with profileId it excludes audios from blocked users
// (both directions, B.4).
const getAllAudios = async (
    query: Record<string, unknown>,
    profileId?: string
) => {
    // Feed only shows 'ready' audios; 'processing'/'rejected' appear once approved.
    const baseFilter: Record<string, unknown> = {
        isBlocked: false,
        moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
    };
    const blockedObjectIds = profileId
        ? await getBlockedObjectIdsFor(profileId)
        : [];
    if (blockedObjectIds.length) {
        baseFilter.user = { $nin: blockedObjectIds };
    }
    const audioQuery = new QueryBuilder(
        Audio.find(baseFilter)
            .populate('audioTopic')
            .populate({
                path: 'user',
                select: 'name profile_image',
                model: 'NormalUser',
            }),
        query
    )
        .search(['title', 'description'])
        .filter()
        .sort()
        .paginate()
        .fields();

    const result = await audioQuery.modelQuery;
    const meta = await audioQuery.countTotal();

    // Per-card enrichment (averageRating, commentCount, top 3 feelings); aggregates
    // are scoped to this page's audios to stay efficient.
    const cards = (result as unknown[]).map(withSignedMedia);
    const audioIds = cards
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c?._id)
        .filter(Boolean)
        .map((id: unknown) => new mongoose.Types.ObjectId(String(id)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let enriched: any[] = cards;
    if (audioIds.length) {
        // Exclude blocked commenters here too, or the feed shows phantom counts.
        const commentMatch: Record<string, unknown> = {
            audio: { $in: audioIds },
        };
        if (blockedObjectIds.length) {
            commentMatch.commentor = { $nin: blockedObjectIds };
        }
        const countAgg = await AudioComment.aggregate([
            { $match: commentMatch },
            { $group: { _id: '$audio', count: { $sum: 1 } } },
        ]);
        const commentCountMap = new Map<string, number>();
        for (const row of countAgg) {
            commentCountMap.set(String(row._id), row.count);
        }

        // Top feeling tags per audio (desc), capped to 3 below.
        const feelingsAgg = await AudioComment.aggregate([
            { $match: commentMatch },
            { $unwind: '$feelingTags' },
            {
                $group: {
                    _id: { audio: '$audio', tag: '$feelingTags' },
                    count: { $sum: 1 },
                },
            },
            { $sort: { count: -1, '_id.tag': 1 } },
            {
                $group: {
                    _id: '$_id.audio',
                    feelings: {
                        $push: { tag: '$_id.tag', count: '$count' },
                    },
                },
            },
        ]);
        const feelingsMap = new Map<
            string,
            { tag: string; count: number }[]
        >();
        for (const row of feelingsAgg) {
            feelingsMap.set(String(row._id), (row.feelings || []).slice(0, 3));
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        enriched = cards.map((card: any) => {
            const id = String(card?._id);
            return {
                ...card,
                averageRating: computeAverageRating(
                    card?.totalRating,
                    card?.ratingCount
                ),
                commentCount: commentCountMap.get(id) || 0,
                topFeelings: feelingsMap.get(id) || [],
            };
        });
    }

    return {
        meta,
        result: enriched,
    };
};

const getMyAudios = async (userId: string, query: Record<string, unknown>) => {
    const audioQuery = new QueryBuilder(
        Audio.find({ user: userId }).populate('audioTopic'),
        query
    )
        .search(['title', 'description'])
        .filter()
        .sort()
        .paginate()
        .fields();

    const result = await audioQuery.modelQuery;
    const meta = await audioQuery.countTotal();

    return {
        meta,
        result: (result as unknown[]).map(withSignedMedia),
    };
};

// Public talks for a profile page: only 'ready', unblocked audios; projection +
// limit + lean for speed, signed media URLs, plus averageRating.
const getAudiosByUser = async (userId: string, viewerId?: string) => {
    if (!mongoose.Types.ObjectId.isValid(userId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }

    // B.4: blocking in either direction hides the whole list.
    if (viewerId) {
        const blockedIds = await getBlockedIdsFor(viewerId);
        if (blockedIds.includes(userId)) {
            return [];
        }
    }

    const audios = await Audio.find({
        user: userId,
        moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
        isBlocked: false,
    })
        .select(
            'title description cover_image audio_url duration audioTopic totalPlay totalRating ratingCount'
        )
        .populate('audioTopic')
        .sort('-createdAt')
        .limit(12)
        .lean();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (audios as any[]).map((audio) => {
        const signed = withSignedMedia(audio);
        return {
            ...signed,
            averageRating: computeAverageRating(
                signed?.totalRating,
                signed?.ratingCount
            ),
        };
    });
};

// Exposed only when 'ready' or to the owner; blocked audios 404 for everyone.
const getAudioById = async (audioId: string, requesterId?: string) => {
    if (!mongoose.Types.ObjectId.isValid(audioId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid audio id');
    }
    const audio = await Audio.findById(audioId)
        .populate('audioTopic')
        .populate({
            path: 'user',
            select: 'name profile_image',
            model: 'NormalUser',
        });
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    if ((audio as unknown as { isBlocked?: boolean }).isBlocked) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const status = (audio as unknown as { moderationStatus?: string })
        .moderationStatus;
    const ownerId =
        (audio as unknown as { user?: { _id?: { toString(): string } } }).user
            ?._id?.toString() ??
        (audio as unknown as { user?: { toString(): string } }).user?.toString();
    const isOwner = !!requesterId && ownerId === requesterId;
    // Third parties see only 'ready'; the owner sees any of their own states.
    if (status !== ENUM_AUDIO_MODERATION_STATUS.READY && !isOwner) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }

    // B.4: blocking in either direction makes the audio invisible (404).
    if (requesterId && !isOwner && ownerId) {
        const blockedIds = await getBlockedIdsFor(requesterId);
        if (blockedIds.includes(ownerId)) {
            throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: any = withSignedMedia(audio);

    // Feedback aggregates (rating, comment count, top 6 feelings); blocked
    // commenters excluded, same as the visible list.
    const feedbackBlockedIds = requesterId
        ? await getBlockedObjectIdsFor(requesterId)
        : [];
    const commentMatch: Record<string, unknown> = { audio: audioId };
    if (feedbackBlockedIds.length) {
        commentMatch.commentor = { $nin: feedbackBlockedIds };
    }
    const [commentCount, topFeelings] = await Promise.all([
        AudioComment.countDocuments(commentMatch),
        getFeelingCountsForAudio(audioId, 6, feedbackBlockedIds),
    ]);

    base.averageRating = computeAverageRating(
        base?.totalRating,
        base?.ratingCount
    );
    base.ratingCount = base?.ratingCount || 0;
    base.commentCount = commentCount;
    base.topFeelings = topFeelings;

    // Authenticated requester: attach their own rating/feeling.
    if (requesterId) {
        const [myRatingDoc, myFeelingDoc] = await Promise.all([
            AudioRating.findOne({ user: requesterId, audio: audioId })
                .select('rating')
                .lean(),
            AudioComment.findOne({
                commentor: requesterId,
                audio: audioId,
            })
                .select('text feelingTags createdAt updatedAt')
                .lean(),
        ]);
        base.myRating =
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (myRatingDoc as any)?.rating ?? null;
        base.myFeeling = myFeelingDoc
            ? {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  text: (myFeelingDoc as any).text || '',
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  feelingTags: (myFeelingDoc as any).feelingTags || [],
              }
            : null;
    } else {
        base.myRating = null;
        base.myFeeling = null;
    }

    return base;
};

const updateAudio = async (
    userId: string,
    audioId: string,
    payload: Partial<IAudio>
) => {
    const audio = await Audio.findOne({ user: userId, _id: audioId });
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    // Strip client-manipulable counters/state. `user` is listed as defense in depth
    // (see the note in audio.controller.ts updateAudio): ownership must never move.
    const {
        totalPlay,
        trendingScore,
        totalRating,
        ratingCount,
        isBlocked,
        moderationStatus,
        moderationReason,
        // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
        user: _user,
        ...safePayload
    } = payload as typeof payload & { user?: unknown };

    // Guard "nothing to update": the schema `.refine` was dropped because it ran
    // before the controller injected the uploaded file URL. Here is the right place.
    if (Object.keys(safePayload).length === 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'At least one field must be provided for update'
        );
    }

    // Moderate updated public texts (same rule as create).
    await moderateAudioTexts(safePayload);

    // Moderate a replaced cover synchronously; otherwise a cover-only update slipped
    // an unmoderated image past the control that exists in create.
    const coverChanged =
        !!payload.cover_image && payload.cover_image !== audio.cover_image;
    if (coverChanged) {
        const cover = await moderateImageUrl(
            getMediaUrl(payload.cover_image as string)
        );
        if (!cover.checked) {
            // Delete the unverified new cover to avoid an S3 orphan; keep the old one.
            deleteFileFromS3(payload.cover_image as string);
            throw new AppError(
                httpStatus.SERVICE_UNAVAILABLE,
                'Could not verify the cover image, please try again.'
            );
        }
        if (!cover.safe) {
            // Delete the rejected cover; the audio keeps its previous one.
            deleteFileFromS3(payload.cover_image as string);
            throw new AppError(
                httpStatus.BAD_REQUEST,
                `Cover image rejected: ${cover.reason}`
            );
        }
    }

    // Replacing `audio_url` means unmoderated content: go back to 'processing'
    // (drops it from the feed) and re-run moderation, same as create.
    const audioUrlChanged =
        !!payload.audio_url && payload.audio_url !== audio.audio_url;
    const updatePayload: Partial<IAudio> = audioUrlChanged
        ? {
              ...safePayload,
              moderationStatus: ENUM_AUDIO_MODERATION_STATUS.PROCESSING,
              moderationReason: '',
              // Fresh moderation job: don't inherit the retry budget spent by the
              // previous file, or the sweep refuses to retry.
              moderationAttempts: 0,
          }
        : safePayload;

    const updatedAudio = await Audio.findByIdAndUpdate(audioId, updatePayload, {
        new: true,
    });

    if (payload.audio_url && audio.audio_url) {
        deleteFileFromS3(audio.audio_url);
    }
    if (payload.cover_image && audio.cover_image) {
        deleteFileFromS3(audio.cover_image);
    }

    // Fire-and-forget like createAudio: background moderation sets 'ready'/'rejected'.
    if (audioUrlChanged && payload.audio_url) {
        processAudioModeration(audioId, payload.audio_url).catch(
            () => undefined
        );
    }

    return updatedAudio;
};

const deleteAudio = async (userId: string, audioId: string) => {
    const audio = await Audio.findOne({ _id: audioId, user: userId });
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const result = await Audio.findByIdAndDelete(audioId);
    await AudioRating.deleteMany({ audio: audioId });
    await AudioBookmark.deleteMany({ audio: audioId });
    await AudioComment.deleteMany({ audio: audioId });
    if (audio.audio_url) {
        deleteFileFromS3(audio.audio_url);
    }
    if (audio.cover_image) {
        deleteFileFromS3(audio.cover_image);
    }
    return result;
};

// D.5 (Admin): admin-panel listing with no forced filter — every moderation state,
// blocked or not; the query can filter by moderationStatus/isBlocked.
const getAudiosForAdmin = async (query: Record<string, unknown>) => {
    const audioQuery = new QueryBuilder(
        Audio.find({})
            .populate('audioTopic')
            .populate({
                path: 'user',
                select: 'name email profile_image',
                model: 'NormalUser',
            }),
        query
    )
        .search(['title', 'description'])
        // OPT-IN layer 2: filters moderationStatus/isBlocked on an unscoped base
        // query (no owner scope, so no IDOR).
        .filter(['moderationStatus', 'isBlocked'])
        .sort()
        .paginate()
        .fields();

    const result = await audioQuery.modelQuery;
    const meta = await audioQuery.countTotal();

    return {
        meta,
        result: (result as unknown[]).map(withSignedMedia),
    };
};

// D.5 (Admin): reversible isBlocked toggle; hides from the feed without deleting.
const setAudioBlockedByAdmin = async (audioId: string) => {
    const audio = await Audio.findById(audioId);
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const updatedAudio = await Audio.findByIdAndUpdate(
        audioId,
        { isBlocked: !audio.isBlocked },
        { new: true }
    );
    return withSignedMedia(updatedAudio);
};

// D.5 (Admin): hard delete of the audio, its ratings, bookmarks and S3 files.
const deleteAudioByAdmin = async (audioId: string) => {
    const audio = await Audio.findById(audioId);
    if (!audio) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const result = await Audio.findByIdAndDelete(audioId);
    await AudioRating.deleteMany({ audio: audioId });
    await AudioBookmark.deleteMany({ audio: audioId });
    await AudioComment.deleteMany({ audio: audioId });
    if (audio.audio_url) {
        deleteFileFromS3(audio.audio_url);
    }
    if (audio.cover_image) {
        deleteFileFromS3(audio.cover_image);
    }
    return result;
};

const giveRating = async (userId: string, audioId: string, rating: number) => {
    // M3: validate the audio exists/ready/unblocked BEFORE rating. The old order
    // committed an orphan rating when findByIdAndUpdate returned null.
    const audio = await assertAudioReady(audioId);
    await assertNotBlockedFromAudio(
        userId,
        (audio as unknown as { user?: { toString(): string } }).user?.toString()
    );
    // No self-rating: ratings are the listeners' voice, not the author's.
    if (
        (audio as unknown as { user?: { toString(): string } }).user?.toString() ===
        userId?.toString()
    ) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'No podés puntuar tu propio audio.'
        );
    }
    const ratingExist = await AudioRating.findOne({
        user: userId,
        audio: audioId,
    });
    if (ratingExist) {
        throw new AppError(
            httpStatus.CONFLICT,
            'You already rated that audio'
        );
    }
    const session = await mongoose.startSession();

    try {
        session.startTransaction();

        await AudioRating.create([{ user: userId, audio: audioId, rating }], {
            session,
        });

        const result = await Audio.findByIdAndUpdate(
            audioId,
            { $inc: { ratingCount: 1, totalRating: rating } },
            { new: true, session }
        );

        await session.commitTransaction();
        return result;
    } catch (error: unknown) {
        await session.abortTransaction();
        if ((error as { code?: number })?.code === 11000) {
            throw new AppError(
                httpStatus.CONFLICT,
                'You already rated that audio'
            );
        }
        throw error;
    } finally {
        session.endSession();
    }
};

// Controlled feeling-tag vocabulary (accented display labels).
const getFeelingTags = (): string[] => [...FEELING_TAGS];

// Returns a 'ready', unblocked audio or throws 404.
const assertAudioReady = async (audioId: string) => {
    if (!mongoose.Types.ObjectId.isValid(audioId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid audio id');
    }
    const audio = await Audio.findById(audioId).select(
        'moderationStatus isBlocked user'
    );
    if (!audio || (audio as unknown as { isBlocked?: boolean }).isBlocked) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    const status = (audio as unknown as { moderationStatus?: string })
        .moderationStatus;
    if (status !== ENUM_AUDIO_MODERATION_STATUS.READY) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    return audio;
};

// Cross-user blocking on an already-validated audio: block either way and the audio
// "doesn't exist" (404), so a blocked user can't rate/comment a foreign audio by id.
const assertNotBlockedFromAudio = async (
    userId: string,
    ownerId?: string
): Promise<void> => {
    if (!ownerId || ownerId === userId?.toString()) return;
    const blockedIds = await getBlockedIdsFor(userId);
    if (blockedIds.includes(ownerId)) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
};

// Upsert of listener feedback (text + feeling tags); one opinion per (audio, user).
const upsertAudioFeedback = async (
    userId: string,
    audioId: string,
    payload: { text?: string; feelingTags?: string[] }
) => {
    const audio = await assertAudioReady(audioId);
    await assertNotBlockedFromAudio(
        userId,
        (audio as unknown as { user?: { toString(): string } }).user?.toString()
    );
    // Authors can't leave feedback on their own audio (feedback is the listeners').
    if (
        (audio as unknown as { user?: { toString(): string } }).user?.toString() ===
        userId?.toString()
    ) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'No podés dejar feedback en tu propio audio.'
        );
    }

    const text = (payload.text || '').trim();

    // Vocabulary subset check (beyond zod) plus normalization to canonical,
    // deduplicated values.
    const rawTags = Array.isArray(payload.feelingTags)
        ? payload.feelingTags
        : [];
    const invalid = rawTags.filter((t) => !isValidFeelingTag(t));
    if (invalid.length) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            `Invalid feeling tag(s): ${invalid.join(', ')}`
        );
    }
    const feelingTags = normalizeFeelingTags(rawTags);

    if (!text && feelingTags.length === 0) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Provide at least a text comment or one feeling tag'
        );
    }

    // Moderate the public comment (same rule as link reviews).
    if (text) {
        const [verdict] = await isTextSafeBatch([text]);
        assertTextAllowed(verdict, 'Comment');
    }

    const result = await AudioComment.findOneAndUpdate(
        { audio: audioId, commentor: userId },
        { $set: { text, feelingTags } },
        {
            new: true,
            upsert: true,
            setDefaultsOnInsert: true,
            runValidators: true,
        }
    ).populate({
        path: 'commentor',
        select: 'name profile_image',
        model: 'NormalUser',
    });

    return result;
};

// Paginated public feedback for one audio, plus all-feedback feeling counts.
const getAudioFeedback = async (
    audioId: string,
    query: Record<string, unknown>,
    viewerId?: string
) => {
    // Clamped via the shared helper: a bare `parseInt(...) || 10` allowed negative
    // or Infinity skips (500s) and unbounded limits on this PUBLIC endpoint.
    const page = clampPage(query.page);
    // Cap 500, not 100: clients "load more" by raising `limit` with page=1, so a 100
    // cap froze the button (comments.length could never reach totalComments).
    const limit = clampLimit(query.limit, 10, 500);
    const skip = (page - 1) * limit;

    if (!mongoose.Types.ObjectId.isValid(audioId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid audio id');
    }
    // Visibility: feedback is served only for READY, unblocked audios; rejected or
    // processing ids used to expose their comments and metrics.
    await assertAudioReady(audioId);
    const audioObjectId = new mongoose.Types.ObjectId(audioId);
    // B.4: hide comments from users blocked in either direction.
    const filter: Record<string, unknown> = { audio: audioObjectId };
    const blockedObjectIds = viewerId
        ? await getBlockedObjectIdsFor(viewerId)
        : [];
    if (blockedObjectIds.length) {
        filter.commentor = { $nin: blockedObjectIds };
    }

    const [result, total, feelingCounts] = await Promise.all([
        AudioComment.find(filter)
            .populate({
                path: 'commentor',
                select: 'name profile_image',
                model: 'NormalUser',
            })
            .select('text feelingTags createdAt updatedAt commentor')
            .sort('-createdAt')
            .skip(skip)
            .limit(limit)
            .lean(),
        AudioComment.countDocuments(filter),
        getFeelingCountsForAudio(audioObjectId, undefined, blockedObjectIds),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
        meta: { page, limit, total, totalPages },
        totalComments: total,
        feelingCounts,
        result,
    };
};

// E0: records a QUALIFIED listen (>=30s or >=40%), deduped per (audio, listener,
// day); idempotent via unique index + 11000 branch. Makes `totalPlay` real.
const recordListen = async (
    userId: string,
    audioId: string,
    payload: { secondsListened?: number; completion?: number }
) => {
    if (!mongoose.Types.ObjectId.isValid(audioId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid audio id');
    }
    if (!isQualifiedListen(payload)) {
        return { counted: false, reason: 'below-threshold' };
    }
    const audio = await Audio.findById(audioId)
        .select('user moderationStatus isBlocked')
        .lean();
    if (
        !audio ||
        audio.moderationStatus !== ENUM_AUDIO_MODERATION_STATUS.READY ||
        audio.isBlocked
    ) {
        throw new AppError(httpStatus.NOT_FOUND, 'Audio not found');
    }
    // Owner's own listen doesn't count (avoids inflating trending).
    if (String(audio.user) === String(userId)) {
        return { counted: false, reason: 'own-audio' };
    }
    try {
        await AudioListen.create({
            audio: audioId,
            listener: userId,
            completion: Math.max(0, Math.min(1, Number(payload.completion) || 0)),
            secondsListened: Math.max(0, Number(payload.secondsListened) || 0),
            dayBucket: dayBucketFor(new Date()),
        });
    } catch (e: any) {
        // Already a qualified listen today for this audio → don't add again.
        if (e?.code === 11000) {
            return { counted: false, reason: 'already-today' };
        }
        throw e;
    }
    await Audio.updateOne({ _id: audioId }, { $inc: { totalPlay: 1 } });
    return { counted: true };
};

const AudioService = {
    createAudio,
    assertPreparedAudioUpload,
    deleteUploadedAudioFiles,
    processAudioModeration,
    getModerationStatus,
    getAllAudios,
    getAudioById,
    updateAudio,
    deleteAudio,
    getMyAudios,
    getAudiosByUser,
    giveRating,
    getAudiosForAdmin,
    setAudioBlockedByAdmin,
    deleteAudioByAdmin,
    getFeelingTags,
    upsertAudioFeedback,
    getAudioFeedback,
    recordListen,
};

export default AudioService;
