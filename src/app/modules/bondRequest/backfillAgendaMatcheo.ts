/* eslint-disable @typescript-eslint/no-explicit-any */
/* Idempotent migration that makes the sweep query index-friendly: it seeds the
 * fields the index needs for filter and order. `timestamps: false` keeps ranking freshness. */
import { errorLogger, logger } from '../../shared/logger';
import BondRequest from './bondRequest.model';
import { agendaVencida } from './matching.schedule';

export const backfillAgendaMatcheo = async (): Promise<void> => {
    try {
        // Cheap pre-check before paying for the `updateMany`: at almost every boot
        // there is nothing to do, and this costs a single read.
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

        // The one that hurts most if missing: mongoose defaults apply on CREATE only,
        // and `recomputeBond` reads with `.lean()`, so legacy links lack `matchesGen`
        // entirely. The compute seal filters by `{ matchesGen: 0 }`, and Mongo
        // equality never matches an absent field: the link would be recomputed on
        // every sweep forever and, at epoch, would fill the batch for good.
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

        // `isPause` for the same reason as `isLinked`: the sweep filters it by
        // EQUALITY, and equality does not match an absent field.
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
        // Never aborts startup: if this fails the sweep just misses legacy links
        // until the next boot.
        errorLogger.error(
            '[backfill] agenda de matcheo falló:',
            (e as Error)?.message
        );
    }
};

export default backfillAgendaMatcheo;
