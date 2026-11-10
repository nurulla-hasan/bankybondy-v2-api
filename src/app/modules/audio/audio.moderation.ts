/* eslint-disable @typescript-eslint/no-explicit-any */
/* Public audio text that must be moderated: title, description and each tag.
 * Async moderation only inspects the TRANSCRIPT, so free-text fields reached the
 * public feed unmoderated (a T&S bypass). Pure builder, reused by create/update. */
export type ModeratableText = { text: string; label: string };

export const collectAudioTexts = (payload: any): ModeratableText[] => {
    const out: ModeratableText[] = [];
    const push = (v: unknown, label: string) => {
        if (typeof v === 'string' && v.trim()) out.push({ text: v, label });
    };
    push(payload?.title, 'Title');
    push(payload?.description, 'Description');
    const tags = Array.isArray(payload?.tags) ? payload.tags : [];
    // Label uses the ORIGINAL array index: an invalid tag doesn't shift later labels.
    tags.forEach((t: unknown, i: number) => push(t, `Tag ${i + 1}`));
    return out;
};
