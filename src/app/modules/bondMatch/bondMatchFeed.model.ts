import { Schema, model } from 'mongoose';
import { MATCHING } from '../bondRequest/matching.config';
import { IBondMatchFeed } from './bondMatchFeed.interface';

const BondMatchFeedSchema = new Schema<IBondMatchFeed>(
    {
        bond: {
            type: Schema.Types.ObjectId,
            ref: 'BondRequest',
            required: true,
        },
        matchKey: { type: String, required: true },
        bonds: [{ type: Schema.Types.ObjectId, ref: 'BondRequest' }],
        users: [{ type: Schema.Types.ObjectId, ref: 'NormalUser' }],
        score: { type: Number, required: true },
        parts: {
            sem: { type: Number, default: 0 },
            rep: { type: Number, default: 0 },
            prox: { type: Number, default: 0 },
            fresh: { type: Number, default: 0 },
        },
        type: {
            type: String,
            enum: ['entry', 'surprise', 'empty'],
            default: 'entry',
        },
        size: { type: Number, required: true },
        sourceBond: {
            type: Schema.Types.ObjectId,
            ref: 'BondRequest',
            required: true,
        },
        computedAt: { type: Date, default: Date.now },
        computeRevision: { type: Number, default: 0 },
    },
    // Accounting rows: no updatedAt. `updatedAt` feeds freshnessFactor, and a
    // feed refresh must never move a bond's ranking.
    { timestamps: false }
);

// Idempotent upsert + hard dedup of the same match for the same participant.
BondMatchFeedSchema.index({ bond: 1, matchKey: 1 }, { unique: true });
// Serving: bounded top-N with a covered sort.
BondMatchFeedSchema.index({ bond: 1, score: -1 });
BondMatchFeedSchema.index({ bond: 1, computeRevision: -1, score: -1, _id: 1 });
// Invalidation: every row that mentions a bond that was paused/deleted/blocked.
BondMatchFeedSchema.index({ bonds: 1 });
// Discoverer cleanup: rows this bond produced and no longer finds.
BondMatchFeedSchema.index({ sourceBond: 1, matchKey: 1 });
// Safety net: rows that stop being refreshed disappear after the serve TTL.
BondMatchFeedSchema.index(
    { computedAt: 1 },
    { expireAfterSeconds: Math.round(MATCHING.feedTtlHours * 3600) }
);

const BondMatchFeed = model<IBondMatchFeed>(
    'BondMatchFeed',
    BondMatchFeedSchema
);
export default BondMatchFeed;