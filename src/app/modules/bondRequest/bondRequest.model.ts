/* eslint-disable @typescript-eslint/no-explicit-any */
import { Schema, model } from 'mongoose';
import {
    ENUM_BOND_MODALITY,
    ENUM_BOND_REQUEST_STATUS,
} from './bondRequest.enum';
import { IBondRequest } from './bondRequest.interface';
import { canonicalBondText, publicBondData } from './bondIdentity';

const BondRequestSchema = new Schema<IBondRequest>(
    {
        user: {
            type: Schema.Types.ObjectId,
            ref: 'NormalUser',
            required: true,
        },
        offer: { type: String, required: true },
        want: { type: String, required: true },
        integrityRevision: { type: Number, default: 0, select: false },
        offerKey: { type: String, select: false },
        wantKey: { type: String, select: false },
        // Location is OPTIONAL: a user with no saved location (or an 'online'
        // bond) must still create bonds. Without coords the service omits this
        // subdoc entirely (a partial `location` breaks the 2dsphere index).
        location: {
            // No default on `type` and `default: undefined` on coordinates, so
            // Mongoose omits `location`; a partial {type:'Point'} would break the
            // 2dsphere index and crash matching on coordinates destructuring.
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
        // SOFT-DELETE: a bond in a COMPLETED link cannot be hard-deleted (BondLink
        // references it, BondRating hangs off it, losing earned reputation). It
        // survives for history/reviews, leaves listings, frees no bondLimit slot.
        // Unlinked bonds are still hard-deleted.
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
        // Timestamp of the last match computation (set by the robot after
        // computeAndCacheMatches). Lets serving tell "still computing" from
        // "computed, zero matches": recent + no cache means zero, stop polling.
        matchesComputedAt: { type: Date },
        // AGENDA of the next recompute (scale: matching.schedule.ts). A FUTURE
        // instant, so the sweep is one indexed range query (`matchesNextAt <=
        // now`). Epoch default: new bonds are due at once and the field is always
        // present, keeping the sweep a pure range (an $or with $exists forced a
        // blocking 32 MB sort that overflowed at batch 1.500). Does NOT replace
        // matchesComputedAt, which serving uses for "still computing".
        matchesNextAt: { type: Date, default: () => new Date(0) },
        // Cache GENERATION: invalidation increments it; a compute only seals its
        // result if the generation it read at start is unchanged. Prevents a
        // compute started before an invalidation from writing stale matches
        // (which rescheduled the bond 24 h out and no job rescued it).
        matchesGen: { type: Number, default: 0 },
        // Last time the OWNER opened this bond's matches screen: the honest
        // interest signal that drives temperature together with createdAt.
        // Not updatedAt, because timestamps:true overwrites it with our own
        // bookkeeping (stamping matchesComputedAt, invalidation $unset).
        lastServedAt: { type: Date },
    },
    {
        timestamps: true,
        toJSON: { transform: (_doc, ret) => publicBondData(ret) },
        toObject: { transform: (_doc, ret) => publicBondData(ret) },
    }
);

BondRequestSchema.pre('validate', function () {
    if (typeof this.offer === 'string') this.offerKey = canonicalBondText(this.offer);
    if (typeof this.want === 'string') this.wantKey = canonicalBondText(this.want);
});

BondRequestSchema.index({ status: 1 });
BondRequestSchema.index({ offer: 1 });
BondRequestSchema.index({ want: 1 });
BondRequestSchema.index({ user: 1 });
BondRequestSchema.index({ modality: 1 });
// Sweep (matching.sweep.ts) filters active bonds on matchesComputedAt (never
// computed or older than the TTL) and sorts by it. COMPOSITE index: equality
// fields first, range+sort field last, so Mongo resolves both with one index.
BondRequestSchema.index({
    status: 1,
    isPause: 1,
    isLinked: 1,
    matchesComputedAt: 1,
});

// SCALE: the index the sweep actually uses since the adaptive TTL — same layout,
// on matchesNextAt (what it filters and sorts by now). At batch 1.500 over
// ~100.000 active links, one index instead of COLLSCAN + in-memory sort every
// 5 min. The matchesComputedAt index is KEPT: other paths still filter on it;
// dropping it needs $indexStats evidence.
BondRequestSchema.index({
    status: 1,
    isPause: 1,
    isLinked: 1,
    matchesNextAt: 1,
});

// "Who has live bonds?" (normalUser/vinculosVivos.ts): `user` last makes the
// index COVER the query, so Mongo skips ~40 KB docs with two 1536-dim vectors.
// Measured 29/9 with 12.000 bonds: distinct went from 8.669 docs read to 0.
BondRequestSchema.index({ status: 1, isPause: 1, isLinked: 1, user: 1 });

// Hard race guard: a user cannot have two ACTIVE identical bonds (same offer +
// want), they would always match the same. Partial unique index limited to live
// bonds, so a deleted or linked bond does not block recreating one.
// partialFilterExpression only supports equality, hence WAITING_FOR_LINK +
// isLinked:false. Exact-string only: catches concurrent double submits; the
// case/space-tolerant check lives in createBondRequestIntoDB (UX vs integrity).
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
