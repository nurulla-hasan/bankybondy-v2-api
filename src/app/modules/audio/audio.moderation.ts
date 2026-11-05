/* eslint-disable @typescript-eslint/no-explicit-any */
/* Qué textos PÚBLICOS de un audio hay que moderar: título, descripción y cada tag.
 *
 * La moderación async del audio solo inspecciona el TRANSCRIPT; el título, la
 * descripción y los tags son texto libre del cliente, se muestran (y se buscan)
 * en el feed público y nunca pasaban por moderación → bypass de T&S por el canal
 * de texto. Este helper centraliza QUÉ se modera (whitelist de campos), en un
 * único lugar reutilizable por create y update.
 *
 * Función PURA (no llama a la moderación, solo arma la lista) → testeable en runTests.
 */
export type ModeratableText = { text: string; label: string };

export const collectAudioTexts = (payload: any): ModeratableText[] => {
    const out: ModeratableText[] = [];
    const push = (v: unknown, label: string) => {
        if (typeof v === 'string' && v.trim()) out.push({ text: v, label });
    };
    push(payload?.title, 'Title');
    push(payload?.description, 'Description');
    const tags = Array.isArray(payload?.tags) ? payload.tags : [];
    // El índice es el de la posición ORIGINAL en el array (un tag inválido no
    // corre la numeración de los válidos que le siguen).
    tags.forEach((t: unknown, i: number) => push(t, `Tag ${i + 1}`));
    return out;
};
