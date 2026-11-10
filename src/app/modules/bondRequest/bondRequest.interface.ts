import { Types } from 'mongoose';
import { BondModality, ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';

export interface IBondRequest {
    integrityRevision?: number;
    offerKey?: string;
    wantKey?: string;
    user: Types.ObjectId;
    offer: string;
    want: string;
    location?: {
        type: 'Point';
        coordinates: [number, number];
    };
    description?: string;
    radius?: number;
    // 'physical' (with radius) or 'online' (global). Absent = physical (legacy).
    modality?: BondModality;
    status: (typeof ENUM_BOND_REQUEST_STATUS)[keyof typeof ENUM_BOND_REQUEST_STATUS];
    isLinked: boolean;
    createdAt?: Date;
    updatedAt?: Date;
    isPause: boolean;
    // Soft-delete: see the note in bondRequest.model.ts. Kept for the completed
    // link history and review, but not listed nor counts against the quota.
    isDeleted?: boolean;
    offerVector: number[];
    wantVector: number[];
    // Set by the robot when this bond's matches finish computing/caching.
    // Distinguishes "computing" from "computed with no matches" at serving time.
    matchesComputedAt?: Date;
    // SCHEDULE of the next recompute (adaptive TTL; see matching.schedule.ts).
    // FUTURE instant. Absent = eligible now.
    matchesNextAt?: Date;
    // Match cache generation: invalidation bumps it and a computation only seals
    // its result if it did not change while running.
    matchesGen?: number;
    // Last time the owner opened this link's matches. Real-interest signal that
    // decides the temperature (and therefore the TTL).
    lastServedAt?: Date;
}
