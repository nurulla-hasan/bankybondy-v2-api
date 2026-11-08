import { model, Schema } from 'mongoose';
import { MATCHING } from '../bondRequest/matching.config';
import { ENUM_GENDER } from '../user/user.enum';
import { ENUM_SUBSCRIPTION_TYPE } from './normalUser.enum';
import { INormalUser } from './normalUser.interface';

const NormalUserSchema = new Schema<INormalUser>(
    {
        user: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: 'User',
        },
        // username: {
        //     type: String,
        //     required: true,
        // },
        name: {
            type: String,
            required: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
        },
        phone: {
            type: String,
        },
        profile_image: {
            type: String,
            default: '',
        },
        cover_image: {
            type: String,
            default: '',
        },
        gender: {
            type: String,
            enum: Object.values(ENUM_GENDER),
        },
        dateOfBirth: {
            type: Date,
        },
        address: {
            type: String,
        },
        bio: {
            type: String,
        },
        skills: [
            {
                type: Schema.Types.ObjectId,
                ref: 'Skill',
            },
        ],
        socialLinks: {
            type: [String],
            default: [],
        },
        subscriptionType: {
            type: String,
            enum: Object.values(ENUM_SUBSCRIPTION_TYPE),
            default: ENUM_SUBSCRIPTION_TYPE.Free,
        },
        bondLimit: {
            type: Number,
            default: 25,
        },
        // RASTRO DE LA PALANCA MANUAL (admin). La suscripción es de por vida, así
        // que la única vía por la que un plan puede BAJAR es un admin decidiéndolo
        // a mano (contracargo), y la única por la que puede subir sin pago es un
        // admin reparando algo. Las dos mueven plata: tienen que dejar registro.
        //
        // ⚠️ ES UN HISTORIAL, NO UN CASILLERO. La primera versión guardaba sólo el
        // ÚLTIMO cambio y el comentario prometía "reconstruir qué pasó ante una
        // disputa". No lo cumplía: si el 3/2 un admin baja a Free por un
        // contracargo y el 5/2 otro lo sube a Premium porque el usuario reclamó,
        // el `$set` del segundo BORRABA el registro del contracargo — justo el
        // dato que la disputa necesita. Ahora se apila con `$push` + `$slice`
        // (mismo patrón acotado que `notifiedSignatures` en las notificaciones).
        subscriptionHistory: {
            type: [
                {
                    _id: false,
                    type: { type: String },
                    by: { type: Schema.Types.ObjectId, ref: 'User' },
                    at: { type: Date },
                    reason: { type: String },
                    // El plan que tenía ANTES. Sin esto no se puede saber si un
                    // cambio fue una baja o una suba mirando sólo la fila.
                    from: { type: String },
                },
            ],
            default: [],
        },
        // Denormalizado del último elemento del historial, para poder listar y
        // filtrar sin abrir el array.
        subscriptionSetBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
        },
        subscriptionSetAt: { type: Date },
        subscriptionSetReason: { type: String },
        // Último tope por el que ya se avisó el empujón de suscripción (una vez por
        // tope). Ver la notificación SUBSCRIPTION en bondRequest.service.
        subscriptionNudgeAt: {
            type: Number,
            default: 0,
        },
        // Checkout iniciado y todavía no pagado. Se reutiliza su URL mientras siga
        // fresco (ver subscriptionCheckout.ts) para que dos pestañas no generen
        // dos órdenes pagables del mismo plan. `url: ''` = reclamo en curso.
        pendingSubscriptionCheckout: {
            plan: {
                type: String,
                enum: [
                    ENUM_SUBSCRIPTION_TYPE.Standard,
                    ENUM_SUBSCRIPTION_TYPE.Premium,
                ],
            },
            provider: {
                type: String,
                enum: ['paypal', 'mercadopago'],
            },
            // Sin `default`: un `default` acá haría que TODO documento nuevo
            // nazca con `pendingSubscriptionCheckout: { url: '' }`, como si
            // tuviera un checkout en curso.
            url: {
                type: String,
            },
            createdAt: {
                type: Date,
            },
        },
        // Contador-guardia interno para serializar creaciones concurrentes de
        // vínculos (fix de carrera del bondLimit). Solo se incrementa dentro de la
        // transacción de creación; su valor no significa nada de negocio.
        bondSeq: {
            type: Number,
            default: 0,
        },
        // Privacidad: si es false, otros usuarios no ven la lista de vinculos
        // en el perfil (solo el conteo). El dueno siempre ve los suyos.
        bondsPublic: {
            type: Boolean,
            default: true,
        },
        // Privacidad: si es false, el perfil se OCULTA del listado de Personas y
        // de su busqueda. NO afecta el matcheo (los bonos siguen entrando en las
        // cadenas) ni el acceso por link directo (/people/:id sigue funcionando).
        // Default true = aparece en el listado (comportamiento actual).
        listedInPeople: {
            type: Boolean,
            default: true,
        },
        // "Tiene al menos un vínculo vivo": primera clave de orden de Personas en
        // Destacados. Lo escriben sólo el alta de vínculos (en su transacción) y
        // vinculosVivos.ts. Interno: está en PRIVATE_USER_FIELDS y no se devuelve.
        hasActiveBonds: {
            type: Boolean,
            default: false,
        },
        // Silenciado de notificaciones por CATEGORIA (Tanda C). Lista de
        // categorias que el usuario silencio ('matches'|'trueques'|'resenas'|
        // 'amistades'). No se dejan de crear: solo no suman al globito.
        mutedNotificationCategories: {
            type: [String],
            default: [],
        },
        // Baja del resumen/digest semanal (List-Unsubscribe). true = NO recibe el
        // digest automático. No afecta transaccionales. Default false (suscripto).
        digestOptOut: {
            type: Boolean,
            default: false,
        },
        // Reputacion cacheada (se recalcula al recibir un BondRating).
        reputation: {
            avg: { type: Number, default: 0 },
            count: { type: Number, default: 0 },
            // neutro / cold-start, alineado con REP_PRIOR de la config del matcheo.
            score: { type: Number, default: MATCHING.reputation.prior },
        },
        // Geolocalizacion (GeoJSON Point [lng, lat]). Opcional. Se usa para el
        // modo "near" del listado de Personas y para heredar la ubicacion al
        // crear un bond sin coordenadas. NUNCA se expone al cliente.
        location: {
            type: {
                type: String,
                enum: ['Point'],
            },
            // `default: undefined` evita que Mongoose materialice coordinates: []
            // en cada alta; así el campo `location` queda OMITIDO cuando no hay
            // ubicación, y el índice 2dsphere (sparse por doc sin el campo) no
            // rompe el insert de usuarios nuevos (registro / Google login).
            coordinates: {
                type: [Number],
                default: undefined,
            },
        },
        locationUpdatedAt: {
            type: Date,
        },
        locationMode: {
            type: String,
            enum: ['auto', 'manual'],
        },
    },
    {
        timestamps: true,
    }
);
// Indice geoespacial para consultas $near / $geoWithin sobre location.
NormalUserSchema.index({ location: '2dsphere' });
// Soporta el filtro sort=reputation (ordena por reputation.score desc).
NormalUserSchema.index({ 'reputation.score': -1 });
// Destacados (el modo por defecto de Personas): el MISMO orden de la pantalla,
// campo por campo y en el mismo sentido, para que la página salga de recorrer el
// índice y no de un sort en memoria de todos los usuarios. La página p lee
// ~15·p usuarios: el `$skip` también se camina.
NormalUserSchema.index(
    { hasActiveBonds: -1, 'reputation.score': -1, updatedAt: -1, _id: 1 },
    { name: 'personas_destacados' }
);
const NormalUser = model<INormalUser>('NormalUser', NormalUserSchema);

export default NormalUser;
