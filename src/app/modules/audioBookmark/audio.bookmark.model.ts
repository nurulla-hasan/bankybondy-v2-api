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

// Un usuario no puede tener el mismo audio en favoritos dos veces (B.3).
AudioBookmarkSchema.index({ user: 1, audio: 1 }, { unique: true });

const AudioBookmark = model('AudioBookmark', AudioBookmarkSchema);

export default AudioBookmark;
