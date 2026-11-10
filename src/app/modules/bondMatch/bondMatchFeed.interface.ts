import { Types } from 'mongoose';
import { BondMatchType, IMatchScoreParts } from './bondMatch.interface';

/** Read model for the Matches screen: one row per (participant bond, match).
 *  Fans each BondMatch out to every participant so "my matches" is a single
 *  index-ordered, bounded read. `matchKey` is the canonical sorted-id signature
 *  already used by notifications (`signatureOf`), so dedup stays identical. */
export interface IBondMatchFeed {
    bond: Types.ObjectId; // participant whose feed this row belongs to
    matchKey: string; // canonically sorted participant ids joined by '|'
    bonds: Types.ObjectId[]; // all participants of the match
    users: Types.ObjectId[]; // owners (block filtering without populate)
    score: number;
    parts: IMatchScoreParts;
    type: BondMatchType;
    size: number;
    sourceBond: Types.ObjectId; // discoverer that produced this row
    computedAt: Date;
}