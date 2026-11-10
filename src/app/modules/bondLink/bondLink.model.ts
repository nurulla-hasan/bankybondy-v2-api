import { model, Schema } from 'mongoose';
import { ENUM_BOND_LINK_STATUS } from './bondLink.enum';
import { IBondLink } from './bondLink.interface';

const BondLinkSchema = new Schema<IBondLink>(
    {
        name: { type: String, required: true },
        participants: [{ type: Schema.Types.ObjectId, ref: 'NormalUser' }],
        requestedBonds: [{ type: Schema.Types.ObjectId, ref: 'BondRequest' }],
        // Idempotency key (sorted+unique bond ids joined by '_'). Written by
        // createBondLink; used by the partial unique index below.
        bondsKey: { type: String },
        status: {
            type: String,
            enum: Object.values(ENUM_BOND_LINK_STATUS),
            default: ENUM_BOND_LINK_STATUS.Ongoing,
        },
        markAsCompletedBy: {
            type: [Schema.Types.ObjectId],
            default: [],
        },
        // Close reminder already sent (sweep). null/absent = not notified yet.
        reminderSentAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);

// `getMyBondLinks` queries BondLink.find({participants: userId}) + count; without
// an index that was a COLLSCAN over all system links. Participant + recency order.
BondLinkSchema.index({ participants: 1, updatedAt: -1 });

// R2-6 — Double-submit idempotency: at most ONE active (Ongoing) link per bond set.
// Without it a double tap created two BondLinks and two conversations. Partial:
//  - `status: Ongoing` → Completed/Canceled links leave the index, so those bonds
//    can legitimately be linked again later.
//  - `bondsKey: {$exists:true}` → old docs without the key are not indexed, so no
//    migration is needed.
// The service catches E11000 and returns the existing link.
BondLinkSchema.index(
    { bondsKey: 1 },
    {
        unique: true,
        partialFilterExpression: {
            bondsKey: { $exists: true },
            status: ENUM_BOND_LINK_STATUS.Ongoing,
        },
    }
);

export const BondLink = model<IBondLink>('BondLink', BondLinkSchema);
