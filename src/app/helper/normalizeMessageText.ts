/**
 * Message text must always be a string, whatever arrives over the socket:
 * `getMessages` filters with `$regex: ''`, which only matches strings, so a
 * `null` text would be saved and vanish from history with no error.
 */
export const normalizeMessageText = (text: unknown): string =>
    typeof text === 'string' ? text : '';
