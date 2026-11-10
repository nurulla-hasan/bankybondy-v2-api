import { Types } from 'mongoose';
import { ENUM_BOND_LINK_STATUS } from './bondLink.enum';

export interface IBondLink {
    id: Types.ObjectId;
    name: string;
    participants: Types.ObjectId[];
    requestedBonds: Types.ObjectId[];
    // Idempotency key: deterministic hash of sorted unique bond ids joined by '_'.
    // A partial unique index on {bondsKey, status:Ongoing} blocks double-submits.
    // Optional: older docs predate it.
    bondsKey?: string;
    status: (typeof ENUM_BOND_LINK_STATUS)[keyof typeof ENUM_BOND_LINK_STATUS];
    markAsCompletedBy: Types.ObjectId[];
    // Close reminder already sent (set by the sweep) so we don't notify twice.
    reminderSentAt?: Date;
    createdAt: Date;
    updated: Date;
}
