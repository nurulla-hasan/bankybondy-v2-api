/* eslint-disable @typescript-eslint/no-explicit-any */
/* El "robot" del matcheo: motor de computo continuo en segundo plano.
 *
 * - Con REDIS_URL: usa una cola BullMQ; un worker procesa recomputos de forma
 *   distribuida (varias instancias comparten la carga, con reintentos).
 * - Sin REDIS_URL: cae a un recomputo in-process (fire-and-forget, no bloquea
 *   la respuesta). El sistema sigue funcionando con compute-on-miss.
 *
 * Asi movemos el computo pesado fuera de la peticion: cuando el usuario entra,
 * sus matches ya estan en BondMatch y solo se leen.
 */
import { Queue, Worker, Job } from 'bullmq';
import mongoose from 'mongoose';
import { performance } from 'perf_hooks';
import config from '../../config';
import { errorLogger, logger } from '../../shared/logger';
import BondMatch from '../bondMatch/bondMatch.model';
import BondMatchFeed from '../bondMatch/bondMatchFeed.model';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import BondRequest from './bondRequest.model';
import { MATCHING } from './matching.config';
import { computeAndCacheMatches } from './matching.compute';
import { AGENDA, agendaVencida } from './matching.schedule';
import { notifyNewMatches } from './matching.notify';

const QUEUE_NAME = 'bond-matching';

// ---- conexion / cola / worker (perezosos y guardados) ----

// ROOT CAUSE del "fallo al encolar, uso inline": la Queue se construía a partir
// de una instancia ioredis creada A MANO (`new Redis(url)`) y pasada como
// `connection: conn as any`. Ese `as any` ocultaba que la instancia de ioredis
// de la app puede NO ser la misma copia del módulo que BullMQ trae bundleada;
// BullMQ hace comprobaciones sobre el cliente y espera flags/estado concretos.
// Si el cliente compartido entraba en error/reconexión, `queue.add()` rechazaba
// y TODO caía a cómputo inline (lento).
//
// FIX (robusto y recomendado por BullMQ): NO pasar un cliente ya construido;
// pasar OPCIONES de conexión parseadas de REDIS_URL para que BullMQ CREE y sea
// DUEÑO de su propio cliente ioredis (versión correcta, `maxRetriesPerRequest:
// null`, y las conexiones bloqueantes dedicadas que el Worker necesita).
type RedisConnOpts = {
    host: string;
    port: number;
    username?: string;
    password?: string;
    db?: number;
    tls?: Record<string, unknown>;
    maxRetriesPerRequest: null;
};

let connOptsBuilt = false;
let connOpts: RedisConnOpts | undefined;
/** Parsea REDIS_URL (redis:// | rediss://) a opciones de conexión para BullMQ. */
const getConnectionOptions = (): RedisConnOpts | undefined => {
    if (!config.redis_url) return undefined;
    if (connOptsBuilt) return connOpts;
    connOptsBuilt = true;
    try {
        const u = new URL(config.redis_url);
        const isTls = u.protocol === 'rediss:';
        const dbStr = (u.pathname || '').replace(/^\//, '');
        connOpts = {
            host: u.hostname,
            port: u.port ? Number(u.port) : 6379,
            // BullMQ EXIGE null para no abortar comandos durante reconexiones.
            maxRetriesPerRequest: null,
            ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
            ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
            ...(dbStr ? { db: Number(dbStr) } : {}),
            ...(isTls ? { tls: {} } : {}),
        };
    } catch (e: any) {
        errorLogger.error('[matching] REDIS_URL inválida', {
            message: e?.message,
            name: e?.name,
            code: e?.code,
        });
        connOpts = undefined;
    }
    return connOpts;
};

let queue: Queue | undefined;
const getQueue = (): Queue | undefined => {
    const opts = getConnectionOptions();
    if (!opts) return undefined;
    // BullMQ crea y administra su PROPIO cliente ioredis a partir de estas
    // opciones (conexión dedicada para la Queue, independiente del Worker).
    if (!queue) queue = new Queue(QUEUE_NAME, { connection: opts as any });
    return queue;
};

// ---- recomputo de un bond ----

/** Recalcula y cachea los matches de un bond activo; si esta inactivo, limpia su cache. */
const recomputeBond = async (bondId: string): Promise<void> => {
    const startRequest = await BondRequest.findOne({
        _id: bondId,
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        isPause: false,
        isLinked: { $ne: true },
    })
        // `createdAt` y `lastServedAt` viajan para que computeAndCacheMatches
        // pueda agendar el próximo recómputo por temperatura (TTL adaptativo).
        // Sin ellos todo vínculo saldría 'frio'. `computeAndCacheMatches` tiene
        // además una red de seguridad vía `_id.getTimestamp()`, pero el camino
        // correcto es traerlos.
        .select(
            'offer want offerVector wantVector location radius user modality createdAt lastServedAt matchesGen'
        )
        .lean();

    if (!startRequest) {
        const oid = new mongoose.Types.ObjectId(bondId);
        await BondMatch.deleteMany({
            sourceBond: oid,
        });
        // El read model no debe conservar filas de un bond que ya no es
        // recomputable (pausado/borrado/enlazado): se podrían seguir sirviendo.
        if (MATCHING.feedWrite) {
            await BondMatchFeed.deleteMany({ bonds: oid });
        }
        return;
    }

    const userId = (
        (startRequest as any).user?._id || (startRequest as any).user
    )?.toString();

    // D.2 (Tanda 2): snapshot de las firmas de match YA persistidas para este
    // bond ANTES del recomputo. Una "firma" es el conjunto ordenado de bonds del
    // trato. Comparando el antes/despues detectamos matches NUEVOS para avisar al
    // dueno. Esto NO toca el scoring/persistencia: solo lee lo ya guardado.
    const previous = await BondMatch.find({ sourceBond: bondId })
        .select('bonds')
        .lean();
    const previousSignatures = new Set<string>(
        (previous as any[]).map((m) =>
            (m.bonds || [])
                .map((id: any) => id.toString())
                .sort()
                .join('|')
        )
    );

    // Recomputo + persistencia intactos: computeAndCacheMatches devuelve los
    // registros frescos que acaban de guardarse.
    const records = await computeAndCacheMatches(startRequest, userId);

    // A1 (frescura simétrica): las contrapartes de un match NUEVO todavía no
    // tienen a este bond en SU caché (al crear/editar este bond solo se recomputó
    // este; el flujo viejo dejaba a la contraparte esperando hasta el TTL ~60min).
    // Encolamos el recómputo de esas contrapartes —SOLO las de matches nuevos— en
    // baja prioridad y con tope de fan-out. Termina solo: cuando la contraparte se
    // recalcula e incluye a este bond, en su próxima vuelta ese match ya no es
    // "nuevo" (está en su previousSignatures) y no re-encola. Fire-and-forget.
    const freshCounterparties = new Set<string>();
    for (const r of records) {
        const sig = [...r.ids]
            .map((id) => id.toString())
            .sort()
            .join('|');
        if (previousSignatures.has(sig)) continue; // ya existía → no es nuevo
        for (const id of r.ids) {
            const s = id.toString();
            if (s !== bondId.toString()) freshCounterparties.add(s);
        }
    }
    if (freshCounterparties.size) {
        [...freshCounterparties]
            .slice(0, MATCHING.invalidationFanout)
            .forEach((id) => enqueueRecompute(id));
    }

    // Efecto (solo hook): si aparecio al menos un match nuevo para este usuario,
    // se le crea una Notification y se emite por socket. Fire-and-forget: nunca
    // debe romper el recomputo del robot.
    notifyNewMatches({
        userId,
        bondRequestId: bondId,
        records,
        previousSignatures,
        // Para identificar EN LA CAMPANA de qué vínculo del usuario es el match
        // (antes decía sólo "tu vínculo", sin distinguir cuál de los suyos).
        sourceOffer: (startRequest as any)?.offer,
        sourceWant: (startRequest as any)?.want,
    }).catch((e) =>
        errorLogger.error(
            '[matching] notifyNewMatches fallo:',
            (e as Error)?.message
        )
    );
};

// Solo el proceso WORKER computa inline (startMatchingWorker enciende el flag).
// La API lo deja en false: si el encolado falla (Redis caido), NO mete el computo
// pesado O(N^2) en su event loop; el bond queda pendiente y el sweep lo recupera.
// Protege la API de la caida de Redis (punto unico de falla).
let INLINE_ENABLED = false;

// Fallback in-process: evita recomputar el mismo bond en paralelo.
const inlineRunning = new Set<string>();
const runInlineRecompute = (bondId: string): void => {
    if (inlineRunning.has(bondId)) return;
    inlineRunning.add(bondId);
    setImmediate(async () => {
        try {
            await recomputeBond(bondId);
        } catch (e) {
            errorLogger.error(
                '[matching] recomputo inline fallo:',
                (e as Error)?.message
            );
        } finally {
            inlineRunning.delete(bondId);
        }
    });
};

// Prioridad de la cola BullMQ: MENOR = se procesa ANTES. Los recomputos que
// dispara el USUARIO (crear/proponer/ver sus matches) van con prioridad ALTA para
// no esperar detras del lote del sweep; el sweep y los bonds afectados en segundo
// plano, prioridad BAJA. Ambos SIEMPRE con prioridad explicita (nunca 0) para no
// caer en el caso de BullMQ donde "sin prioridad" se adelanta a los priorizados.
export const MATCH_PRIORITY_USER = 1;
export const MATCH_PRIORITY_BG = 100;

/** Encola un recomputo (o lo corre inline si no hay Redis). Fire-and-forget.
 *  `priority`: MATCH_PRIORITY_USER (alta) para acciones del usuario; por defecto
 *  MATCH_PRIORITY_BG (baja: sweep/afectados). */
export const enqueueRecompute = (
    bondId: string,
    priority: number = MATCH_PRIORITY_BG
): void => {
    const q = getQueue();
    if (q) {
        q.add(
            'recompute',
            { bondId },
            {
                jobId: `rc-${bondId}`,
                priority,
                removeOnComplete: true,
                // ⚠️ TIENE QUE SER `true`, Y NO ES UN DETALLE DE HIGIENE.
                //
                // El `jobId` de arriba es DETERMINISTA (`rc-<bondId>`), que es
                // justo lo que da la deduplicación: mientras el job está en cola,
                // otro `add` del mismo vínculo no duplica trabajo. El precio es
                // que el jobId queda OCUPADO mientras el job exista en Redis.
                //
                // Con `removeOnFail: 50` (lo que había), BullMQ RETIENE los 50
                // últimos jobs fallidos. Un vínculo que agota sus 3 intentos
                // —un hipo de Atlas, un timeout de la búsqueda vectorial— deja su
                // job en estado `failed` con el jobId tomado, y a partir de ahí
                // TODO `q.add` para ese vínculo devuelve el job viejo y NO ENCOLA
                // NADA. En silencio: no tira error, no loguea, `add` resuelve bien.
                //
                // Consecuencia: ese vínculo NO SE RECOMPUTA NUNCA MÁS. Ni por
                // acción del usuario ni por el sweep, porque el sweep también
                // encola por acá. La persona deja de recibir coincidencias para
                // siempre y nadie se entera.
                //
                // Con `true`, el job fallido se borra y el jobId se libera, así
                // que el próximo intento —del sweep o del usuario— vuelve a
                // entrar. Se pierde la cola de fallidos como herramienta forense;
                // el `worker.on('failed')` de más abajo sigue dejando el rastro en
                // el log, que es donde se mira igual.
                removeOnFail: true,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            }
        ).catch((e: any) => {
            // Log enriquecido: captura el error REAL (no solo el message suelto)
            // para diagnosticar por qué falló el encolado.
            errorLogger.error('[matching] fallo al encolar', {
                message: e?.message,
                name: e?.name,
                code: e?.code,
            });
            // Solo el WORKER computa inline (INLINE_ENABLED). En la API, ante
            // fallo de encolado NO bloqueamos el event loop: el sweep recupera.
            if (INLINE_ENABLED) runInlineRecompute(bondId);
        });
        return;
    }
    // Sin cola (sin Redis): solo el worker computa inline.
    if (INLINE_ENABLED) runInlineRecompute(bondId);
};

/** Trabajo PENDIENTE en la cola (esperando + demorados), para contrapresión.
 *
 *  Lo usa el sweep: si el worker viene atrasado, subir el lote no agrega
 *  capacidad, sólo cambia un techo por una cola infinita —y además cada job
 *  encolado de más retrasa los de prioridad ALTA del usuario, que entran detrás.
 *
 *  Devuelve `null` si no se puede saber (sin Redis, o Redis con hipo). El
 *  llamador decide qué hacer con la ignorancia; acá NO se inventa un número,
 *  porque un 0 inventado desactivaría la contrapresión justo cuando hace falta. */
export const contarPendientes = async (): Promise<number | null> => {
    const q = getQueue();
    if (!q) return null;
    try {
        // `Queue.count()` de BullMQ ya suma exactamente lo que queremos: waiting
        // + paused + delayed + prioritized + waiting-children. Se usa el método
        // de la librería en vez de sumar estados a mano: como SIEMPRE encolamos
        // con prioridad explícita, los jobs viven en `prioritized` y no en
        // `waiting` — una suma hecha a ojo se habría olvidado justo del estado
        // donde están todos, y la contrapresión habría leído 0 para siempre.
        return await q.count();
    } catch (e) {
        errorLogger.error(
            '[matching] no se pudo leer el tamaño de la cola:',
            (e as Error)?.message
        );
        return null;
    }
};

// ---- invalidacion ----

/** Borra toda entrada de cache que involucre a `bondId` (como origen o participante).
 *  Devuelve los `sourceBond` afectados (para recomputarlos frescos). */
export const invalidateBondMatches = async (
    bondId: string
): Promise<string[]> => {
    const oid = new mongoose.Types.ObjectId(bondId);
    const affected = (await BondMatch.distinct('sourceBond', {
        bonds: oid,
    })) as any[];
    const affectedIds = affected
        .map((a) => a.toString())
        .filter((id) => id !== bondId.toString());
    await BondMatch.deleteMany({ sourceBond: { $in: [oid, ...affected] } });

    // Read model: se borran EXACTAMENTE las filas que mencionan al bond (dejó de
    // ser válido para todos), y se reencolan los dueños de esas filas. Las filas
    // ajenas al bond no se tocan: no hay que reconstruir feeds enteros.
    if (MATCHING.feedWrite) {
        const readers = (await BondMatchFeed.distinct('bond', {
            bonds: oid,
        })) as any[];
        await BondMatchFeed.deleteMany({ bonds: oid });
        for (const r of readers) {
            const id = r.toString();
            if (id !== bondId.toString()) affectedIds.push(id);
        }
    }

    return [...new Set(affectedIds)];
};

/** Invalida las caches que tocan a `bondId` y reencola los recomputos.
 *  `active`: si el propio bond sigue activo (se recomputa) o no (solo afectados). */
export const invalidateAndRefresh = async (
    bondId: string,
    active: boolean
): Promise<void> => {
    try {
        const affected = await invalidateBondMatches(bondId);

        // CRÍTICO (interacción con el sweep por `matchesComputedAt`): borrar las
        // filas de BondMatch NO alcanza. El sweep ya no mira la existencia de
        // caché sino `matchesComputedAt` del bond; si lo dejamos con su timestamp
        // reciente, el sweep SALTEA a los afectados diferidos y el serving les
        // devuelve CERO matches falsos hasta que expira el TTL (~60 min). Por eso
        // limpiamos `matchesComputedAt` de TODOS los afectados: así vuelven a ser
        // elegibles por el sweep de inmediato ({matchesComputedAt:{$exists:false}})
        // y el serving los ve como "computing" (reencola) en vez de "ready 0".
        // Limpiamos matchesComputedAt del PROPIO bond Y de los afectados. Antes se
        // excluía al propio bond, que quedaba con caché vacía + timestamp reciente
        // y el serving devolvía 'ready 0' falso hasta el TTL (regresión de link y
        // pausa+reactivación). Con matchesComputedAt ausente, el sweep lo retoma y
        // el serving lo ve como 'computing' (reencola).
        const toClear = [bondId, ...affected].map(
            (id) => new mongoose.Types.ObjectId(id)
        );
        // `matchesNextAt` se limpia JUNTO con `matchesComputedAt`, y por la misma
        // razón exacta: desde el TTL adaptativo, el sweep ya no mira
        // `matchesComputedAt` sino la AGENDA. Si dejáramos la agenda intacta, un
        // vínculo frío invalidado hoy tendría su `matchesNextAt` a 24 horas vista
        // → el sweep lo saltearía todo ese tiempo y el serving lo vería con caché
        // borrada, o sea CERO coincidencias durante un día entero.
        //
        // Es exactamente la trampa que ya mordió una vez con `matchesComputedAt`
        // (ver el comentario que sigue vigente arriba), sólo que con un TTL frío
        // el daño es 24 veces más largo. Con el centinela, el vínculo vuelve a ser
        // elegible de inmediato.
        //
        // Y `$inc: matchesGen` cierra la CARRERA con un cómputo en vuelo. El caso:
        // el worker arrancó a recomputar B a las 10:00; a las 10:00:03 se borra A,
        // que participaba de sus matches, y esta invalidación borra la caché de B,
        // le vence la agenda y lo encola — pero BullMQ DESCARTA ese encolado,
        // porque el jobId `rc-B` está ocupado por el job activo. A las 10:00:07 el
        // cómputo viejo termina con datos pre-evento, los persiste y agenda B a
        // 24 h vista. B queda con caché rancia y no lo toca nadie hasta mañana.
        // Con la generación incrementada, ese cómputo encuentra que su generación
        // ya no es la vigente y NO sella: B queda vencido y el sweep lo retoma.
        await BondRequest.updateMany(
            { _id: { $in: toClear } },
            {
                $set: { matchesNextAt: agendaVencida() },
                $inc: { matchesGen: 1 },
                $unset: { matchesComputedAt: '' },
            },
            // `timestamps: false`: esto es CONTABILIDAD, no un cambio del vínculo.
            // Sin la guarda, un `updateMany` que puede tocar MILES de sourceBonds
            // le movía `updatedAt` a todos — y `updatedAt` alimenta
            // `freshnessFactor`, que es el 10% del puntaje. Editar UN vínculo
            // popular reseteaba la frescura de medio sistema. Mismo criterio que
            // el backfill: una escritura de contabilidad no puede mover el ranking.
            { timestamps: false }
        );

        // Tope de fan-out (FIX de cómputo desbocado): editar/pausar/borrar un
        // bond "popular" puede invalidar MILES de sourceBonds, y encolarlos
        // todos dispara una avalancha de recomputos O(N²). Encolamos sólo los
        // primeros N (los más relevantes según el orden de `distinct`) y
        // DIFERIMOS el resto: el sweep periódico los recomputará igual porque
        // les limpiamos `matchesComputedAt` arriba. El recomputo del propio bond
        // activo SIEMPRE se encola (abajo), no cuenta contra este tope.
        const cap = MATCHING.invalidationFanout;
        const toEnqueue =
            affected.length > cap ? affected.slice(0, cap) : affected;
        if (affected.length > cap) {
            logger.warn(
                `[matching] invalidateAndRefresh: fan-out ${affected.length} > cap ${cap}; ` +
                    `encolando ${cap}, difiriendo ${affected.length - cap} al sweep.`
            );
        }
        toEnqueue.forEach((id) => enqueueRecompute(id));
        if (active) enqueueRecompute(bondId, MATCH_PRIORITY_USER);
    } catch (e) {
        errorLogger.error(
            '[matching] invalidateAndRefresh fallo:',
            (e as Error)?.message
        );
    }
};

// ---- worker / ciclo de vida ----

let worker: Worker | undefined;

/** Arranca el worker BullMQ si hay Redis; si no, deja el modo fallback. */
export const startMatchingWorker = (): void => {
    // Este metodo SOLO lo invoca el proceso worker (worker.ts). Habilita el
    // computo inline aqui; la API nunca lo llama, asi su event loop queda protegido.
    INLINE_ENABLED = true;
    const opts = getConnectionOptions();
    if (!opts) {
        logger.info(
            '[matching] sin REDIS_URL: robot en modo fallback (compute-on-miss + inline).'
        );
        return;
    }
    if (worker) return;
    // BullMQ: el Worker usa comandos BLOQUEANTES (BZPOPMIN) que monopolizan su
    // conexion. Al pasar OPCIONES (no un cliente compartido), BullMQ crea para el
    // Worker su PROPIA conexion dedicada, separada de la de la Queue; asi
    // `queue.add()` nunca queda bloqueado detras del worker.
    // Concurrencia INTERNA de este worker (jobs procesados en paralelo dentro
    // del mismo proceso). El matcheo corre en un proceso dedicado, asi que su
    // carga ya no afecta a la API. Para PARALELISMO REAL entre procesos hay que
    // levantar varias instancias del worker (subir `instances` en PM2); BullMQ
    // reparte los jobs entre todos los workers que escuchan la cola.
    const concurrency = Number(process.env.MATCH_WORKER_CONCURRENCY) || 4;
    // `lockDuration`: cuánto vive en Redis el lock de un job sin renovarse. Lo
    // que importa es cuánto tiempo SEGUIDO tolera que el event loop esté tomado,
    // y eso NO es el valor entero: el renovador corre cada lockDuration/4, la
    // primera renovación de un job cae entre lockDuration/4 y lockDuration/2 de
    // tomarlo y después cada ~lockDuration/4, y un bloqueo sobrevive si termina
    // antes de que venza lockDuration desde la última renovación. Peor caso:
    // lockDuration/2 (medido el 29/9 con un Worker y un Redis reales, 17/17). Con
    // el default de 30 s eran 15 s, y el cómputo es síncrono con concurrencia 4
    // en el mismo loop: con ~440 candidatos, 4 jobs seguidos ya rondan esos 15 s.
    // Con 120 s son 60 s. El costo: un worker muerto de verdad tarda más en
    // liberar sus jobs (≤ ~150 s: el lock más un `stalledInterval` de 30 s), y
    // son recómputos agendados en horas. Env MATCH_LOCK_DURATION_MS, acotado en
    // matching.config.ts.
    const lockDuration = MATCHING.lockDurationMs;
    // INSTRUMENTO: la `T` de la aritmética de capacidad (cuánto event loop
    // consume un recómputo), medida en producción. NO sale de cronometrar cada
    // job: con concurrencia 4 los cómputos síncronos se intercalan en el mismo
    // loop y la pared de uno incluye la CPU de los otros (medido el 29/9: con
    // T = 300 ms, pared mediana de 922 ms). Sale de cuánto estuvo ocupado el
    // loop en el minuto, repartido entre los recómputos que terminaron: es una
    // COTA SUPERIOR, porque el mismo loop corre los barridos. Con el loop cerca
    // del 100% el worker está saturado y los recómputos por minuto SON su
    // capacidad. A lo sumo una línea por minuto; ninguna si no hubo recómputos.
    const minuto = { n: 0, pared: 0, max: 0 };
    let elu = performance.eventLoopUtilization();
    setInterval(() => {
        const ahora = performance.eventLoopUtilization();
        const d = performance.eventLoopUtilization(ahora, elu);
        elu = ahora;
        if (minuto.n > 0) {
            logger.info(
                `[matching] recómputos en ${Math.round((d.idle + d.active) / 1000)} s: ${minuto.n} · pared media ${Math.round(minuto.pared / minuto.n)} ms, máx ${minuto.max} ms · event loop ${Math.round(d.utilization * 100)}% ocupado → T ≤ ${Math.round(d.active / minuto.n)} ms`
            );
        }
        minuto.n = minuto.pared = minuto.max = 0;
    }, 60000).unref();
    worker = new Worker(
        QUEUE_NAME,
        async (job: Job) => {
            if (job.name === 'recompute') {
                const t0 = Date.now();
                try {
                    await recomputeBond(job.data.bondId);
                } finally {
                    const ms = Date.now() - t0;
                    minuto.n++;
                    minuto.pared += ms;
                    if (ms > minuto.max) minuto.max = ms;
                }
            }
        },
        { connection: opts as any, concurrency, lockDuration }
    );
    // Sin este listener los errores del Worker salían por console.error —al log
    // de PM2, sin etiqueta y fuera de winston— y los de conexión con Redis caído
    // ni eso: el matcher quedaba mudo. Llega acá también "could not renew lock
    // for job X", que no es un aviso previo: el lock YA venció y ese job se va a
    // stallear (ver 'stalled').
    worker.on('error', (err: Error) => {
        errorLogger.error('[matching] worker BullMQ:', err?.message);
    });
    // Un job cuyo lock venció (el loop estuvo tomado más de lo que tolera, o
    // murió el worker que lo tenía) vuelve a la cola. En funcionamiento normal
    // esta línea no aparece NUNCA: si aparece, mirar `lockDuration` y la T.
    worker.on('stalled', (jobId: string) => {
        errorLogger.error(
            `[matching] job ${jobId} stalleado: su lock venció, vuelve a la cola`
        );
    });
    worker.on('failed', (job: Job | undefined, err: Error) => {
        errorLogger.error(`[matching] job ${job?.id} fallo:`, err?.message);

        // ANTI-ACAPARAMIENTO (panel del 11/9). `removeOnFail: true` arregla el
        // bloqueo permanente del jobId, pero de paso saca un freno accidental:
        // antes, un vínculo que fallaba siempre quedaba CLAVADO y no molestaba a
        // nadie. Ahora vuelve a estar disponible, y como el sellado de la agenda
        // sólo ocurre en el camino FELIZ, se queda con el centinela (época) →
        // encabeza el `sort` → el sweep lo reencola PRIMERO, antes que a cualquier
        // vínculo sano, 12 veces por hora, para siempre.
        //
        // Con 1.500 vínculos rotos (un `persistMatches` que choca un índice, un
        // usuario borrado a medias) llenan el lote entero y NADA SANO se recomputa.
        //
        // Acá, agotados los reintentos, se le corre la agenda hacia adelante: el
        // vínculo sigue siendo elegible —no se abandona a nadie— pero pasa al
        // fondo de la fila en vez de monopolizarla. Si la causa era transitoria,
        // en la próxima vuelta anda.
        // DOS caminos llegan a 'failed', y la condición de intentos sólo cubre uno.
        //
        // (a) Fallo normal del processor: `attemptsMade` llega a 3. Cubierto.
        // (b) Job STALLEADO más allá de `maxStalledCount`: BullMQ lo devuelve a
        //     wait, y cuando un worker lo retoma lo falla con un
        //     `UnrecoverableError` — sin reintentos, y con `attemptsMade` en **1**.
        //     Con la condición pelada, `1 >= 3` da false y la agenda NO se difería:
        //     el vínculo se quedaba con el centinela, encabezaba el orden del sweep
        //     y se reencolaba PRIMERO, 12 veces por hora, para siempre.
        //
        // Y (b) no es el caso raro: es el MÁS PROBABLE de este job. El cómputo hace
        // un grafo de dot-products sobre 1536 dims de forma sincrónica más el DFS
        // de ciclos, con concurrencia 4 en el mismo event loop, y el renovador del
        // lock es un timer. Bloquear el loop más de lo que tolera el lock es el
        // modo de falla natural acá, no el exótico (ver `lockDuration` arriba: ~60
        // s de tolerancia con 120 s de lock; con el default de 30 s eran ~15 s).
        // Un worker que muere por OOM produce lo mismo.
        const agotoIntentos =
            !!job &&
            (job.attemptsMade >= (job.opts?.attempts ?? 1) ||
                (err as Error)?.name === 'UnrecoverableError');
        const bondId = job?.data?.bondId;
        if (!agotoIntentos || !bondId) return;

        BondRequest.updateOne(
            { _id: bondId },
            {
                $set: {
                    matchesNextAt: new Date(
                        Date.now() + AGENDA.ttlFrioMin * 60 * 1000
                    ),
                },
            },
            // Sin timestamps: `updatedAt` alimenta `freshnessFactor`, que es
            // parte del puntaje. Que un vínculo falle no puede cambiar su
            // ranking. Misma razón que en el sellado de `lastServedAt`.
            { timestamps: false }
        ).catch((e: any) =>
            errorLogger.error(
                '[matching] no se pudo diferir la agenda del job fallido:',
                e?.message
            )
        );
    });
    logger.info(
        `[matching] worker BullMQ activo (concurrency ${concurrency}, lock ${lockDuration} ms).`
    );
};

/** Cierra worker/cola (apagado graceful). BullMQ es dueno de los clientes ioredis
 *  (creados desde las opciones), asi que sus `close()` cierran las conexiones. */
export const closeMatchingRobot = async (): Promise<void> => {
    try {
        if (worker) await worker.close();
        if (queue) await queue.close();
    } catch {
        /* noop */
    }
};

export { recomputeBond };
