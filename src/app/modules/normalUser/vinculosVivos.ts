import { ClientSession, Types } from 'mongoose';
import { errorLogger } from '../../shared/logger';
import { ENUM_BOND_REQUEST_STATUS } from '../bondRequest/bondRequest.enum';
import BondRequest from '../bondRequest/bondRequest.model';
import NormalUser from './normalUser.model';

/* `NormalUser.hasActiveBonds` — "has at least one LIVE bond".
 *
 * Primary sort key for People in Featured mode. Computing it per load with a
 * `distinct` over bonds plus a `$in` of all owners was quadratic (p95 35s measured
 * 29/9). Stored on the user with a matching index, page p reads ~15·p users.
 *
 * A desynced denormalized field is a SILENT bug, so it is maintained three ways:
 *   1. API writes that change liveness: create sets it directly inside its
 *      transaction; pause/resume/soft delete/delete/reactivate call
 *      `recalcularVinculosVivos`.
 *   2. At boot, after the D1 backfill (which normalizes missing isPause/isLinked).
 *   3. Each sweep cron round (MATCH_SWEEP_CRON): `reconciliarVinculosVivos` repairs
 *      any escaped write (manual scripts, races, a write during the repair).
 *
 * `timestamps: false` on EVERY write here is mandatory: `updatedAt` is the THIRD
 * Featured sort key ("recent activity"), so touching it would reorder everyone.
 */

// The SAME filter the listing used. NOT the matching sweep one, which only looks
// at WAITING_FOR_LINK with `isLinked: false`: ONGOING and a missing `isLinked`
// count here too. A missing `isPause` does NOT count as live, as before.
export const FILTRO_VINCULO_VIVO = {
    status: {
        $in: [
            ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
            ENUM_BOND_REQUEST_STATUS.ONGOING,
        ],
    },
    isPause: false,
    isLinked: { $ne: true },
};

/** Recomputes ONE user's flag from its bonds. Never throws: failures are logged and
 *  fixed by the sweep reconciliation; the user's operation already succeeded. */
export const recalcularVinculosVivos = async (
    userId: Types.ObjectId | string,
    session?: ClientSession
): Promise<void> => {
    try {
        const vivo = await BondRequest.exists({
            user: userId,
            ...FILTRO_VINCULO_VIVO,
        }).session(session ?? null);
        await NormalUser.updateOne(
            { _id: userId },
            { $set: { hasActiveBonds: !!vivo } },
            { timestamps: false, session }
        );
    } catch (err) {
        errorLogger.error(
            `[vinculosVivos] no se pudo recalcular ${userId}: ${
                (err as Error)?.message || err
            }`
        );
    }
};

/** Recomputes EVERYONE at once, writing only divergent rows. Idempotent; runs as
 *  the boot backfill and the per-sweep safety net (~0.5-0.9s for 30k users). */
export const reconciliarVinculosVivos = async () => {
    const duenos = await BondRequest.distinct('user', FILTRO_VINCULO_VIVO);
    const [encendidos, apagados] = await Promise.all([
        NormalUser.updateMany(
            { _id: { $in: duenos }, hasActiveBonds: { $ne: true } },
            { $set: { hasActiveBonds: true } },
            { timestamps: false }
        ),
        // `$ne: false` matches the MISSING field: users predating this change get
        // an explicit false, which is what the index orders by.
        NormalUser.updateMany(
            { _id: { $nin: duenos }, hasActiveBonds: { $ne: false } },
            { $set: { hasActiveBonds: false } },
            { timestamps: false }
        ),
    ]);
    return {
        duenos: duenos.length,
        encendidos: encendidos.modifiedCount,
        apagados: apagados.modifiedCount,
    };
};
