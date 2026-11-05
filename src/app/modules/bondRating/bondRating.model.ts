import { model, Schema } from 'mongoose';
import { IBondRating } from './bondRating.interface';

const bondRatingSchema = new Schema<IBondRating>(
    {
        rated: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: 'NormalUser',
        },
        ratedBy: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: 'NormalUser',
        },
        bondLink: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: 'BondLink',
        },
        rating: {
            type: Number,
            required: true,
            max: 5,
            min: 1,
        },
        want: {
            type: String,
            required: true,
        },
        offer: {
            type: String,
            required: true,
        },
        // D.3 (Tanda 2): comentario breve opcional (max 500 chars) para mostrar
        // en la vista publica del perfil junto a la estrella.
        comment: {
            type: String,
            trim: true,
            maxlength: 500,
        },
        // Rating en suspenso (ver interface): la reputación solo cuenta `applied:true`.
        // Se pasa a true en lote cuando el trueque cierra (todos completan).
        applied: {
            type: Boolean,
            default: false,
        },
    },
    { timestamps: true }
);

// Un usuario solo puede valorar a otro una vez por bondLink (evita doble voto)
bondRatingSchema.index(
    { rated: 1, ratedBy: 1, bondLink: 1 },
    { unique: true }
);

// El batch de cierre (updateMany + distinct por `bondLink`) y el sweep de
// reconciliación filtran por `bondLink` — que NO es prefijo del índice unique
// de arriba (va 3ro), así que sin este índice serían COLLSCAN en cada cierre de
// trueque. `applied` de sufijo cubre `{bondLink, applied:{$ne:true}}`.
bondRatingSchema.index({ bondLink: 1, applied: 1 });

// ---------------------------------------------------------------------------
// Hooks: mantener fresca la reputacion cacheada de NormalUser tras cualquier
// mutacion de BondRating. Necesario para que el filtro sort=reputation (que
// ordena por reputation.score) refleje datos reales.
//
// `recomputeReputation` vive en reputation.util, que a su vez importa ESTE
// modelo -> dependencia circular. Se evita con import() perezoso dentro del
// hook (se resuelve en runtime, cuando ambos modulos ya estan cargados).
// ---------------------------------------------------------------------------
async function recomputeAfterChange(ratedId: unknown): Promise<void> {
    if (!ratedId) return; // guard: documento/id ausente
    try {
        const { recomputeReputation } = await import('./reputation.util');
        await recomputeReputation(String(ratedId));
    } catch (err) {
        // Nunca romper la operacion original por un fallo del recalculo.
        console.error('[reputation] hook recompute failed', err);
    }
}

// Alta / edicion via documento (.save()).
bondRatingSchema.post('save', function (doc) {
    void recomputeAfterChange(doc?.rated);
});

// Alta / edicion via query (findOneAndUpdate, incluido el upsert de addRating).
bondRatingSchema.post('findOneAndUpdate', function (doc) {
    void recomputeAfterChange(doc?.rated);
});

// Borrado que devuelve el documento borrado: tiene `rated` disponible.
bondRatingSchema.post('findOneAndDelete', function (doc) {
    void recomputeAfterChange(doc?.rated);
});

// Nota: no registramos hooks de deleteOne/deleteMany por query. No existe un
// flujo de borrado directo de reseñas en la app; los caminos reales (alta,
// edicion, upsert y borrado con documento) ya quedan cubiertos arriba. Ademas,
// avg/count se derivan en vivo en los endpoints y el backfill recalcula el
// cache, asi que un borrado masivo eventual no dejaria el promedio mal.

const BondRating = model<IBondRating>('BondRating', bondRatingSchema);
export default BondRating;
