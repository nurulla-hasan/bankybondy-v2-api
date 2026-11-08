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

// Escapa los metacaracteres de expresion regular para evitar inyeccion/errores
// al construir el RegExp a partir del termino de busqueda del usuario.
const escapeRegex = (input: string): string =>
    input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Busqueda ACCESIBLE (insensible a acentos y mayusculas), SIN IA ni aproximacion:
// es normalizacion pura y deterministica. Se le quitan las tildes AL TERMINO y se
// reemplaza cada vocal/consonante base por una clase que matchea todas sus
// variantes acentuadas, de modo que la consulta encuentre el texto guardado tenga
// o no tenga tildes (en cualquier direccion). La bandera 'i' cubre mayusculas.
// Sigue siendo subcadena (substring), asi "guitar" encuentra "guitarra".
// Ej: "filosofia" y "filosofía" -> ambas encuentran "Filosofía", "FILOSOFIA", etc.
const DIACRITIC_CLASSES: Record<string, string> = {
    a: '[aàáâãäå]',
    e: '[eèéêë]',
    i: '[iìíîï]',
    o: '[oòóôõö]',
    u: '[uùúûü]',
    n: '[nñ]',
    c: '[cç]',
};
// Exportada: el buscador de vínculos dentro del perfil (bondRequest.service) usa
// EXACTO el mismo criterio insensible a acentos/mayúsculas, sin duplicar la lógica.
export const buildLooseRegex = (term: string): RegExp => {
    // 1) Quitar tildes del propio termino (NFD + borrar marcas combinantes).
    const stripped = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // 2) Escapar metacaracteres (las letras NO se escapan, quedan intactas).
    const escaped = escapeRegex(stripped);
    // 3) Expandir cada letra base a su clase de variantes acentuadas.
    const pattern = escaped.replace(
        /[aeiounc]/gi,
        (ch) => DIACRITIC_CLASSES[ch.toLowerCase()] ?? ch
    );
    return new RegExp(pattern, 'i');
};

// Distancia en km entre dos puntos GeoJSON [lng, lat] (haversine). Local y
// autocontenida (el helper del matcheo no esta exportado). Se usa solo para
// exponer `distanceKm` en el modo "near"; nunca se exponen las coordenadas.
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

// Solo estos campos puede editar el usuario en su propio perfil.
// NUNCA: subscriptionType, bondLimit, reputation, user, email, role, etc.
// (esto evita el mass-assignment: pedir Premium/bondLimit/reputacion gratis).
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

// PII / campos internos que NO deben viajar cuando un usuario mira el perfil de
// OTRO (Personas / single-user ajeno). Antes solo se borraba `location`, así que
// cualquier usuario autenticado recibía email/teléfono/fecha-de-nac./suscripción/
// límite de bonos + flags internos de otros. El dueño (viendo lo suyo) y el admin
// siguen recibiendo todo. `address` se MANTIENE: es la ciudad que el front muestra
// en las tarjetas de Personas y el perfil público.
const PRIVATE_USER_FIELDS = [
    // Interno: clave de orden de Destacados (vinculosVivos.ts). Además revelaría
    // si alguien que ocultó sus vínculos (`bondsPublic: false`) tiene alguno.
    'hasActiveBonds',
    'email',
    'phone',
    'dateOfBirth',
    'subscriptionType',
    'bondLimit',
    // La URL de PayPal/MP lleva embebido el id del usuario (custom_id /
    // external_reference): no puede viajar en el perfil de otro ni en Personas.
    'pendingSubscriptionCheckout',
    'bondSeq',
    'digestOptOut',
    'mutedNotificationCategories',
    'locationUpdatedAt',
    'locationMode',
    // El rastro de la palanca manual es interno: quién movió el plan de alguien,
    // cuándo y por qué no es asunto de los demás usuarios (y el motivo puede
    // mencionar un contracargo o una disputa).
    'subscriptionSetBy',
    'subscriptionSetAt',
    'subscriptionSetReason',
    'subscriptionHistory',
];
// Orden de Destacados: campo por campo el del índice `personas_destacados`
// (normalUser.model.ts). Si se cambia acá, se cambia allá.
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

    // Whitelist: descartar cualquier campo no permitido del payload.
    const safeUpdate: Partial<INormalUser> = {};
    for (const key of PROFILE_EDITABLE_FIELDS) {
        if (payload[key] !== undefined) {
            (safeUpdate as Record<string, unknown>)[key] = payload[key];
        }
    }

    // Bio: texto libre visible en el perfil. Se censura ANTES de guardar, con la
    // capa COMPLETA (lista dura + moderación gratis + intención gpt-4o-mini, que
    // agarra frases contextuales tipo "drug dealer" que la lista no tiene). Bajo
    // volumen → el costo de la capa paga es casi nulo. Falla CERRADO (retryable)
    // si la moderación no responde: el guardado se rechaza y se reintenta.
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
        // Privacidad: nunca exponer las coordenadas crudas del usuario.
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

        // Busqueda (aditiva): ademas de nombre/email, el termino tambien matchea
        // la bio, el nombre de una skill del usuario y lo que ofrece/busca
        // (offer/want/description de sus bonos vivos). Con termino vacio, el
        // stage queda {} exactamente igual que antes (listado por defecto intacto).
        let searchMatchStage: any = {};
        if (searchTerm) {
            // Regex insensible a acentos Y mayusculas (normalizacion, sin IA).
            const rx = buildLooseRegex(searchTerm);

            // Dos pre-queries baratas en paralelo (indexadas, sin lookups por doc):
            //  - ids de skills cuyo nombre matchea.
            //  - ids de usuarios dueños de un bono vivo (WAITING_FOR_LINK/ONGOING,
            //    no en pausa, no enlazado) cuyo offer/want/description matchea.
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

            // Descubrimiento por CONTENIDO de vínculo respeta la privacidad: si el
            // dueño ocultó sus vínculos (`bondsPublic === false`), NO se lo debe
            // encontrar buscando "parrilla" en Personas por lo que ofrece/busca.
            // (Sí sigue matcheando en las cadenas de intercambio: eso es otro
            // circuito que ignora `bondsPublic`.) Se descartan acá los dueños con
            // vínculos ocultos antes de sumarlos a la búsqueda.
            let visibleBondOwnerIds: any[] = [];
            if (matchedBondOwnerIds.length) {
                visibleBondOwnerIds = await NormalUser.find({
                    _id: { $in: matchedBondOwnerIds },
                    bondsPublic: { $ne: false },
                }).distinct('_id');
            }

            // El EMAIL se sacó de la búsqueda: el email es privado (se recorta de
            // la respuesta con stripPrivateUserFields), pero si además se podía
            // BUSCAR por email, cualquier logueado escribía `victima@correo.com`
            // y, por aparecer o no un perfil, confirmaba que esa cuenta existe y
            // la asociaba a un nombre y una foto (enumeración + mapeo email→
            // identidad). Se busca por nombre, bio, skills y lo que ofrece/busca.
            const orBranches: any[] = [{ name: rx }, { bio: rx }];
            if (matchedSkillIds.length) {
                orBranches.push({ skills: { $in: matchedSkillIds } });
            }
            if (visibleBondOwnerIds.length) {
                orBranches.push({ _id: { $in: visibleBondOwnerIds } });
            }
            searchMatchStage = { $or: orBranches };
        }

        // Bloqueo (B.4): no mostrar a quienes bloquee ni a quienes me bloquearon.
        const blockedIds = await getBlockedObjectIdsFor(userData.profileId);

        // online=true (aditivo): limitar el listado a usuarios actualmente
        // conectados. Se obtienen los profileId online y se convierten a
        // ObjectId (descartando ids invalidos). Si nadie esta online, el
        // $in: [] resultante devuelve vacio correctamente. Cuando el param no
        // viene, onlineObjectIds queda null y el $match no cambia.
        //
        // ⚠️ ESCALA — ESTO ERA UN TECHO DURO (T4 del plan), por partida doble:
        //   1. `SMEMBERS` del Set entero: comando O(N) contra un Redis de un solo
        //      hilo, el mismo que atiende BullMQ, los rate limits y el adapter de
        //      sockets. Con decenas de miles de conectados bloquea a todos.
        //   2. Y el resultado iba a un `$in` de Mongo con ESA MISMA cantidad de
        //      ObjectIds. Un `$in` de 50.000 elementos no es una consulta: es una
        //      forma cara de hacer un COLLSCAN.
        //
        // Ahora se pide una MUESTRA acotada (`SRANDMEMBER key <tope>`), que no
        // recorre el Set. Es un cambio de semántica y hay que decirlo con todas
        // las letras: por encima del tope, "Personas online" deja de ser "todos
        // los conectados" y pasa a ser "hasta N conectados, tomados al azar".
        //
        // Se eligió a conciencia sobre las alternativas: paginar el Set con SSCAN
        // no compone con los otros filtros (bloqueados, cercanía) ni con el orden;
        // y mover la presencia a Mongo para poder filtrar ahí sería escribir en la
        // base en cada conexión y desconexión.
        //
        // ⚠️ LO QUE LA MUESTRA CUESTA, DICHO SIN ADORNOS (panel del 11/9): por
        // encima del tope, "Personas online" deja de ser paginable de forma
        // coherente. `SRANDMEMBER` devuelve una muestra DISTINTA en cada request,
        // así que la página 2 se calcula sobre otro conjunto que la página 1 → se
        // repiten perfiles, se pierden otros, y el total baila entre requests. Es
        // una vidriera, no un listado. Por debajo del tope (que es donde está el
        // producto hoy, y por bastante) la respuesta es EXACTA: `SRANDMEMBER` con
        // count ≥ cardinalidad devuelve el Set entero.
        //
        // El caso `near + online` NO usa esto: ahí hay una lista de candidatos y se
        // pregunta exacto con `filtrarOnline`. Ver más abajo.
        //
        // `||` y no `??`: la convención del repo (17 de 19 usos) y por un motivo
        // concreto — `PEOPLE_ONLINE_SAMPLE_MAX=` vacío en un `.env`, que es la
        // forma más común de dejar una variable anotada, da `Number('') === 0` y
        // con `??` el filtro devolvería UN usuario, en silencio.
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

        // near=true (aditivo): limita y ORDENA el listado por cercania geografica
        // al que consulta. Requiere ubicacion guardada del consultante; si no la
        // tiene, se devuelve vacio con needsLocation:true para que el front pida
        // permiso de ubicacion. Los ids vienen del $near (mas cercanos primero) y
        // se calcula distanceKm por usuario (haversine). NUNCA se exponen coords.
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
                // Privacidad: ocultar del listado a quien se oculto de Personas
                // (listedInPeople === false). Los legados / true siguen visibles.
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

            // Orden por cercania (nearest-first) preservado.
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

        // Combinar las restricciones de _id ($in) de near y online. Si ambos
        // estan activos, se intersecta preservando el orden por cercania.
        let idInList: mongoose.Types.ObjectId[] | null = null;
        if (nearIds && query?.online === 'true') {
            // CERCANÍA + ONLINE: acá NO se muestrea, se pregunta EXACTO.
            //
            // Ya tenemos en memoria la lista acotada de vecinos, así que
            // `SMISMEMBER` contesta "¿cuáles de estos están online?" en O(vecinos)
            // y con la verdad completa. Intersectar contra una MUESTRA sería
            // desastroso justo acá: con 50.000 conectados y tope 2.000, la muestra
            // cubre el 4% → el usuario vería ~12 de sus 300 vecinos conectados, y
            // una docena DISTINTA en cada refresco. Eso no es una aproximación, es
            // ruido. (Panel del 11/9.)
            const onlineSet = await filtrarOnline(
                nearIds.map((id) => id.toString())
            );
            idInList = nearIds.filter((id) => onlineSet.has(id.toString()));
        } else if (nearIds) {
            idInList = nearIds;
        } else if (onlineObjectIds) {
            idInList = onlineObjectIds;
        }

        // sort=featured / sort=reputation (aditivo): ordena TODO el conjunto
        // filtrado antes de paginar. Se coloca antes del $facet, por lo que el
        // $skip/$limit opera sobre el orden global y no por pagina. Sin param
        // de sort, no se añade ningun $sort (se conserva el orden por defecto
        // actual, byte-for-byte).
        let sortStages: mongoose.PipelineStage[] = [];
        if (query?.sort === 'reputation') {
            // Los valores faltantes de reputation.score quedan al final por el
            // desempate con _id.
            sortStages = [{ $sort: { 'reputation.score': -1, _id: 1 } }];
        } else if (query?.sort === 'featured') {
            // Destacados: prioridad (1) tener algun bono vivo (algo para
            // intercambiar), (2) reputacion, (3) actividad reciente. (1) es
            // `hasActiveBonds`, GUARDADO en el usuario (vinculosVivos.ts). Antes
            // se calculaba acá en cada carga: un `distinct` sobre los vínculos
            // (docs de 40 KB) y un `$in` de todos los dueños contra todos los
            // usuarios. Cuadrático: el primer muro de escala medido (29/9).
            sortStages = [{ $sort: ORDEN_DESTACADOS }];
        }

        // near tiene PRECEDENCIA sobre sort=reputation/featured: cuando near=true
        // el orden global es por cercania (rank del arreglo nearIds, ya ordenado).
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

        // Enriquecimiento de cada tarjeta (estado de amistad con quien mira y
        // nombres de las skills). Corre SOLO sobre la página, dentro del `$facet`
        // y después del `$limit`: ninguna etapa filtra ni cambia el orden, así
        // que el resultado es el mismo, pero antes corría para TODOS los usuarios
        // antes de paginar (un `$lookup` con `$expr` por persona). Medido el 29/9:
        // con 3.000 usuarios, 2 s por carga contra ~0,3 s.
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
                                    // then: 'following_pending',
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
                                    // then: 'follower_pending',
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
                                    // then: 'following_rejected',
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
                                    // then: 'follower_rejected',
                                    then: 'follower',
                                },
                            ],
                            default: 'none',
                        },
                    },
                },
            },
            {
                $project: { friendRequests: 0 }, // remove friendRequests array
            },
            // Resolver skills (ObjectId -> { _id, name }) para las tarjetas de
            // Personas/perfil. No se elimina ningún campo existente.
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

        // DESTACADOS SIN FILTROS (la pantalla por defecto de Personas): camino por
        // índice. `$match` → `$sort` sobre `personas_destacados` → `$skip`/`$limit`
        // → enriquecimiento de la página, y el total con un `countDocuments`
        // aparte. Sin ordenar a todos en memoria: la página p lee ~15·p usuarios
        // (entrada del índice y documento: el `$skip` también se camina) y el
        // total es un conteo lineal (~40-70 ms con 30.000 usuarios). Medido el
        // 29/9: 30.000 usuarios, p95 < 0,8 s con 20 cargas a la vez en 2 vCPU.
        // Mismo resultado que el camino general, verificado.
        //
        // Los baneados por admin se excluyen igual que en el camino general, por
        // `NormalUser.user` → `User._id`, pero con un `$nin` y no con el `$lookup`
        // por persona: un `$lookup` antes del `$sort` le impide a Mongo ordenar
        // por el índice. NO por `User.profileId`: puede no apuntar a su perfil
        // (null en un alta social a medio hacer, u otro perfil).
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
            // Misma forma que el `$facet` del camino general: sin resultados,
            // `meta` queda vacío y cae en el default de más abajo.
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
                    // Privacidad: excluir del listado (y su busqueda) a quien se
                    // oculto de Personas. NO afecta el matcheo ni el link directo.
                    // { $ne: false } deja visibles los legados (campo ausente) y true.
                    listedInPeople: { $ne: false },
                    _id: {
                        $ne: callerObjectId,
                        ...(blockedIds.length ? { $nin: blockedIds } : {}),
                        ...(idInList ? { $in: idInList } : {}),
                    },
                },
            },
            // C.5 (Tanda 2): excluir del listado a usuarios bloqueados por un
            // admin (User.isBlocked = true). Se resuelve el User via
            // NormalUser.user y se descartan los bloqueados.
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
            // sort=featured / sort=reputation (aditivo): $sort global antes del
            // $facet (definido arriba en sortStages). Vacio cuando el param no
            // viene (orden por defecto intacto).
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
            // near mode: exponer SOLO la distancia (numero), nunca las coords.
            if (distanceByUser) {
                const km = distanceByUser.get(u._id?.toString());
                if (typeof km === 'number') u.distanceKm = km;
            }
            // Privacidad: nunca exponer las coordenadas crudas del usuario.
            delete u.location;
            // PII: esta rama es SOLO para usuarios comunes (el admin tiene su
            // rama con el doc completo). Se recorta email/teléfono/PII interna.
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

// get single user
const getSingleUser = async (viewer: JwtPayload, id: string) => {
    const user = await getSingleUserWithStatus(viewer.profileId, id);
    // PII: si el que mira NO es el dueño del perfil NI un admin, se recorta la
    // PII/campos internos (mismo criterio que el listado de Personas). El dueño
    // viendo lo suyo (edición de perfil) y el admin reciben todo.
    const isSelf = String(viewer.profileId) === String(id);
    const isAdmin =
        viewer.role === USER_ROLE.admin ||
        viewer.role === USER_ROLE.superAdmin;
    const result = { ...user };
    if (!isSelf && !isAdmin) {
        stripPrivateUserFields(result);
    }
    // LAS NOTAS DE OPERADOR NO VAN NI AL PROPIO DUEÑO. El resto de la PII sí (es
    // su email, su teléfono, su plan), pero `subscriptionSetReason` es una nota
    // ENTRE OPERADORES: el placeholder de la UI del dashboard sugiere escribir
    // cosas como "contracargo del pago X". Que eso le llegue al usuario en el
    // JSON de su propio perfil no es transparencia, es filtrar una anotación
    // interna sobre una disputa. El historial completo, por la misma razón.
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

    // Si existe un usuario que visualiza (viewer) y el objetivo esta en una
    // relacion de bloqueo con el (en cualquier direccion), tratamos el perfil
    // como inexistente para no revelar su existencia.
    if (currentProfileId) {
        const blockedIds = await getBlockedIdsFor(currentProfileId);
        if (blockedIds.includes(targetUserId)) {
            throw new AppError(httpStatus.NOT_FOUND, 'User not found');
        }
    }

    const currentId = new mongoose.Types.ObjectId(currentProfileId);
    const targetId = new mongoose.Types.ObjectId(targetUserId);

    // Bloqueo ADMINISTRATIVO (User.isBlocked): el listado de Personas ya lo
    // excluye con un lookup a `users` (ver C.5, más arriba en este archivo), pero
    // acá se hacía sólo `$match` por _id. Resultado: un perfil bloqueado por un
    // admin desaparecía del listado pero seguía visible entrando por URL directa
    // a /normal-user/single-user/:id — la moderación quedaba a medias.
    // Se responde 404 igual que con el bloqueo entre usuarios, para no revelar
    // que la cuenta existe.
    const targetAccount = await NormalUser.findById(targetId)
        .select('user listedInPeople')
        .populate({ path: 'user', select: 'isBlocked' })
        .lean();

    // Bloqueo ADMINISTRATIVO PRIMERO: una cuenta suspendida por un admin responde
    // 404 (indistinguible de "no existe"), ANTES de evaluar si está oculta. Si se
    // mirara el ocultamiento primero, una cuenta suspendida Y oculta devolvería un
    // 403 PROFILE_HIDDEN y así revelaría su existencia (que es una cuenta oculta).
    // El 404 tiene que ganar para no filtrar información de cuentas moderadas.
    if ((targetAccount as any)?.user?.isBlocked === true) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    // Perfil OCULTO (listedInPeople === false): modelo tipo "cuenta privada".
    //  - El DUEÑO siempre ve el suyo.
    //  - Un AMIGO (solicitud aceptada en cualquier sentido) también lo ve: ocultar
    //    es ocultarse de los desconocidos, no de la gente que ya aceptaste.
    //  - Cualquier OTRO recibe un 403 con code 'PROFILE_HIDDEN', para que el front
    //    muestre un cartel amable "este perfil está oculto" en vez del error
    //    genérico. Es distinto del 404 de "no existe / bloqueado", que se mantiene
    //    indistinguible a propósito (no revelar cuentas / respetar moderación).
    // El matcheo y la subida de audio ignoran este flag: la persona sigue
    // matcheando y participando de las cadenas igual.
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
        // Match the target user (do NOT exclude self here; if you want to, add {_id: {$ne: currentId}})
        { $match: { _id: targetId } },

        // Find friend requests between current user and target user (both directions)
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
                    // (Optional) project only needed fields to reduce memory
                    { $project: { status: 1, sender: 1, receiver: 1, _id: 0 } },
                ],
                as: 'friendRequests',
            },
        },

        // Derive friendRequestStatus (same ordering/precedence you used)
        {
            $addFields: {
                friendRequestStatus: {
                    $switch: {
                        branches: [
                            // If there's any Accepted request in either direction => "friend"
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

                            // If current -> other with Pending => "following"
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

                            // If other -> current with Pending => "follower"
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

                            // Si YO mandé la solicitud y me la RECHAZARON, la
                            // relación es inexistente, no 'following'. Mapearla a
                            // 'following' dejaba el botón en "Siguiendo", que no
                            // tiene acción: la persona no podía volver a enviar
                            // nunca, aunque el modelo lo permite a propósito (el
                            // índice único es PARCIAL sobre status:Pending, y su
                            // comentario dice explícitamente que un mismo par
                            // puede volver a solicitarse en el futuro).
                            // Con 'none' el botón vuelve a ofrecer enviar.
                            // (Si te hartan, para eso está bloquear.)
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

                            // If other -> current with Rejected => "follower" (your current logic)
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

        // Don't leak the raw requests array
        { $project: { friendRequests: 0 } },

        // Resolver skills (ObjectId -> { _id, name }) para el perfil. No se
        // elimina ningún campo existente.
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

    // Privacidad: nunca exponer las coordenadas crudas del usuario.
    delete (doc as any).location;

    // Reputacion DERIVADA EN VIVO de las valoraciones reales del usuario, para
    // que la cabecera del perfil siempre coincida con las reseñas visibles
    // aunque el cache `reputation` de NormalUser este obsoleto. Agregacion de un
    // solo usuario (barata). Se sobreescriben avg/count sobre el objeto devuelto
    // y se recalcula el score con la misma funcion bayesiana.
    // `applied:true`: cuenta SOLO las reseñas ya aplicadas (trueque cerrado),
    // igual que reputation.util y getPublicRatings. Sin este filtro la cabecera
    // sumaría reseñas en suspenso y mostraría un número distinto al de la lista
    // de reseñas y al del matcheo (tres cuentas incoherentes en la misma vista).
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

// Actualiza la geolocalizacion del usuario que consulta. Guarda un GeoJSON
// Point [lng, lat], la marca de tiempo y el modo (auto/manual). Devuelve la
// vista compacta que necesita el front (nunca las coordenadas crudas anidadas).
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

/* PRECIOS DE LOS PLANES — lo que la página de suscripciones tiene que MOSTRAR.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POR QUÉ EXISTE: EL PRECIO QUE SE MOSTRABA NO ERA EL QUE SE COBRABA.
 *
 * La página calculaba el precio en pesos ELLA MISMA, en el navegador:
 *     MP_USD hardcodeado en el front (8 / 15)  ×  cotización EN VIVO de dolarapi
 * mientras el servidor cobraba con OTRA cuenta:
 *     MP_USD_STANDARD/PREMIUM del .env  ×  su propia cotización CACHEADA 1 HORA
 *
 * Dos cuentas distintas con dos fuentes distintas: el número que veía la persona
 * y el que se le cobraba casi nunca coincidían —diferían en lo que se hubiera
 * movido el blue en esa hora— y si alguna vez se cambiaba el `.env`, el front
 * seguía mostrando 8 y 15 para siempre. Encima, si dolarapi le fallaba al
 * navegador, el botón no mostraba precio ninguno.
 *
 * Para un producto cuyo moat declarado es la honestidad, eso en la pantalla de
 * pago no se lanza. Ahora hay UNA fuente: este endpoint devuelve los dos precios
 * reales, calculados con la MISMA cotización cacheada que se va a usar al cobrar,
 * y la página no calcula nada.
 *
 * Degrada con gracia: si no se puede cotizar el dólar, `mercadopago` viene en
 * null y la página muestra PayPal igual. Mejor sin un precio que con uno inventado.
 */
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
                          // MISMO redondeo que `usdToPesos`, que es lo que se le
                          // manda a MercadoPago como `unit_price`. Si acá se
                          // redondeara distinto, volvería el problema en chico.
                          amount: Math.round(p.usdMercadopago * rate),
                          usdBase: p.usdMercadopago,
                      }
                    : null,
        };
    });

    return { plans, dollarRate: rate };
};

/* LA PALANCA MANUAL DEL PLAN (admin) — la que hoy no existe.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * POR QUÉ HACE FALTA, Y POR QUÉ ANTES DE LANZAR
 *
 * La suscripción es DE POR VIDA: se paga una vez y no vence. Eso significa que
 * ante un CONTRACARGO —alguien paga, recibe Premium, desconoce el cobro y le
 * devuelven la plata— hoy no hay NINGUNA palanca, ni siquiera manual: el
 * dashboard sólo muestra un resumen (`SubscriptionOverview.jsx`). Esa persona se
 * queda con Premium gratis para siempre.
 *
 * Y sirve para lo contrario, que es igual de importante: si la guarda
 * anti-downgrade rechaza una acreditación legítima, o un pago queda fuera de la
 * banda de monto, alguien pagó y no tiene su plan. Sin esta palanca la única
 * salida era tocar la base a mano.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DOS DECISIONES:
 *
 *  · **Puede BAJAR el plan**, a diferencia de la acreditación automática. Es todo
 *    el punto: es la única vía por la que un plan puede bajar, y es deliberada,
 *    humana y auditada.
 *  · **Deja rastro** (quién, cuándo, por qué). Una palanca que mueve plata sin
 *    registro es peor que no tenerla: ante una disputa no habría forma de
 *    reconstruir qué pasó.
 */
const setSubscriptionByAdmin = async (
    adminUserId: string,
    profileId: string,
    tipo: string,
    motivo?: string
) => {
    if (!esTipoPlan(tipo)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid subscription plan');
    }
    // Mismo criterio que en la acreditación: un id inusable NUNCA puede llegar a
    // mongoose, porque un filtro vacío escribiría sobre el primer documento de la
    // colección. Acá además el efecto sería otorgar un plan a quien no pagó.
    if (!esObjectIdUsable(profileId)) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid user id');
    }

    const plan = PLANES[tipo];
    const ahora = new Date();
    const razon = (motivo || '').slice(0, 500);

    // El plan ANTERIOR se lee antes de pisarlo: sin eso, la fila del historial no
    // permite saber si el cambio fue una baja (contracargo) o una suba.
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
                // Denormalizado del último cambio (para listar sin abrir el array).
                subscriptionSetBy: adminUserId,
                subscriptionSetAt: ahora,
                subscriptionSetReason: razon,
            },
            // Y el HISTORIAL, que es lo que de verdad permite reconstruir una
            // disputa. Acotado a 50 entradas: es una palanca manual, nunca va a
            // tener volumen, y el tope evita que un documento crezca sin límite.
            $push: {
                subscriptionHistory: {
                    $each: [
                        {
                            type: plan.tipo,
                            by: adminUserId,
                            at: ahora,
                            reason: razon,
                            // Fallback explícito: mongoose DESCARTA las claves
                            // `undefined` del `$push`, así que un usuario sin
                            // `subscriptionType` dejaba la fila SIN el campo — y
                            // `from` existe justamente para poder leer si el
                            // cambio fue una baja o una suba. Sin él, la fila del
                            // contracargo no dice de dónde venía.
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
    // Ruta MercadoPago (paralela a PayPal). Devuelve la URL de Checkout Pro.
    //
    // CON try/catch, igual que la rama de PayPal. Sin esto, cualquier falla del
    // SDK o de la API de MercadoPago —una preferencia rechazada, un timeout, una
    // credencial vencida— salía como un 500 "Something went wrong" genérico,
    // porque no es un `AppError` y no matchea ninguna rama del manejador global.
    // En la pantalla de pago, y con la otra pasarela mostrando un mensaje
    // decente. Era una asimetría sin motivo.
    try {
        const { url } = await createSubscriptionPreference(userId, type);
        return url;
    } catch (error) {
        // eslint-disable-next-line no-console
        console.error('MercadoPago Preference Error:', error);
        // Si ya es un AppError (p. ej. "no se pudo obtener la cotización"), se
        // respeta: ese mensaje es más útil que uno genérico.
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
    // EL PRECIO SALE DE `subscriptionPlans`, NO DE UN LITERAL ACÁ.
    //
    // Antes esto decía `if (Standard) 10 else 25`, y `creditPayment` tenía su
    // PROPIO mapa 10→Standard / 25→Premium para acreditar POR MONTO. Los dos
    // tenían que coincidir exacto: cambiar el precio acá y olvidarse del otro
    // significa **que se cobra y no se acredita** (la acreditación devuelve
    // `unexpected amount`, la persona paga y no recibe nada, y hace falta tocar
    // la base a mano). Ahora las dos puntas leen el mismo número.
    //
    // El `else` implícito tampoco estaba bien: cualquier tipo distinto de
    // Standard cobraba 25. Hoy zod ya acota `type` al enum, pero la guarda
    // explícita no depende de que esa validación siga estando.
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
                // `brand_name` es lo que PayPal le muestra EN LA PANTALLA DE PAGO
                // a la persona que está por pagar. Decía, literal, "Your Business
                // Name": el placeholder de la plantilla, vivo en producción, en la
                // única pantalla donde alguien entrega plata.
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

    // Tipo válido ANTES de reclamar el checkout: un tipo inválido no debe dejar
    // un reclamo pendiente ni llegar a `nivelDe` (que lo trataría como Free).
    if (!esTipoPlan(type) || PLANES[type].nivel === 0) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Invalid subscription plan');
    }

    /* ⚠️ NO COBRAR LO QUE NO SE PUEDE ENTREGAR (panel del 11/9).
     *
     * La guarda anti-downgrade de `creditPayment` impide que un pago BAJE un plan.
     * Correcto — pero miraba el problema por la puerta de atrás (los webhooks) y
     * dejaba la de adelante abierta:
     *
     *   1. Alguien con Premium entra a esta pantalla. Los tres botones se ven
     *      iguales: la página no sabe qué plan tiene.
     *   2. Clickea "Pagar con PayPal (US$ 10)" en Standard.
     *   3. PayPal cobra. Se crea la `Transaction`: la plata entra.
     *   4. La guarda hace su trabajo y NO aplica Standard sobre Premium.
     *   5. Esa persona pagó 10 dólares por absolutamente nada, y ve "pago
     *      recibido".
     *
     * Lo mismo en chico si un Standard vuelve a comprar Standard.
     *
     * El arreglo correcto NO es avisar después: es no abrir el checkout. Acá se
     * rechaza antes de tocar PayPal o MercadoPago, así que no hay plata que
     * devolver. El `code` permite que el front muestre un mensaje propio.
     *
     * Se compara por NIVEL y no por igualdad para cubrir también el caso
     * "Premium comprando Standard", que es el que pierde más plata.
     */
    if (nivelDe(type) <= nivelDe((user as any).subscriptionType)) {
        throw new AppError(
            httpStatus.CONFLICT,
            'You already have this plan or a higher one.',
            'PLAN_ALREADY_OWNED'
        );
    }

    const proveedor = normalizarProveedor(provider);
    const ahora = Date.now();

    // Checkout vigente: devolver la MISMA URL en vez de crear otra orden. Es la
    // diferencia entre un doble clic y una segunda orden pagable.
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

    // Reclamo ATÓMICO antes de crear la orden. Si otra request ya tiene un
    // checkout fresco del mismo plan+proveedor, el filtro no matchea y no se
    // crea una segunda URL. `url: ''` marca "creando"; se libera sola a los 30 s
    // (ver subscriptionCheckout.ts).
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
        // Perdimos el reclamo: si la otra request ya escribió la URL, es la misma
        // que este request iba a crear. Si todavía está creando, no se abre una
        // segunda orden: 409 y el front muestra un mensaje propio.
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

        // Guardado condicionado al reclamo que hicimos: si otro request tomó el
        // documento (vencido / otro plan), no se pisa su URL.
        await NormalUser.updateOne(filtroReclamo, {
            $set: { 'pendingSubscriptionCheckout.url': url },
        });
        return { url };
    } catch (error) {
        // Liberar el reclamo para reintentar sin esperar los 30 s.
        try {
            await NormalUser.updateOne(filtroReclamo, {
                $unset: { pendingSubscriptionCheckout: '' },
            });
        } catch {
            // best-effort: el reclamo también vence solo a los 30 s
        }
        throw error;
    }
};

const updateBondsVisibility = async (id: string, bondsPublic: unknown) => {
    const updated = await NormalUser.findByIdAndUpdate(
        id,
        // Boolean estricto: 'false' (string) con Boolean() daria true -> quedaria
        // publico sin querer. Publico SOLO ante true o 'true'; cualquier otra cosa, privado.
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
        // Boolean estricto (igual criterio que bondsPublic): 'false' (string) con
        // Boolean() daria true -> aparecer sin querer. Listado SOLO ante true o
        // 'true'; cualquier otra cosa, oculto.
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
