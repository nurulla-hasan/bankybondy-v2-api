import { ClientSession, Types } from 'mongoose';
import { errorLogger } from '../../shared/logger';
import { ENUM_BOND_REQUEST_STATUS } from '../bondRequest/bondRequest.enum';
import BondRequest from '../bondRequest/bondRequest.model';
import NormalUser from './normalUser.model';

/* `NormalUser.hasActiveBonds` — "tiene al menos un vínculo VIVO".
 *
 * Es la primera clave de orden de Personas en modo Destacados (el modo por
 * defecto). Antes se calculaba EN CADA CARGA con un `distinct` sobre los vínculos
 * (documentos de 40 KB) y un `$in` de todos los dueños contra todos los usuarios:
 * costo cuadrático, medido en 29/9 como el primer muro de escala (p95 de 35 s con
 * 3.000 usuarios y 20 cargas a la vez en 2 vCPU). Guardado en el usuario, con un
 * índice que sigue el orden de la pantalla, la página p lee ~15·p usuarios en
 * vez de ordenar a todos.
 *
 * Un dato desnormalizado que se desincroniza es un bug SILENCIOSO, así que se
 * mantiene por tres caminos:
 *   1. En las escrituras de la API que cambian si un vínculo está vivo: el alta
 *      lo enciende con un `$set` directo dentro de su transacción
 *      (bondRequest.service.ts); pausa, reanudar, baja lógica, borrado y
 *      reactivación llaman a `recalcularVinculosVivos`.
 *   2. Al arrancar la API, después del backfill de la agenda de D1 (que normaliza
 *      `isPause`/`isLinked` ausentes y con eso cambia quién cuenta como vivo).
 *   3. En cada vuelta del cron del barrido del worker (MATCH_SWEEP_CRON, cada
 *      5 min por defecto), antes del barrido: `reconciliarVinculosVivos`, la
 *      red que repara cualquier escritura que se haya escapado (scripts a mano,
 *      una carrera entre dos cambios del mismo usuario, o una escritura que cae
 *      mientras la propia red corre).
 *
 * `timestamps: false` en TODAS las escrituras de este archivo, y es obligatorio:
 * `updatedAt` es la TERCERA clave de orden de Destacados ("actividad reciente").
 * Tocarlo desde acá cambiaría el orden de todo el mundo cada vez que corre la
 * reconciliación.
 */

// El MISMO filtro que usaba el listado. NO es el del barrido del matcheo, que
// mira sólo WAITING_FOR_LINK con `isLinked: false`: acá cuentan también ONGOING
// y un `isLinked` ausente. Un `isPause` ausente NO cuenta como vivo, igual que
// antes.
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

/** Recalcula el dato de UN usuario desde sus vínculos. No lanza: si falla, queda
 *  en el log y lo repara la reconciliación del barrido. La operación del usuario
 *  (pausar, borrar…) ya se hizo y no tiene que fallar por esto. */
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

/** Recalcula a TODOS de una vez: sólo escribe a quien está mal. Idempotente. Es el
 *  backfill al arrancar y la red de cada vuelta del barrido. Medido el 29/9 con
 *  30.000 usuarios: 0,5-0,9 s, y ~3,5 s en frío. */
export const reconciliarVinculosVivos = async () => {
    const duenos = await BondRequest.distinct('user', FILTRO_VINCULO_VIVO);
    const [encendidos, apagados] = await Promise.all([
        NormalUser.updateMany(
            { _id: { $in: duenos }, hasActiveBonds: { $ne: true } },
            { $set: { hasActiveBonds: true } },
            { timestamps: false }
        ),
        // `$ne: false` incluye el campo AUSENTE: los usuarios anteriores a este
        // cambio quedan en false explícito, que es lo que ordena el índice.
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
