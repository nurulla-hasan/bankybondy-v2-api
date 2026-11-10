import { Types } from 'mongoose';

export type BondMatchType = 'entry' | 'surprise' | 'empty';

export interface IMatchScoreParts {
    sem: number; // semantic quality (weakest link)
    rep: number; // reputation (weakest link of the counterpart/cycle)
    prox: number; // proximity (1 if online / no geo)
    fresh: number; // freshness (last activity)
}

/** A precomputed possible deal for a starting bond (`sourceBond`).
 *  Denormalized: the same deal can be stored once per participating bond, so
 *  "my matches" is served with a single read. */
export interface IBondMatch {
    sourceBond: Types.ObjectId; // bond this match was computed for
    bonds: Types.ObjectId[]; // all deal bonds (incl. sourceBond), in order
    users: Types.ObjectId[]; // owners of those bonds
    score: number; // composite finalScore (0–1)
    parts: IMatchScoreParts; // score breakdown
    type: BondMatchType;
    size: number; // 2 = pair; >=3 = cycle
    computedAt: Date;
}
