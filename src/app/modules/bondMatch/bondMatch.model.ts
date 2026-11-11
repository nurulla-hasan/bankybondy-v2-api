import { Schema, model } from 'mongoose';
import { IBondMatch } from './bondMatch.interface';

const BondMatchSchema = new Schema<IBondMatch>(
    {
        sourceBond: {
            type: Schema.Types.ObjectId,
            ref: 'BondRequest',
            required: true,
            index: true,
        },
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
        computedAt: { type: Date, default: Date.now },
        computeRevision: { type: Number, default: 0 },
    },
    { timestamps: true }
);

// Serve "matches of this bond" ordered by score.
BondMatchSchema.index({ sourceBond: 1, score: -1 });
// Invalidate by any participating bond (pause/delete/edit).
BondMatchSchema.index({ bonds: 1 });

const BondMatch = model<IBondMatch>('BondMatch', BondMatchSchema);
export default BondMatch;
