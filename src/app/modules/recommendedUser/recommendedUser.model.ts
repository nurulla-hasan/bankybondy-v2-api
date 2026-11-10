import { Schema, model } from 'mongoose';
import { IRecommendedUser } from './recommendedUser.interface';

const recommendedUserSchema = new Schema<IRecommendedUser>(
    {
        recommendBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        // Account (User) id of the recommender. `recommendBy` holds the profile
        // (NormalUser); this one is what the expired-account cleanup cron filters
        // on, hence the index.
        recommendByUserId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
        },
        phone: {
            type: String,
            required: true,
            trim: true,
        },
        skill: {
            type: Schema.Types.ObjectId,
            ref: 'Skill',
            required: true,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

export const RecommendedUser = model<IRecommendedUser>(
    'RecommendedUser',
    recommendedUserSchema
);
