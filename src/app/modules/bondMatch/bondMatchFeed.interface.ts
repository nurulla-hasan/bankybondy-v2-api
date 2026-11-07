import { Types } from 'mongoose';
import { BondMatchType, IMatchScoreParts } from './bondMatch.interface';

/** Read model for the Matches screen: one row per (participant bond, match).
 *
 *  BondMatch keeps ONE row per discovered match (write model, cleaned by
 *  `sourceBond`). This collection fans the same match out to every participant
 *  so "my matches" is a single index-ordered, bounded read:
 *    find({ bond }).sort({ score: -1 }).limit(feedScanLimit)
 *
 *  `matchKey` is the canonical sorted-id signature already used by the
 *  notification flow (`signatureOf`), so dedup semantics stay identical. */
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