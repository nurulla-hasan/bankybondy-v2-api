/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import AppError from '../../error/appError';
import { BondLink } from '../bondLink/bondLink.model';
import { ENUM_BOND_LINK_STATUS } from '../bondLink/bondLink.enum';
import NormalUser from '../normalUser/normalUser.model';
import { IBondRating } from './bondRating.interface';
import BondRating from './bondRating.model';
import { bayesianReputation } from '../bondRequest/matching.scoring';
import sendNotification from '../../helper/sendNotification';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import { clampLimit, clampPage } from '../../utilities/pagination';
import { getBlockedObjectIdsFor } from '../userBlock/userBlock.service';

const addRating = async (
    profileId: string,
    payload: IBondRating & { userId: string }
) => {
    // Anti auto-calificación: tu propio vínculo está en el bondLink, así que sin
    // este guard podías mandar userId = vos mismo y ponerte 5 estrellas, inflando tu
    // reputación (que alimenta el ranking del matcheo y el orden de Personas).
    if (String(payload.userId) === String(profileId)) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'No podés calificarte a vos mismo'
        );
    }

    const bondLink = await BondLink.findOne({
        _id: payload.bondLink,
        participants: new mongoose.Types.ObjectId(profileId),
    }).populate({ path: 'requestedBonds' });

    if (!bondLink) {
        throw new AppError(httpStatus.NOT_FOUND, 'Bond link not found');
    }

    // Para calificar tenés que haber marcado VOS el trueque como completado.
    //
    // Antes se exigía que el vínculo entero estuviera Completed (todos los
    // participantes marcados). Eso rompía el flujo real: los intercambios de la
    // vida no ocurren a la vez, cada uno cierra su parte cuando le toca, y quien
    // marcaba primero se quedaba sin poder opinar — el modal se le abría y el
    // backend le rechazaba la reseña. Peor: si el círculo se cerraba mientras no
    // estaba, no volvía a ver el modal nunca.
    //
    // Ahora cada uno califica al marcar, a su tiempo. Si la contraparte no
    // cumplió, se la califica mal y listo: el sistema no sanciona a nadie, sólo
    // registra la opinión de quien sí participó.
    //
    // El guard se mantiene fuerte donde importa: hay que haber puesto la propia
    // firma sobre el trueque. Quien nunca marcó completado no puede repartir
    // estrellas.
    const marcasteCompletado = (bondLink.markAsCompletedBy ?? []).some(
        (x: any) => x?.toString() === profileId.toString()
    );
    if (!marcasteCompletado) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Para calificar tenés que marcar el trueque como completado.'
        );
    }
    // `requestedBonds` puede tener null si un bond referenciado fue borrado por su
    // dueño después de crear el BondLink → `bond.user` crasheaba (500). Optional
    // chaining defensivo. Además el chequeo de bondLink va ANTES (orden corregido).
    const ratedUserBondRequest: any = bondLink.requestedBonds.find(
        (bond: any) => bond?.user?.toString() == payload.userId
    );

    if (!ratedUserBondRequest) {
        throw new AppError(
            httpStatus.NOT_FOUND,
            'Rated user bond request not found'
        );
    }

    // D.3 (Tanda 2): crear o ACTUALIZAR la valoracion (rating + comentario) del
    // mismo par (ratedBy, rated, bondLink). Antes se rechazaba la segunda vez;
    // ahora se permite editar la propia puntuacion/comentario (upsert idempotente).
    try {
        const result = await BondRating.findOneAndUpdate(
            {
                rated: payload.userId,
                ratedBy: profileId,
                bondLink: payload.bondLink,
            },
            {
                $set: {
                    rated: payload.userId,
                    ratedBy: profileId,
                    bondLink: payload.bondLink,
                    want: ratedUserBondRequest.want,
                    offer: ratedUserBondRequest.offer,
                    rating: payload.rating,
                    // Rating en SUSPENSO: solo cuenta para la reputación si el trueque
                    // YA está cerrado (rater tardío, tras el cierre). Si sigue Ongoing,
                    // queda en suspenso y se aplica en LOTE cuando todos completen.
                    applied:
                        bondLink.status === ENUM_BOND_LINK_STATUS.Completed,
                    // Solo se persiste si viene en el payload; undefined no borra.
                    ...(payload.comment !== undefined
                        ? { comment: payload.comment }
                        : {}),
                },
            },
            {
                new: true,
                upsert: true,
                runValidators: true,
                setDefaultsOnInsert: true,
            }
        );
        // La reputacion cacheada del usuario valorado se recalcula UNICAMENTE via
        // el post-hook 'findOneAndUpdate' de BondRating (que ya cubre save/update/
        // delete). Antes se llamaba tambien aqui explicitamente -> doble recomputo
        // redundante en cada valoracion. Se elimina para no duplicar el trabajo.

        // Notificación (Fase 2): avisar al usuario CALIFICADO que recibió una
        // reseña. Best-effort, no bloquea la respuesta. `payload.userId` = rated,
        // `profileId` = quien califica (redirectId apunta a esa persona).
        sendNotification({
            title: 'Tenés una nueva reseña',
            message: 'Alguien contó cómo fue encontrarse con vos.',
            receiver: String(payload.userId),
            type: ENUM_NOTIFICATION_TYPE.REVIEW,
            redirectId: String(profileId),
        }).catch(() => undefined);

        return result;
    } catch (error: unknown) {
        if ((error as { code?: number })?.code === 11000) {
            throw new AppError(
                httpStatus.CONFLICT,
                'You already gave rating to that user for this bond'
            );
        }
        throw error;
    }
};

/**
 * D.3 (Tanda 2) - Vista publica de reputacion de un usuario.
 * Devuelve la reputacion cacheada + la lista de puntuaciones recibidas con
 * quien puntuo (nombre/imagen) y el comentario. Paginada.
 */
const getPublicRatings = async (
    ratedUserId: string,
    query: Record<string, unknown>,
    viewerId?: string
) => {
    if (!mongoose.Types.ObjectId.isValid(ratedUserId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }

    const page = clampPage(query.page);
    const limit = clampLimit(query.limit); // antes sin tope superior → ?limit=9999999
    const skip = (page - 1) * limit;

    const ratedId = new mongoose.Types.ObjectId(ratedUserId);

    const user = await NormalUser.findById(ratedId).select(
        'name profile_image reputation'
    );
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Bloqueos (ambas direcciones) del que mira. Se usan para: 1) ocultar las
    // reseñas escritas por usuarios bloqueados (ratedBy $nin), y 2) si el propio
    // perfil visitado esta en una relacion de bloqueo con el que mira, no mostrar
    // nada (devolver el mismo shape pero vacio).
    const blockedObjectIds = viewerId
        ? await getBlockedObjectIdsFor(viewerId)
        : [];

    const profileIsBlocked = blockedObjectIds.some(
        (id) => id.toString() === ratedUserId
    );
    if (profileIsBlocked) {
        return {
            meta: {
                page,
                limit,
                total: 0,
                totalPages: 0,
            },
            reputation: {
                avg: 0,
                count: 0,
                score: bayesianReputation(0, 0),
            },
            user: {
                _id: user._id,
                name: user.name,
                profile_image: user.profile_image,
            },
            ratings: [],
        };
    }

    const [ratings, total, agg] = await Promise.all([
        BondRating.find({ rated: ratedId, ratedBy: { $nin: blockedObjectIds }, applied: true })
            // Se incluye `reputation` del que puntua para que el front pueda
            // enlazar a su perfil y mostrar su nº de recomendaciones.
            .populate({
                path: 'ratedBy',
                select: 'name profile_image reputation',
            })
            .select('rating comment want offer ratedBy createdAt')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        BondRating.countDocuments({
            rated: ratedId,
            ratedBy: { $nin: blockedObjectIds },
            applied: true,
        }),
        // Media/conteo DERIVADOS EN VIVO de las valoraciones reales, para que la
        // cabecera del perfil siempre coincida con las reseñas visibles aunque
        // la reputacion cacheada este obsoleta.
        BondRating.aggregate([
            { $match: { rated: ratedId, ratedBy: { $nin: blockedObjectIds }, applied: true } },
            {
                $group: {
                    _id: '$rated',
                    avg: { $avg: '$rating' },
                    count: { $sum: 1 },
                },
            },
        ]),
    ]);

    const liveAvg = agg[0]?.avg ?? 0;
    const liveCount = agg[0]?.count ?? 0;

    return {
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
        // avg/count SIEMPRE en vivo; score derivado con la misma funcion bayesiana
        // (garantiza consistencia aunque el cache de NormalUser este obsoleto).
        reputation: {
            avg: liveAvg,
            count: liveCount,
            score: bayesianReputation(liveAvg, liveCount),
        },
        user: {
            _id: user._id,
            name: user.name,
            profile_image: user.profile_image,
        },
        ratings,
    };
};

const BondRatingServices = { addRating, getPublicRatings };
export default BondRatingServices;
