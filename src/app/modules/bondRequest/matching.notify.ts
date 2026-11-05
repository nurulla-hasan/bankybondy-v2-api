/* eslint-disable @typescript-eslint/no-explicit-any */
/* D.2 (Tanda 2): efecto de notificacion "aparecio un match".
 *
 * Aislado a proposito en su propio archivo: el robot del matcheo llama a
 * notifyNewMatches DESPUES de persistir, pasando las firmas de match previas.
 * Aca solo se crea la Notification y se emite por socket usando el patron
 * existente (helper sendNotification). NO se toca scoring/persistencia ni se
 * agrega ninguna llamada de IA.
 */
import sendNotification from '../../helper/sendNotification';
import Notification from '../notification/notification.model';
import { ENUM_NOTIFICATION_TYPE } from '../../utilities/enum';
import { MatchRecord } from './matching.compute';

interface NotifyNewMatchesArgs {
    // receiver: NormalUser id (dueno del sourceBond). El socket une por profileId.
    userId?: string;
    bondRequestId: string;
    // registros frescos ya persistidos por computeAndCacheMatches.
    records: MatchRecord[];
    // firmas (bonds ordenados y unidos por '|') que existian ANTES del recomputo.
    previousSignatures: Set<string>;
    // offer/want del vinculo de partida, para IDENTIFICARLO en la campana.
    sourceOffer?: string;
    sourceWant?: string;
}

/** Etiqueta amigable de un token: 'empty' → Nada, 'surprise' → Sorpresa, y el
 *  texto libre se recorta para no ensuciar la campana.
 *
 *  SOLO PRESENTACION: el token que se guarda, viaja y matchea sigue siendo
 *  'empty'. Renombrar la etiqueta NO toca el motor (ver `isEmptyToken` en
 *  matching.colors.ts, que compara contra 'empty' y no contra este texto).
 *  Nota heredada: este texto NO pasa por i18n — la campana es solo en español. */
const prettyToken = (s?: string): string => {
    const raw = (s || '').trim();
    const norm = raw.toLowerCase();
    if (norm === 'empty') return 'Nada';
    if (norm === 'surprise') return 'Sorpresa';
    if (!raw) return '—';
    return raw.length > 22 ? `${raw.slice(0, 21)}…` : raw;
};

/** Firma estable de un trato: conjunto ordenado de sus bonds. */
const signatureOf = (ids: string[]): string =>
    [...ids].map((id) => id.toString()).sort().join('|');

/**
 * Detecta matches NUEVOS (no presentes antes del recomputo) y, si hay al menos
 * uno, crea/ACTUALIZA la Notification del vínculo para el dueno del bond y la
 * emite por socket. Se envia UNA sola notificacion por recomputo (agrupa los
 * nuevos). Ademas COLAPSA entre recomputos: no crea una fila por pasada, sino
 * que mantiene UNA sola notificacion por vínculo (receiver + redirectId) que se
 * refresca y vuelve a NO-leída cuando aparecen nuevos (ver collapseByRedirect).
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

    // ANTI-REBOTE del badge: "fresh vs recompute anterior" NO es lo mismo que "el
    // usuario nunca lo vio". Una firma puede REAPARECER (la contraparte pausó y
    // volvió, o el trato salió y volvió al top-100) y contaría como fresh aunque ya
    // la hayas visto → resetearía seenBy y el match "rebota" a no-leído, re-inflando
    // el badge. Sólo avisamos (y reseteamos seenBy) por firmas GENUINAMENTE nuevas:
    // las que no están en `notifiedSignatures` de la notif colapsada del vínculo.
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
    // Todas las "fresh" son firmas YA avisadas (reaparición) → no rebotar el badge.
    if (trulyNewSignatures.length === 0) return;

    // Identidad del vínculo (Ofrezco/Busco) para distinguir EN LA CAMPANA de
    // cuál de los vínculos del usuario es este match. Si no hay datos, se omite.
    const hasLabel = Boolean(
        (sourceOffer && sourceOffer.trim()) || (sourceWant && sourceWant.trim())
    );
    const label = hasLabel
        ? ` (Ofrezco: ${prettyToken(sourceOffer)} · Busco: ${prettyToken(sourceWant)})`
        : '';
    // NO informamos una CANTIDAD a propósito: el número se congela en el instante
    // del cómputo, pero el modal es EN VIVO (TTL de caché, recálculos del robot,
    // filtro de bloqueados, paginado) → un número guardado no puede garantizarse
    // igual a lo que el modal va a mostrar. Afirmamos sólo lo veraz y estable: que
    // HAY nuevos matches (esta función ya retornó antes si freshOnes fuese 0).
    const message = `Aparecieron nuevos matches para tu vínculo${label}.`;

    await sendNotification(
        {
            title: 'Nuevo match',
            message,
            // receiver = dueno del bond (NormalUser id / profileId del socket).
            receiver: userId.toString(),
            type: ENUM_NOTIFICATION_TYPE.MATCH,
            // redirectId: el bond de partida para que el front abra sus matches.
            redirectId: bondRequestId.toString(),
        },
        // Una sola notificación por vínculo: si ya hay una para este bond, se
        // actualiza (sube y vuelve a no-leída) en vez de crear otra. Registramos
        // las firmas nuevas para no re-rebotar por reaparición de una ya vista.
        { collapseByRedirect: true, addSignatures: trulyNewSignatures }
    );
};

export default notifyNewMatches;
