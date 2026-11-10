import { model, Schema } from 'mongoose';
import { IBookmark } from './audio.bookmark.interface';

const AudioBookmarkSchema = new Schema<IBookmark>(
    {
        audio: {
            type: Schema.Types.ObjectId,
            default: null,
            ref: 'Audio',
        },
        user: {
            type: Schema.Types.ObjectId,
            required: true,
            ref: 'NormalUser',
        },
    },
    {
        timestamps: true,
    }
);

// A user may bookmark the same audio only once (B.3).
AudioBookmarkSchema.index({ user: 1, audio: 1 }, { unique: true });

const AudioBookmark = model('AudioBookmark', AudioBookmarkSchema);

export default AudioBookmark;
