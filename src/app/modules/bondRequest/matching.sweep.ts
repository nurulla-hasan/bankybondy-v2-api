/* eslint-disable @typescript-eslint/no-explicit-any */
/* Sweep periódico del matcheo: descubre ciclos y refresca cachés vencidas.
 *
 * La invalidación por-bond (create/update/link/delete) refresca lo puntual,
 * pero los ciclos nuevos pueden surgir por combinaciones que ningún bond
 * individual "dispara". Este barrido recorre, de a lotes acotados, los bonds
 * activos cuya AGENDA ya venció y encola su recomputo. Así el descubrimiento de
 * ciclos ocurre a nivel de todo el grafo, distribuido en el tiempo.
 *
 * Acotado y opt-in: por defecto sólo corre si hay REDIS_URL (worker distribuido).
 * Sin Redis se puede forzar con MATCH_SWEEP_ENABLED=true (usa recomputo inline).
 */
import cron from 'node-cron';
import { expresionCron } from '../../utilities/expresionCron';
import config from '../../config';
import { errorLogger, logger } from '../../shared/logger';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import BondRequest from './bondRequest.model';
import { contarPendientes, enqueueRecompute } from './matching.robot';
import { agendaVencida } from './matching.schedule';
import { reconciliarVinculosVivos } from '../normalUser/vinculosVivos';

const SWEEP_ENABLED =
    (process.env.MATCH_SWEEP_ENABLED ?? (config.redis_url ? 'true' : 'false'))
        .toLowerCase() === 'true';
const SWEEP_CRON = expresionCron('MATCH_SWEEP_CRON', '*/5 * * * *');

// ESCALA: el lote sube de 200 a 1.500. Con 12 barridos por hora eso son 18.000
// recomputos/hora, contra los 2.400 de antes. La aritmética de por qué 18.000
// alcanza para ~100.000 vínculos activos (y 2.400 no) está en matching.schedule.ts.
//
// ⚠️ PRECISIÓN QUE CORRIGE UNA AFIRMACIÓN NUESTRA (panel del 11/9). Esos 18.000
// son capacidad de ENCOLADO: miden la canilla, no el desagüe. La capacidad de
// CÓMPUTO es `MATCHER_CONCURRENCY` × `MATCH_WORKER_CONCURRENCY`, y con los
// defaults (1 × 4) son CUATRO recomputos simultáneos: sostener 16.200/h pediría
// que cada job durara ≤0,89 s incluyendo búsqueda vectorial contra Atlas. La
// capacidad real punta a punta es el MÍNIMO de las dos, y esta tanda sólo movió
// la primera. Decir "ahora aguanta 100.000 vínculos" es verdad sólo con el worker
// escalado, y eso se enciende con una medición (la prueba de carga), no con un
// comentario.
//
// Segunda precisión, sobre el mix esperado: el 10/20/70 de matching.schedule.ts
// supone régimen MADURO. Una plataforma que recién lanza tiene la mayoría de sus
// vínculos creados en los últimos 3 días, o sea CALIENTES. Con 25% calientes la
// demanda sube a ~29.400/h y no entra. No se cae nada —la contrapresión hace que
// la agenda se atrase y el sistema degrade parejo— pero conviene saber que el
// margen del arranque es más flaco que el del régimen.
//
// El tope duro de 20.000 acota el peor caso de un env mal puesto: encolar 100.000
// jobs de una sentada es una forma elegante de tirar Redis.
const SWEEP_BATCH = Math.min(
    Math.max(Number(process.env.MATCH_SWEEP_BATCH) || 1500, 1),
    20000
);

// CONTRAPRESIÓN. Si el worker viene atrasado, seguir encolando NO agrega
// capacidad: cambia un techo por una cola infinita. Por encima de este umbral el
// sweep no encola nada y espera la próxima vuelta: los vínculos no se pierden, su
// agenda ya venció y siguen siendo elegibles.
//
// CORRECCIÓN de una versión anterior de este comentario, que decía que cada job
// de más "retrasa a los de prioridad ALTA que dispara el usuario (entran detrás
// de la montaña)". ES FALSO: acá se encola SIEMPRE con prioridad explícita, los
// jobs viven en el set `prioritized` de BullMQ, y uno de prioridad 1 se adelanta
// a los 4.500 de prioridad 100 — espera a lo sumo los que estén activos. La
// contrapresión igual corresponde, pero por los motivos REALES: acota la memoria
// de Redis y la presión sostenida sobre Atlas.
const SWEEP_MAX_BACKLOG = Math.max(
    Number(process.env.MATCH_SWEEP_MAX_BACKLOG) || SWEEP_BATCH * 3,
    1
);

/** Encola el recomputo de un lote de bonds activos con la agenda vencida.
 *  Devuelve cuántos encoló (0 si frenó por contrapresión). */
export const runSweepOnce = async (): Promise<number> => {
    // CONTRAPRESIÓN antes de consultar Mongo: si la cola ya está llena, ni
    // siquiera vale la pena pagar la query.
    //
    // `null` = no se pudo saber (sin Redis, o Redis con hipo). Se sigue adelante
    // a propósito: sin Redis el modo es inline y acotado por `inlineRunning`, y
    // frenar el sweep ante un blip de Redis sería peor que encolar de más.
    const pendientes = await contarPendientes();
    if (pendientes !== null && pendientes >= SWEEP_MAX_BACKLOG) {
        logger.warn(
            `[matching] sweep en pausa: ${pendientes} pendientes >= ${SWEEP_MAX_BACKLOG}. ` +
                'El worker viene atrasado; se espera la próxima vuelta.'
        );
        return 0;
    }

    // No encolar más de lo que entra bajo el umbral: si faltan 300 para el techo,
    // se encolan 300 y no 1.500.
    const cupo =
        pendientes === null
            ? SWEEP_BATCH
            : Math.min(SWEEP_BATCH, SWEEP_MAX_BACKLOG - pendientes);
    if (cupo <= 0) return 0;

    const ahora = new Date();

    // TTL ADAPTATIVO: se filtra por la AGENDA (`matchesNextAt`), no por la
    // historia (`matchesComputedAt`).
    //
    // Por qué la agenda y no el TTL uniforme de antes: con un solo TTL, un vínculo
    // parado hace tres semanas se recalculaba cada hora igual que uno recién
    // creado, y eso techaba el sistema en ~800 usuarios. Ahora cada vínculo trae
    // escrito CUÁNDO le toca, decidido por su temperatura al momento de
    // computarlo (ver matching.schedule.ts). Acá no hay política: sólo se lee la
    // agenda. Una consulta, un índice.
    //
    // ⚠️ ESTA CONSULTA ESTÁ ESCRITA PARA QUE EL ÍNDICE PROVEA TAMBIÉN EL ORDEN.
    // No es cosmético: es lo que evita un SORT BLOQUEANTE, que tiene tope duro de
    // 32 MB sin `allowDiskUse`, sobre documentos de ~40 KB (los dos vectores de
    // 1536 dims; BSON guarda como texto la clave de cada elemento). Con el lote
    // de 1.500 eso son ~60 MB: el sweep tiraría
    // `Sort exceeded memory limit`, lo comería el `catch` de abajo, devolvería 0,
    // y NADIE SE RECOMPUTARÍA NUNCA MÁS, en silencio. (Panel del 11/9.)
    //
    // Para que el índice {status, isPause, isLinked, matchesNextAt} dé filtro Y
    // orden, TODO lo anterior a la clave de orden tiene que ser IGUALDAD:
    //   · `isLinked: false` y no `{$ne: true}` — un `$ne` produce bounds
    //     multi-intervalo y rompe la propiedad. La migración de arranque
    //     (`backfillAgendaMatcheo`) garantiza que el campo esté presente en todos.
    //   · `matchesNextAt: {$lte}` y no un `$or` con `$exists: false` — un `$or`
    //     sobre la clave de orden también la rompe. Por eso el campo tiene
    //     centinela (AGENDA_VENCIDA) en vez de estar ausente.
    //
    // Se conserva el FIX de cómputo desbocado: la elegibilidad la marca un campo
    // del propio BondRequest, no la existencia de filas en BondMatch. Un bond SIN
    // matches no crea ninguna fila, así que con el criterio viejo nunca figuraba
    // como fresco y se recomputaba en CADA sweep, para siempre.
    const batch = await BondRequest.find({
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        isPause: false,
        isLinked: false,
        matchesNextAt: { $lte: ahora },
    })
        // Los más vencidos primero. Los nunca computados y los recién
        // invalidados llevan el centinela (época), así que encabezan solos.
        .sort({ matchesNextAt: 1 })
        .limit(cupo)
        .select('_id matchesNextAt')
        .lean();

    // INSTRUMENTO: cuánto lleva esperando el vínculo más atrasado. Distingue "no
    // había nada que recomputar" de "hay algo que no se está recomputando": así
    // estuvieron tres vínculos 61 días sin que nadie lo viera (la cola BullMQ no
    // lo habría mostrado: nunca llegaban a encolarse). Sale en cada vuelta que
    // llega a consultar, también con 0; si la contrapresión frena antes, la línea
    // de la pausa ocupa su lugar. Los que tienen el centinela (nunca computados o
    // recién invalidados) se cuentan aparte: su "edad" sería desde 1970. Si
    // llenaron el cupo, el más atrasado con agenda real quedó fuera del lote.
    const centinela = +agendaVencida();
    const sinComputar = (batch as any[]).filter(
        (b) => +new Date(b.matchesNextAt) === centinela
    ).length;
    const masAtrasado = (batch as any[]).find(
        (b) => +new Date(b.matchesNextAt) !== centinela
    );
    logger.info(
        `[matching] agenda: ${batch.length} vencidos (cupo ${cupo}) · ${sinComputar} sin computar · el más atrasado espera ${
            masAtrasado
                ? `${Math.round((ahora.getTime() - +new Date(masAtrasado.matchesNextAt)) / 60000)} min`
                : batch.length === cupo
                  ? 'sin ver (lote lleno de centinelas)'
                  : '—'
        }`
    );

    for (const b of batch as any[]) {
        enqueueRecompute(b._id.toString());
    }
    return batch.length;
};

let scheduled = false;
// Anti-solape: node-cron NO espera a que termine una corrida antes de disparar la
// siguiente. Con lote 1.500, la consulta + el encolado ya no son instantáneos, y
// dos corridas solapadas encolarían el mismo lote dos veces. La deduplicación por
// `jobId` lo absorbería, pero pagar la consulta dos veces no tiene sentido.
let running = false;

/** Registra el cron del sweep (idempotente). Llamar una vez al arrancar. */
export const startMatchingSweep = (): void => {
    if (!SWEEP_ENABLED) {
        logger.info(
            '[matching] sweep deshabilitado (sin REDIS_URL y sin MATCH_SWEEP_ENABLED=true).'
        );
        return;
    }
    if (scheduled) return;
    scheduled = true;
    cron.schedule(SWEEP_CRON, async () => {
        // Red de `hasActiveBonds` (orden de Personas): repara lo que se haya
        // escapado de los recálculos por escritura. ANTES del anti-solape y
        // aparte del sweep: con Redis caído `contarPendientes` espera sin límite
        // (`maxRetriesPerRequest: null`), `running` queda en true y todo lo que
        // esté después no corre más. Loguea sólo cuando corrige algo: una
        // corrección suelta puede ser una carrera con una escritura del mismo
        // instante (la arregla la vuelta siguiente); correcciones en cada vuelta
        // sí son un bug.
        try {
            const r = await reconciliarVinculosVivos();
            if (r.encendidos || r.apagados) {
                logger.warn(
                    `[vinculosVivos] reconciliación corrigió ${r.encendidos} encendidos y ${r.apagados} apagados`
                );
            }
        } catch (e) {
            errorLogger.error(
                '[vinculosVivos] reconciliación falló:',
                (e as Error)?.message
            );
        }
        if (running) return; // la corrida anterior sigue: no solapar
        running = true;
        try {
            const n = await runSweepOnce();
            if (n) logger.info(`[matching] sweep encoló ${n} recomputos.`);
        } catch (e) {
            errorLogger.error(
                '[matching] sweep falló:',
                (e as Error)?.message
            );
        } finally {
            running = false;
        }
    });
    logger.info(
        `[matching] sweep activo (${SWEEP_CRON}, lote ${SWEEP_BATCH}, techo de cola ${SWEEP_MAX_BACKLOG}).`
    );
};
