/* eslint-disable @typescript-eslint/no-explicit-any */
import { Schema, model } from 'mongoose';
import {
    ENUM_BOND_MODALITY,
    ENUM_BOND_REQUEST_STATUS,
} from './bondRequest.enum';
import { IBondRequest } from './bondRequest.interface';

const BondRequestSchema = new Schema<IBondRequest>(
    {
        user: {
            type: Schema.Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
        offer: { type: String, required: true },
        want: { type: String, required: true },
        // Ubicación OPCIONAL. Un usuario sin ubicación guardada (o un bond
        // 'online') debe poder crear bonds sin coordenadas. Cuando no hay coords,
        // el servicio NO adjunta este subdocumento (un `location` parcial rompería
        // el índice 2dsphere). Los caminos geo/$near ya toleran su ausencia.
        location: {
            // Sin `default` en `type` y con `coordinates` en `default: undefined`,
            // Mongoose OMITE el subdocumento `location` por completo cuando no hay
            // coords (mismo patrón probado en NormalUser). Así no queda un
            // `{type:'Point'}` parcial que rompería el índice 2dsphere y haría
            // crashear el cómputo de matcheo al destructurar coordinates.
            type: {
                type: String,
                enum: ['Point'],
            },
            coordinates: { type: [Number], default: undefined, index: '2dsphere' },
        },
        description: {
            type: String,
            default: '',
        },
        status: {
            type: String,
            enum: Object.values(ENUM_BOND_REQUEST_STATUS),
            default: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        },
        radius: { type: Number },
        modality: {
            type: String,
            enum: Object.values(ENUM_BOND_MODALITY),
            default: ENUM_BOND_MODALITY.PHYSICAL,
        },
        isLinked: {
            type: Boolean,
            default: false,
        },
        isPause: {
            type: Boolean,
            default: false,
        },
        // SOFT-DELETE. Un bono que participó de un vínculo COMPLETADO no se puede
        // borrar de verdad: el BondLink lo referencia y la reseña (BondRating)
        // cuelga de él. Si se hacía hard-delete, quedaba una referencia colgada y
        // la reputación —que la persona ganó en intercambios reales— se perdía.
        // Con esta marca el documento sobrevive para el historial y la reseña,
        // pero desaparece de los listados y NO consume cupo del bondLimit.
        // Los bonos sin ningún vínculo se siguen borrando de verdad.
        isDeleted: {
            type: Boolean,
            default: false,
        },
        offerVector: {
            type: [Number],
            required: true,
            validate: (v: any) => Array.isArray(v) && v.length > 0,
        },
        wantVector: {
            type: [Number],
            required: true,
            validate: (v: any) => Array.isArray(v) && v.length > 0,
        },
        // Marca de tiempo del último cómputo de matches (lo fija el robot al
        // terminar `computeAndCacheMatches`). Permite distinguir en el serving
        // "aún computando" de "ya computado, cero matches": si es reciente (dentro
        // del TTL) y no hay cache, es cero matches y el front deja de sondear.
        matchesComputedAt: { type: Date },
        // AGENDA del próximo recómputo (escala: ver matching.schedule.ts).
        //
        // Es un instante FUTURO, no historia. Con esto el sweep es UNA consulta
        // —`matchesNextAt <= ahora`— resuelta por un solo índice, en vez de una
        // consulta por nivel de temperatura con rangos distintos.
        //
        // El `default` en la ÉPOCA es deliberado y hace dos cosas: un vínculo
        // recién creado nace con la agenda vencida (se computa enseguida), y el
        // campo está SIEMPRE PRESENTE — que es lo que permite que el filtro del
        // sweep sea un rango puro y el índice provea también el orden. Con
        // `$exists: false` había que meter un `$or`, y ese `$or` forzaba un sort
        // bloqueante de 32 MB que con lote 1.500 desbordaba. Ver AGENDA_VENCIDA.
        //
        // NO reemplaza a `matchesComputedAt`: ése lo usa el serving para
        // distinguir "todavía computando" de "ya computado, cero matches", y se
        // deja intacto a propósito.
        matchesNextAt: { type: Date, default: () => new Date(0) },
        // GENERACIÓN de la caché de matches. La invalidación la incrementa; el
        // cómputo se queda con la que leyó al empezar y sólo sella su resultado si
        // no cambió. Es lo que evita que un cómputo que arrancó ANTES de una
        // invalidación pise el estado con datos viejos: sin esto, ese cómputo
        // agendaba el vínculo a 24 h con matches obsoletos, y como la invalidación
        // había encolado un job que BullMQ descartó por jobId ocupado, no lo
        // rescataba nadie. Antes el mismo agujero se cerraba solo en ≤60 min;
        // con TTL frío duraba 24 veces más.
        matchesGen: { type: Number, default: 0 },
        // Última vez que el DUEÑO abrió la pantalla de coincidencias de este
        // vínculo. Única señal honesta de interés real, y por eso la que decide la
        // temperatura junto con `createdAt`.
        //
        // Por qué no `updatedAt`: el schema tiene `timestamps: true`, así que
        // nuestra propia contabilidad (sellar matchesComputedAt, el $unset de la
        // invalidación) lo pisa. `updatedAt` mide nuestro trabajo, no el del
        // usuario.
        lastServedAt: { type: Date },
    },
    {
        timestamps: true,
    }
);

BondRequestSchema.index({ status: 1 });
BondRequestSchema.index({ offer: 1 });
BondRequestSchema.index({ want: 1 });
BondRequestSchema.index({ user: 1 });
BondRequestSchema.index({ modality: 1 });
// El sweep (matching.sweep.ts) filtra bonds activos (status/isPause/isLinked)
// por `matchesComputedAt` (nunca calculados o más viejos que el TTL) y ordena por
// ese campo ascendente. Índice COMPUESTO: las igualdades primero y el campo del
// rango+sort al final, para que Mongo resuelva filtro y orden con un solo índice
// (evita COLLSCAN + sort en memoria cuando la colección crece).
BondRequestSchema.index({
    status: 1,
    isPause: 1,
    isLinked: 1,
    matchesComputedAt: 1,
});

// ESCALA: el índice que el sweep usa DE VERDAD desde el TTL adaptativo. Mismo
// criterio que el de arriba (igualdades primero, el campo de rango+sort al
// final) pero sobre `matchesNextAt`, que es lo que el sweep filtra y ordena
// ahora. Con lote 1.500 y ~100.000 vínculos activos, resolver filtro y orden con
// un solo índice es la diferencia entre una consulta y un COLLSCAN con sort en
// memoria cada 5 minutos.
//
// El índice de `matchesComputedAt` se CONSERVA: sigue habiendo caminos que
// filtran por ese campo, y borrarlo es una decisión aparte que se toma con
// `$indexStats` en la mano, no de memoria.
BondRequestSchema.index({
    status: 1,
    isPause: 1,
    isLinked: 1,
    matchesNextAt: 1,
});

// "¿Quién tiene vínculos vivos?" (normalUser/vinculosVivos.ts): con `user` al final
// el índice CUBRE la consulta y Mongo no lee los documentos, que pesan ~40 KB por
// los dos vectores de 1536 dimensiones. Medido el 29/9 con 12.000 vínculos: el
// `distinct` pasó de 8.669 documentos leídos a 0.
BondRequestSchema.index({ status: 1, isPause: 1, isLinked: 1, user: 1 });

// HARD race guard contra vínculos duplicados: un mismo usuario no puede tener
// dos bonds ACTIVOS idénticos (mismo `offer` + `want`), porque siempre darían
// los mismos matches. Índice único PARCIAL limitado a bonds vivos (esperando
// link y no linkeados); así un bond borrado o ya linkeado NO bloquea recrear
// uno igual. `partialFilterExpression` solo admite igualdad, por eso se fija a
// WAITING_FOR_LINK + isLinked:false.
//
// NUANCE: este índice es EXACT-STRING (compara bytes literales), por lo que solo
// atrapa duplicados idénticos carácter a carácter -> sirve de red anti-carrera en
// un doble-submit concurrente. La comparación tolerante a mayúsculas/espacios se
// hace en el servicio (createBondRequestIntoDB) ANTES de crear. Los dos niveles
// se complementan: servicio = UX (case-insensitive + trim), índice = integridad.
BondRequestSchema.index(
    { user: 1, offer: 1, want: 1 },
    {
        unique: true,
        partialFilterExpression: {
            status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
            isLinked: false,
        },
    }
);

const BondRequest = model<IBondRequest>('BondRequest', BondRequestSchema);
export default BondRequest;
