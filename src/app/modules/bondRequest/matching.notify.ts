/* eslint-disable @typescript-eslint/no-explicit-any */
/* D.2: "a match appeared" notification effect. Own file on purpose: the matching robot
 * calls notifyNewMatches after persisting. Only notification + socket; no scoring here. */
import sendNotification from '../../helper/sendNotification';
import Notification from '../notification/notification.model';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import { MatchRecord } from './matching.compute';

interface NotifyNewMatchesArgs {
    // receiver: NormalUser id (owner of sourceBond). The socket joins by profileId.
    userId?: string;
    bondRequestId: string;
    // fresh records already persisted by computeAndCacheMatches.
    records: MatchRecord[];
    // signatures (sorted bond ids joined by '|') that existed BEFORE the recompute.
    previousSignatures: Set<string>;
    // offer/want of the source link, to identify it in the bell.
    sourceOffer?: string;
    sourceWant?: string;
}

/** Friendly token label ('empty' → Nada, 'surprise' → Sorpresa); free text is clipped.
 *  Presentation only: the stored/matched token stays 'empty' (see isEmptyToken).
 */
const prettyToken = (s?: string): string => {
    const raw = (s || '').trim();
    const norm = raw.toLowerCase();
    if (norm === 'empty') return 'Nada';
    if (norm === 'surprise') return 'Sorpresa';
    if (!raw) return '—';
    return raw.length > 22 ? `${raw.slice(0, 21)}…` : raw;
};

/** Stable trade signature: its bonds sorted and joined. */
const signatureOf = (ids: string[]): string =>
    [...ids].map((id) => id.toString()).sort().join('|');

/**
 * Detects NEW matches (absent before the recompute) and, if any, creates/updates the
 * trade's notification and emits it. Collapses across recomputes: ONE row per trade
 * (receiver + redirectId), refreshed and back to unread (see collapseByRedirect).
 */
export const notifyNewMatches = async (
    args: NotifyNewMatchesArgs
): Promise<void> => {
    const { userId, bondRequestId, records, previousSignatures, sourceOffer, sourceWant } =
        args;
    if (!userId) return;

    const freshOnes = (records || []).filter(
        (r) => !previousSignatures.has(signatureOf(r.ids))
    );
    if (freshOnes.length === 0) return;

    // Badge anti-bounce: "fresh vs previous recompute" is not "never seen". A signature
    // can REAPPEAR and would reset seenBy. Notify only for signatures missing from the
    // collapsed notification's `notifiedSignatures`.
    const existing = await Notification.findOne({
        receiver: userId.toString(),
        type: ENUM_NOTIFICATION_TYPE.MATCH,
        redirectId: bondRequestId.toString(),
    })
        .select('notifiedSignatures')
        .lean();
    const alreadyNotified = new Set<string>(
        (existing?.notifiedSignatures as string[] | undefined) ?? []
    );
    const trulyNewSignatures = [
        ...new Set(
            freshOnes
                .map((r) => signatureOf(r.ids))
                .filter((s) => !alreadyNotified.has(s))
        ),
    ];
    // Every "fresh" one was already notified (reappearance) → don't bounce the badge.
    if (trulyNewSignatures.length === 0) return;

    // Trade identity (offer/want) so the bell says which link this match belongs to.
    const hasLabel = Boolean(
        (sourceOffer && sourceOffer.trim()) || (sourceWant && sourceWant.trim())
    );
    const label = hasLabel
        ? ` (Ofrezco: ${prettyToken(sourceOffer)} · Busco: ${prettyToken(sourceWant)})`
        : '';
    // No count on purpose: a stored number can't match the live modal (cache TTL,
    // recomputes, block filter, pagination), so state only the stable truth.
    const message = `Aparecieron nuevos matches para tu vínculo${label}.`;

    await sendNotification(
        {
            title: 'Nuevo match',
            message,
            // receiver = bond owner (NormalUser id / socket profileId).
            receiver: userId.toString(),
            type: ENUM_NOTIFICATION_TYPE.MATCH,
            // redirectId: the source bond, so the front opens its matches.
            redirectId: bondRequestId.toString(),
        },
        // One notification per link: update it in place (bump, unread again) rather than
        // create another; record new signatures so reappearance doesn't bounce it.
        { collapseByRedirect: true, addSignatures: trulyNewSignatures }
    );
};

export default notifyNewMatches;
