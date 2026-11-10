import { Types } from 'mongoose';

export interface IBondRating {
    rated: Types.ObjectId;
    ratedBy: Types.ObjectId;
    rating: number;
    bondLink: Types.ObjectId;
    want: string;
    offer: string;
    // D.3: optional short comment that goes with the score.
    comment?: string;
    // Held rating: no reputation impact until the WHOLE trade closes; created false and
    // flipped to true in bulk on Completed. Unfinished trades stay false forever.
    applied?: boolean;
}
