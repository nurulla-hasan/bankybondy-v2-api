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
        // Optional short comment shown on the public profile.
        comment: {
            type: String,
            trim: true,
            maxlength: 500,
        },
        // Pending rating: reputation only counts `applied:true`, set in bulk
        // when the trade closes.
        applied: {
            type: Boolean,
            default: false,
        },
    },
    { timestamps: true }
);

// One rating per user pair per bondLink (no double voting).
bondRatingSchema.index(
    { rated: 1, ratedBy: 1, bondLink: 1 },
    { unique: true }
);

// The close batch and reconciliation sweep filter by `bondLink`, which is NOT a
// prefix of the unique index above; without this, every close would COLLSCAN.
// The `applied` suffix covers `{bondLink, applied:{$ne:true}}`.
bondRatingSchema.index({ bondLink: 1, applied: 1 });

// Hooks keep the cached NormalUser reputation fresh after any BondRating mutation.
// `recomputeReputation` imports this model, so it is lazily imported to avoid a
// circular dependency.
async function recomputeAfterChange(ratedId: unknown): Promise<void> {
    if (!ratedId) return; // guard: missing id
    try {
        const { recomputeReputation } = await import('./reputation.util');
        await recomputeReputation(String(ratedId));
    } catch (err) {
        // Never break the original operation.
        console.error('[reputation] hook recompute failed', err);
    }
}

// Create/edit via document (.save()).
bondRatingSchema.post('save', function (doc) {
    void recomputeAfterChange(doc?.rated);
});

// Create/edit via query (includes the addRating upsert).
bondRatingSchema.post('findOneAndUpdate', function (doc) {
    void recomputeAfterChange(doc?.rated);
});

// Delete returning the document: `rated` is available.
bondRatingSchema.post('findOneAndDelete', function (doc) {
    void recomputeAfterChange(doc?.rated);
});

// No query deleteOne/deleteMany hooks: no direct review-deletion flow exists;
// avg/count are derived live and the backfill recomputes the cache.

const BondRating = model<IBondRating>('BondRating', bondRatingSchema);
export default BondRating;
