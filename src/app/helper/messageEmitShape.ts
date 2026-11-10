/* Shapes a freshly created message like the history `$project`: adds `userDetails`,
 * drops `seenBy`/`__v`. `msgByUserId`, `isMyMessage` and `seen` stay untouched on purpose. */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const shapeSentMessage = (message: any): Record<string, any> => {
    if (!message) return message;

    const obj =
        typeof message.toObject === 'function'
            ? message.toObject({ versionKey: false })
            : { ...message };

    const sender = obj.msgByUserId;
    if (sender && typeof sender === 'object') {
        obj.userDetails = {
            name: sender.name,
            profile_image: sender.profile_image,
        };
    }

    delete obj.seenBy;
    delete obj.__v;

    return obj;
};
