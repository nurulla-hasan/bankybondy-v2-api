/* eslint-disable @typescript-eslint/no-explicit-any */
/* Migración idempotente: deja el árbol listo para la consulta del sweep.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES NECESARIA (y no es "nice to have")
 *
 * El sweep con TTL adaptativo consulta así:
 *
 *   { status: WAITING_FOR_LINK, isPause: false, isLinked: false,
 *     matchesNextAt: { $lte: ahora } }   .sort({ matchesNextAt: 1 })
 *
 * Esa forma exacta —tres IGUALDADES y un rango sobre la última clave— es lo que
 * permite que el índice {status, isPause, isLinked, matchesNextAt} provea el
 * filtro Y EL ORDEN. Si el orden no sale del índice, Mongo mete un SORT
 * BLOQUEANTE con tope duro de 32 MB, y estos documentos pesan ~40 KB cada uno
 * (los dos vectores de 1536 dims): con lote 1.500 son ~60 MB y el sweep MUERE en
 * silencio, devolviendo 0 en cada vuelta.
 *
 * Para poder escribirla así hacen falta dos cosas que esta migración garantiza:
 *
 *  1. `matchesNextAt` PRESENTE en todos los documentos. Los vínculos anteriores a
 *     este campo no lo tienen, y `$lte` NO matchea un campo ausente: sin el
 *     backfill quedarían invisibles para el sweep PARA SIEMPRE. La alternativa
 *     —un `$or` con `$exists: false`— es justamente lo que rompe el orden por
 *     índice. Se les pone la época: agenda vencida, elegibles ya.
 *
 *  2. `isLinked` PRESENTE en todos. Se usa `isLinked: false` (igualdad) en vez de
 *     `{$ne: true}` porque un `$ne` produce bounds multi-intervalo y también
 *     rompe el orden por índice. El schema tiene `default: false`, así que todo
 *     documento creado por mongoose lo trae; el backfill cubre cualquier legado.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `timestamps: false` EN LAS DOS ESCRITURAS, Y NO ES UN DETALLE.
 *
 * `updatedAt` alimenta `freshnessFactor`, que es el 10% del puntaje del matcheo.
 * Un `updateMany` sobre TODA la colección con timestamps activos resetearía la
 * frescura de todos los vínculos del sistema de una sentada. Una migración de
 * contabilidad no puede mover el ranking.
 *
 * Fire-and-forget desde el arranque de la API, sólo en la instancia líder.
 */
import { errorLogger, logger } from '../../shared/logger';
import BondRequest from './bondRequest.model';
import { agendaVencida } from './matching.schedule';

export const backfillAgendaMatcheo = async (): Promise<void> => {
    try {
        // Chequeo barato antes de pagar el `updateMany`: en el 99,99% de los
        // arranques no hay nada que hacer y esto sale con una sola lectura.
        const faltaAgenda = await BondRequest.countDocuments({
            matchesNextAt: { $exists: false },
        }).limit(1);

        if (faltaAgenda) {
            const r = await BondRequest.updateMany(
                { matchesNextAt: { $exists: false } },
                { $set: { matchesNextAt: agendaVencida() } },
                { timestamps: false }
            );
            logger.info(
                `[backfill] agenda de matcheo sembrada en ${r.modifiedCount} vínculo(s).`
            );
        }

        // ⚠️ EL TERCERO ES EL QUE MÁS DUELE SI FALTA, y faltaba.
        //
        // `matchesGen` se agregó al schema con `default: 0`, pero **los defaults
        // de mongoose se aplican al CREAR, no a los documentos ya guardados**, y
        // `recomputeBond` lee con `.lean()`, que ni siquiera hidrata. Así que en
        // todos los vínculos existentes el campo simplemente NO ESTÁ.
        //
        // Y el sellado del cómputo filtra por `{ _id, matchesGen: genAlEmpezar }`
        // con `genAlEmpezar = doc.matchesGen ?? 0` → filtro `{ matchesGen: 0 }`.
        // **En Mongo, la igualdad contra un valor no-nulo NO matchea un campo
        // ausente.** Resultado, para CADA vínculo del corpus actual:
        //
        //   1. el sweep lo toma, el worker computa, se persisten las filas;
        //   2. el sellado no matchea → no se escribe `matchesComputedAt` ni la
        //      agenda, que se queda en la época;
        //   3. el sweep lo vuelve a tomar. Y otra vez. Para siempre.
        //   4. Como todos los legados encabezan el orden (época), **copan el lote
        //      de 1.500 y ningún vínculo sano se recomputa jamás**.
        //
        // O sea: el matcheo de fondo moría el día del deploy, en silencio. Y los
        // vínculos sin coincidencias quedaban con el front sondeando cada 3 s
        // contra un cómputo que nunca sella — el "cómputo desbocado" que ya frenó
        // la API una vez, reintroducido por un arreglo escrito para otra cosa.
        const faltaGen = await BondRequest.countDocuments({
            matchesGen: { $exists: false },
        }).limit(1);

        if (faltaGen) {
            const r = await BondRequest.updateMany(
                { matchesGen: { $exists: false } },
                { $set: { matchesGen: 0 } },
                { timestamps: false }
            );
            logger.info(
                `[backfill] matchesGen sembrado en ${r.modifiedCount} vínculo(s).`
            );
        }

        // `isPause` por el MISMO motivo que `isLinked`: el sweep lo filtra con
        // IGUALDAD (`isPause: false`), y una igualdad no matchea un campo ausente.
        // Estaba fuera del backfill sólo por descuido — el argumento que justifica
        // los otros dos aplica textual a éste.
        const faltaPausa = await BondRequest.countDocuments({
            isPause: { $exists: false },
        }).limit(1);

        if (faltaPausa) {
            const r = await BondRequest.updateMany(
                { isPause: { $exists: false } },
                { $set: { isPause: false } },
                { timestamps: false }
            );
            logger.info(
                `[backfill] isPause normalizado en ${r.modifiedCount} vínculo(s).`
            );
        }

        const faltaLinked = await BondRequest.countDocuments({
            isLinked: { $exists: false },
        }).limit(1);

        if (faltaLinked) {
            const r = await BondRequest.updateMany(
                { isLinked: { $exists: false } },
                { $set: { isLinked: false } },
                { timestamps: false }
            );
            logger.info(
                `[backfill] isLinked normalizado en ${r.modifiedCount} vínculo(s).`
            );
        }
    } catch (e) {
        // Nunca aborta el arranque. Si esto falla, el sweep simplemente no ve a
        // los vínculos legados hasta el próximo boot — molesto, no catastrófico.
        errorLogger.error(
            '[backfill] agenda de matcheo falló:',
            (e as Error)?.message
        );
    }
};

export default backfillAgendaMatcheo;
