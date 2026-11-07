/* eslint-disable @typescript-eslint/no-explicit-any */
/* Cómputo del matcheo de bonds (pares + ciclos) con el finalScore real.
 *
 * Reúne: candidatos de alta calidad (búsqueda vectorial), reputación cacheada,
 * proximidad y frescura, y produce los tratos posibles rankeados por finalScore.
 * Es reutilizable tanto por la petición (compute-on-miss) como por el robot (paso 5).
 *
 * NO importa bondRequest.service para evitar dependencias circulares: los
 * helpers semánticos se definen acá.
 */
import mongoose from 'mongoose';
import NormalUser from '../normalUser/normalUser.model';
import BondMatch from '../bondMatch/bondMatch.model';
// Solo el MODELO (no el service) para sellar `matchesComputedAt`: importar el
// modelo no crea la dependencia circular que sí traería importar el service.
import BondRequest from './bondRequest.model';
import { BondMatchType, IMatchScoreParts } from '../bondMatch/bondMatch.interface';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import { fetchMatchCandidates } from './matching.candidates';
import { MATCHING } from './matching.config';
import { persistMatchFeed } from './matching.feed';
import {
    bondMatchFeedTrimDeletedTotal,
    bondMatchFeedUpsertsTotal,
    bondMatchFeedWriteErrorsTotal,
} from '../../middlewares/metrics';
import { logger } from '../../shared/logger';
import { proximoRecomputoEn } from './matching.schedule';
import {
    emptyEdgeScore,
    finalMatchScore,
    freshnessFactor,
    modalityFactor,
    passesGate,
    proximityFactor,
    semanticQuality,
    surpriseAdjustedScore,
} from './matching.scoring';

export interface MatchRecord {
    ids: string[];
    users: string[];
    score: number;
    parts: IMatchScoreParts;
    type: BondMatchType;
    size: number;
}

// ---- helpers semánticos (autocontenidos) ----

// Vectores de OpenAI (`text-embedding-3-small`) vienen L2-normalizados, así que
// cos == producto punto. Pre-normalizamos UNA vez a Float32Array (defensivo,
// barato) y en el hot loop solo hacemos un dot product: sin magnitudes ni sqrt
// por par. El resultado es numéricamente idéntico al cos previo (dot de vectores
// unitarios == coseno), conservando escala, `minScore` y gates de calidad.

/** L2-normaliza un vector crudo a Float32Array UNA sola vez. null si vacío. */
const normalizeToF32 = (v: unknown): Float32Array | null => {
    if (!Array.isArray(v) || v.length === 0) return null;
    const f = new Float32Array(v.length);
    let mag = 0;
    for (let i = 0; i < v.length; i++) {
        const x = typeof v[i] === 'number' ? (v[i] as number) : 0;
        f[i] = x;
        mag += x * x;
    }
    mag = Math.sqrt(mag);
    if (mag > 0) {
        const inv = 1 / mag;
        for (let i = 0; i < f.length; i++) f[i] *= inv;
    }
    return f;
};

/** Producto punto sobre vectores YA normalizados == coseno. Sin sqrt por llamada. */
const dot = (a: Float32Array, b: Float32Array): number => {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
};

const normalizeText = (s?: string) =>
    (s || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

/** Calidad de una cadena a partir de sus aristas: MISMA vara que los pares
 *  (`semanticQuality`): `wMin·peor + (1-wMin)·promedio`. Generaliza la mezcla a N
 *  aristas para que un ciclo con varios matches buenos NO quede aplastado por su
 *  eslabón más débil (como pasaba con el `min` pelado). Los valores ya están en
 *  [0,1], así que la mezcla también. */
const blendEdges = (edges: number[]): number => {
    if (!edges.length) return 0;
    const min = Math.min(...edges);
    const mean = edges.reduce((a, b) => a + b, 0) / edges.length;
    return MATCHING.wMin * min + (1 - MATCHING.wMin) * mean;
};

/**
 * Similitud direccional de un borde (el deseo de A satisfecho por la oferta de B),
 * operando sobre los Float32Array pre-normalizados: `sim` es un dot product ==
 * coseno de vectores unitarios. El comodín "surprise" se aplica SIMÉTRICO: si el
 * DESEO es surprise ("acepto cualquier oferta") o la OFERTA es surprise ("doy lo
 * que busques"), el borde toma el puntaje comodín (piso/techo, ver matching.config
 * y surpriseAdjustedScore). Así funciona tanto `Pido·Sorpresa` como `Ofrezco·Sorpresa`.
 */
const directionalScoreF32 = (
    want: string,
    wantF32: Float32Array | null,
    offer: string,
    offerF32: Float32Array | null
): number => {
    const wantEmpty = normalizeText(want) === 'empty';
    const offerEmpty = normalizeText(offer) === 'empty';
    const wantSurprise = normalizeText(want) === 'surprise';
    const offerSurprise = normalizeText(offer) === 'surprise';
    // 'vacío' (nada) tiene PRIORIDAD semántica: su vector no tiene señal (se parece
    // solo a sí mismo → coseno espurio), así que se resuelve SOLO por banda, no por
    // similitud. Ver Matcheo-Comodines-Spec §4: vacío↔vacío=encuentro (alto),
    // vacío↔sorpresa=mixed (flojo), vacío↔concreto=0 (excluido).
    if (wantEmpty || offerEmpty) {
        return emptyEdgeScore(wantEmpty, wantSurprise, offerEmpty, offerSurprise);
    }
    // Sin vacío: la oferta necesita vector real. 'surprise' SÍ tiene vector.
    if (!offerF32 || offerF32.length === 0) return 0;
    const sim = wantF32 && wantF32.length ? dot(wantF32, offerF32) : 0;
    return surpriseAdjustedScore(sim, wantSurprise, offerSurprise);
};

/** Distancia en km entre dos puntos [lng, lat] (haversine). */
const haversineKm = (a?: number[], b?: number[]): number | undefined => {
    if (!a || !b || a.length < 2 || b.length < 2) return undefined;
    const R = 6371;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

type MatchType = BondMatchType;

const getPairMatchType = (candidate: any): MatchType => {
    const want = normalizeText(candidate.want);
    const offer = normalizeText(candidate.offer);
    if (want === 'empty' || offer === 'empty') return 'empty';
    if (want === 'surprise' || offer === 'surprise') return 'surprise';
    return 'entry';
};

// ---- cómputo principal ----

/** Computa todos los tratos posibles (pares + ciclos 3–N) para un bond de partida. */
export const computeMatchesForBond = async (
    startRequest: any,
    userId: string
): Promise<MatchRecord[]> => {
    const bondRequestId = startRequest._id.toString();
    const startUser = (startRequest.user?._id || startRequest.user)?.toString();
    const startModality = startRequest.modality;
    const isOnline = startRequest.modality === 'online';

    // Geo como PUNTAJE, no como filtro (default). Por defecto NO excluimos
    // candidatos por distancia: la cercanía sigue influyendo vía proximityFactor
    // en el score, pero nadie queda afuera por no tener coordenadas o estar lejos.
    // Evita el "0 matches por ubicación" cuando la contraparte no tiene coords.
    // Reactivable con MATCH_GEO_HARD_FILTER=true si en el futuro conviene un radio real.
    const geoFilter: any = {};
    const geoHardFilter =
        (process.env.MATCH_GEO_HARD_FILTER ?? 'false').toLowerCase() === 'true';
    if (
        geoHardFilter &&
        !isOnline &&
        startRequest.location?.coordinates?.length >= 2 &&
        startRequest.radius
    ) {
        const [lng, lat] = startRequest.location.coordinates;
        geoFilter.location = {
            $geoWithin: {
                $centerSphere: [[lng, lat], startRequest.radius / 6371],
            },
        };
    }

    const { candidates } = await fetchMatchCandidates(
        startRequest,
        bondRequestId,
        userId,
        geoFilter
    );

    // Pre-normalización ÚNICA de los vectores 1536-dim a Float32Array. A partir
    // de acá el hot loop O(N²) usa solo dot products (== coseno), sin recalcular
    // magnitudes ni sqrt por par. Se cachea en el propio objeto (_offerF32 /
    // _wantF32) para que tanto los pares como las aristas del grafo lo reutilicen.
    startRequest._offerF32 = normalizeToF32(startRequest.offerVector);
    startRequest._wantF32 = normalizeToF32(startRequest.wantVector);
    for (const c of candidates) {
        c._offerF32 = normalizeToF32(c.offerVector);
        c._wantF32 = normalizeToF32(c.wantVector);
    }

    // Mapa de reputación (score cacheado en NormalUser, prior si falta).
    const userIds = Array.from(
        new Set(
            candidates
                .map((c) => (c.user?._id || c.user)?.toString())
                .filter(Boolean)
        )
    );
    const repDocs = userIds.length
        ? await NormalUser.find({ _id: { $in: userIds } })
              .select('reputation')
              .lean()
        : [];
    const repByUser = new Map<string, number>();
    for (const u of repDocs as any[]) {
        repByUser.set(
            u._id.toString(),
            typeof u.reputation?.score === 'number'
                ? u.reputation.score
                : MATCHING.reputation.prior
        );
    }
    const repOf = (uid?: string): number => {
        if (!uid) return MATCHING.reputation.prior;
        const v = repByUser.get(uid);
        return typeof v === 'number' ? v : MATCHING.reputation.prior;
    };

    // Propiedades por bond (proximidad respecto al start; frescura).
    // Online: la proximidad no aplica (intercambio global) → factor 1.
    const startCoords = startRequest.location?.coordinates;
    const radiusKm: number | undefined = startRequest.radius;
    const proxOfNode = (node: any): number =>
        isOnline
            ? 1
            : proximityFactor(
                  haversineKm(startCoords, node.location?.coordinates),
                  radiusKm
              );
    const freshOfNode = (node: any): number => freshnessFactor(node.updatedAt);

    const records: MatchRecord[] = [];
    const globalSeen = new Set<string>();

    // ---- Pares (2 personas) ----
    for (const candidate of candidates) {
        // Sin gate especial de 'empty': la validez la define el propio score. Las
        // combinaciones inválidas (deseo concreto ← oferta vacía, y su simétrica)
        // dan arista 0 vía `emptyEdgeScore` → `passesGate` las filtra. Así el
        // "regalo" queda SIMÉTRICO por construcción (antes el gate era asimétrico y
        // dejaba el match de un solo lado). Ver Matcheo-Comodines-Spec §4/§7.
        const s1 = directionalScoreF32(
            startRequest.want,
            startRequest._wantF32,
            candidate.offer,
            candidate._offerF32
        );
        const s2 = directionalScoreF32(
            candidate.want,
            candidate._wantF32,
            startRequest.offer,
            startRequest._offerF32
        );

        if (!passesGate(s1, s2)) continue;

        const candId = candidate._id.toString();
        const candUser = (candidate.user?._id || candidate.user)?.toString();
        const key = [bondRequestId, candId].sort().join('-');
        if (globalSeen.has(key)) continue;
        globalSeen.add(key);

        const parts: IMatchScoreParts = {
            sem: semanticQuality(s1, s2),
            rep: repOf(candUser),
            prox: proxOfNode(candidate),
            fresh: freshOfNode(candidate),
        };
        // Modalidad como preferencia suave: si los formatos difieren, baja el
        // score (sin excluir). Tolerante a modalidad ausente (factor 1).
        const score =
            finalMatchScore({
                semQuality: parts.sem,
                reputation: parts.rep,
                proximity: parts.prox,
                freshness: parts.fresh,
            }) * modalityFactor(startModality, candidate.modality);

        records.push({
            ids: [bondRequestId, candId],
            users: [startUser, candUser].filter(Boolean),
            score,
            parts,
            type: getPairMatchType(candidate),
            size: 2,
        });
    }

    // ---- Grafo para ciclos ----
    const requestMap = new Map<string, any>(
        candidates.map((c) => [c._id.toString(), c])
    );
    requestMap.set(bondRequestId, startRequest);

    const edges = new Map<string, { to: string; score: number }[]>();
    for (const [id, req] of requestMap.entries()) {
        edges.set(id, []);
        for (const [toId, toReq] of requestMap.entries()) {
            if (id === toId) continue;
            const score = directionalScoreF32(
                req.want,
                req._wantF32,
                toReq.offer,
                toReq._offerF32
            );
            if (score >= MATCHING.minScore) {
                edges.get(id)!.push({ to: toId, score });
            }
        }
    }
    // Beam: ordenar las aristas de cada nodo por score desc, para extender
    // primero por los enlaces más fuertes (los ciclos de mayor puntaje).
    for (const list of edges.values()) list.sort((a, b) => b.score - a.score);

    const userOfBond = (id: string): string | undefined => {
        const r = requestMap.get(id);
        return (r?.user?._id || r?.user)?.toString();
    };

    const getCycleMatchType = (path: string[]): MatchType => {
        let hasSurprise = false;
        for (const id of path) {
            if (id === bondRequestId) continue;
            const req = requestMap.get(id);
            const want = normalizeText(req?.want);
            const offer = normalizeText(req?.offer);
            if (want === 'empty' || offer === 'empty') return 'empty';
            if (want === 'surprise' || offer === 'surprise') hasSurprise = true;
        }
        return hasSurprise ? 'surprise' : 'entry';
    };

    const seenCycles = new Set<string>();
    const maxCycleSize = MATCHING.maxCycleSize;
    const beamK = MATCHING.cycleBeamK;
    const cycleBudget = MATCHING.cycleBudget;
    let emitted = 0;

    const dfs = (
        startId: string,
        currentId: string,
        path: string[],
        edgeScores: number[]
    ) => {
        if (emitted >= cycleBudget) return;
        if (path.length > maxCycleSize) return;

        const usersInPath = new Set(path.map(userOfBond));
        // Aristas ya ordenadas por score desc.
        const neighbors = edges.get(currentId) || [];

        // Cierre del ciclo: se evalúa sobre TODAS las aristas (el beam NO lo
        // limita), para no perder ciclos válidos que cierran con una arista de
        // menor score.
        if (path.length >= 3) {
            const closing = neighbors.find((e) => e.to === startId);
            if (closing) {
                const hash = path.join('-');
                if (!seenCycles.has(hash) && !globalSeen.has(hash)) {
                    seenCycles.add(hash);
                    globalSeen.add(hash);

                    // Calidad del ciclo: la MISMA mezcla que los pares (no el min
                    // pelado), así los ciclos con varios matches buenos no quedan
                    // aplastados por un solo eslabón flojo. `legacyRanking` vuelve
                    // al min de siempre. (allEdges incluye el cierre del ciclo.)
                    const allEdges = [...edgeScores, closing.score];
                    const sem = MATCHING.legacyRanking
                        ? Math.min(...allEdges)
                        : blendEdges(allEdges);

                    // Participantes del ciclo, excluyendo mi propio bond de partida.
                    const participants = path.filter(
                        (id) => id !== bondRequestId
                    );
                    const reps = participants.map((id) => repOf(userOfBond(id)));
                    const proxs = participants.map((id) =>
                        proxOfNode(requestMap.get(id))
                    );
                    const freshs = participants.map((id) =>
                        freshOfNode(requestMap.get(id))
                    );

                    const parts: IMatchScoreParts = {
                        sem,
                        rep: reps.length ? Math.min(...reps) : MATCHING.reputation.prior,
                        prox: proxs.length ? Math.min(...proxs) : 1,
                        fresh: freshs.length ? Math.min(...freshs) : 1,
                    };
                    // Penalización de modalidad del ciclo = el peor eslabón:
                    // mínimo factor entre el bond de partida y cada participante.
                    const modFactor = participants.length
                        ? Math.min(
                              ...participants.map((id) =>
                                  modalityFactor(
                                      startModality,
                                      requestMap.get(id)?.modality
                                  )
                              )
                          )
                        : 1;
                    const finalScore =
                        finalMatchScore({
                            semQuality: parts.sem,
                            reputation: parts.rep,
                            proximity: parts.prox,
                            freshness: parts.fresh,
                        }) * modFactor;

                    records.push({
                        ids: [...path],
                        users: path.map(userOfBond).filter(Boolean) as string[],
                        score: finalScore,
                        parts,
                        type: getCycleMatchType(path),
                        size: path.length,
                    });
                    emitted++;
                }
            }
        }

        // Extensión: solo las top-K aristas más fuertes (beam), evitando repetir
        // bond o usuario. Acota la explosión conservando los ciclos de más puntaje.
        let explored = 0;
        for (const { to, score } of neighbors) {
            if (explored >= beamK || emitted >= cycleBudget) break;
            if (to === startId) continue;
            if (path.includes(to)) continue;
            if (usersInPath.has(userOfBond(to))) continue;
            explored++;
            dfs(startId, to, [...path, to], [...edgeScores, score]);
        }
    };

    dfs(bondRequestId, bondRequestId, [bondRequestId], []);

    // Dedup por CONJUNTO de bonds (no por el orden del path del DFS): un ciclo
    // A-B-C y su reverso A-C-B (o cualquier rotación) son el MISMO grupo de
    // personas → debe quedar UN solo match, el de mayor score. El hash por path
    // del DFS no canonicaliza dirección/rotación, así que dos orientaciones del
    // mismo trío se emitían como dos records distintos. Acá se colapsan por el
    // set ordenado de ids. (Los pares ya venían deduplicados por `globalSeen`.)
    const bestBySet = new Map<string, MatchRecord>();
    for (const r of records) {
        const key = [...r.ids].sort().join('|');
        const prev = bestBySet.get(key);
        if (!prev || r.score > prev.score) bestBySet.set(key, r);
    }
    const deduped = [...bestBySet.values()];

    // Tope duro: nos quedamos con los N MEJORES por finalScore (los "100 mejores").
    // Nunca se guardan/sirven más de esto por bond.
    deduped.sort((a, b) => b.score - a.score);
    const top = deduped.slice(0, MATCHING.maxResults);

    // Orden de almacenamiento (el serving re-ordena igual). NUEVO: por score puro
    // (el top-N ya se eligió por calidad). LEGACY: pares antes que ciclos.
    top.sort((a, b) => {
        if (MATCHING.legacyRanking && a.size !== b.size) return a.size - b.size;
        return b.score - a.score;
    });

    return top;
};

/** Reemplaza en BondMatch los tratos precomputados para un bond de partida. */
export const persistMatches = async (
    sourceBondId: string,
    records: MatchRecord[]
): Promise<void> => {
    const sourceBond = new mongoose.Types.ObjectId(sourceBondId);
    const docs = records.map((r) => ({
        sourceBond,
        bonds: r.ids.map((id) => new mongoose.Types.ObjectId(id)),
        users: r.users.map((id) => new mongoose.Types.ObjectId(id)),
        score: r.score,
        parts: r.parts,
        type: r.type,
        size: r.size,
        computedAt: new Date(),
    }));

    // Atómico donde haya soporte (Atlas replica set): el delete+insert va en una
    // transacción, evitando la ventana en que el usuario vería 0 matches o
    // duplicados si el worker y la petición corren a la vez.
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await BondMatch.deleteMany({ sourceBond }, { session });
            if (docs.length) await BondMatch.insertMany(docs, { session });
        });
    } catch {
        // Entorno sin transacciones (Mongo standalone): fallback secuencial.
        await BondMatch.deleteMany({ sourceBond });
        if (docs.length) await BondMatch.insertMany(docs);
    } finally {
        session.endSession();
    }
};

/** Computa y cachea (lo invoca el robot; ya no se corre en la petición). */
export const computeAndCacheMatches = async (
    startRequest: any,
    userId: string
): Promise<MatchRecord[]> => {
    const records = await computeMatchesForBond(startRequest, userId);
    await persistMatches(startRequest._id.toString(), records);

    // Read model por participante (expand/contract). Best-effort durante el
    // rollout: si falla, seguimos sirviendo desde BondMatch y se loguea. Cuando
    // el feed es la fuente de lectura, el fallo SE PROPAGA: sin filas frescas el
    // vínculo quedaría sirviendo datos viejos, así que el job debe reintentar y
    // NO sellar la agenda.
    if (MATCHING.feedWrite) {
        try {
            const stats = await persistMatchFeed(
                startRequest._id.toString(),
                records
            );
            bondMatchFeedUpsertsTotal.inc(stats.upserts);
            bondMatchFeedTrimDeletedTotal.inc(stats.trimmed);
        } catch (e) {
            bondMatchFeedWriteErrorsTotal.inc();
            logger.error(
                `[matching] persistMatchFeed fallo para ${startRequest._id}:`,
                (e as Error)?.message
            );
            if (MATCHING.feedRead) throw e;
        }
    }

    const ahora = Date.now();

    // ESCALA (TTL adaptativo): además de sellar CUÁNDO se computó, se agenda
    // CUÁNDO toca la próxima vez, según la temperatura del vínculo. Ver
    // matching.schedule.ts para la aritmética que esto resuelve.
    //
    // `createdAt` con red de seguridad: si el `select` del llamador no lo trajo,
    // caer en `undefined` haría que TODO vínculo saliera 'frio' (24 h) y la caché
    // se pondría rancia para todos, en silencio y sin ningún error. El `_id` de
    // Mongo LLEVA ADENTRO su fecha de creación, así que `getTimestamp()` da la
    // respuesta correcta siempre, venga o no el campo en la proyección.
    const creadoEn =
        (startRequest as any)?.createdAt ??
        (typeof (startRequest as any)?._id?.getTimestamp === 'function'
            ? (startRequest as any)._id.getTimestamp()
            : undefined);

    // SELLADO CONDICIONAL POR GENERACIÓN (panel del 11/9).
    //
    // El filtro incluye `matchesGen`, la generación que leímos al EMPEZAR. Si
    // durante el cómputo alguien invalidó este vínculo, `invalidateAndRefresh` la
    // incrementó y este `updateOne` NO MATCHEA: no sellamos nada y el vínculo
    // queda con la agenda vencida, así que el sweep lo retoma enseguida.
    //
    // Sin esta guarda había una carrera con consecuencias largas: el worker
    // arranca a recomputar B a las 10:00; a las 10:00:03 se borra A, que
    // participaba de sus matches → la invalidación borra la caché de B y lo
    // encola, pero BullMQ DESCARTA ese encolado porque el jobId `rc-B` está
    // ocupado por el job activo; a las 10:00:07 este cómputo termina con datos
    // pre-evento y agenda B a 24 h vista. B se quedaba con caché rancia hasta
    // mañana. Con el TTL uniforme el mismo agujero se cerraba solo en ≤60 min.
    //
    // Las filas de BondMatch ya se persistieron arriba y quedan (viejas) hasta el
    // próximo cómputo. Es deliberado: el filtro fantasma del serving descarta los
    // tratos cuyas contrapartes ya no están vivas, así que no se muestra nada
    // imposible, y el vínculo está vencido para el sweep.
    const genAlEmpezar = (startRequest as any)?.matchesGen ?? 0;
    // ⚠️ EL `$in: [0, null]` NO ES DECORATIVO cuando la generación es 0.
    //
    // En Mongo, `{ matchesGen: 0 }` **no matchea un documento donde el campo está
    // AUSENTE** — sólo `null` lo hace, y `$in: [..., null]` cubre null Y ausente.
    // Sin esto, ningún vínculo anterior a este campo podía sellar nunca su
    // cómputo: el sweep los retomaba en bucle y copaban el lote entero.
    //
    // `backfillAgendaMatcheo` siembra el campo, pero esta guarda igual hace falta:
    // **la migración corre en la API y el sweep corre en el WORKER**, que son
    // procesos distintos de PM2. Si el worker arranca y la API no (deploy parcial,
    // API en bucle de reinicio), el sweep trabaja sobre un árbol sin migrar. La
    // migración es la solución; esto es la red por si llega tarde.
    const filtroGen =
        genAlEmpezar === 0 ? { $in: [0, null] } : genAlEmpezar;
    const sellado = await BondRequest.updateOne(
        { _id: startRequest._id, matchesGen: filtroGen },
        {
            $set: {
                // El serving lo usa para saber que YA se computó aunque `records`
                // esté vacío (cero matches), y así el front deja de sondear en
                // lugar de quedarse en "computing" para siempre.
                matchesComputedAt: new Date(ahora),
                matchesNextAt: proximoRecomputoEn({
                    ahora,
                    createdAt: creadoEn,
                    lastServedAt: (startRequest as any)?.lastServedAt,
                }),
            },
        }
    );
    if (!sellado.matchedCount) {
        // El mensaje NO afirma la causa. Un `matchedCount` en cero puede ser una
        // invalidación concurrente (lo esperado), pero también el documento
        // borrado entre el cómputo y el sellado, o un campo que no está donde se
        // lo espera. Una versión anterior decía "descartado por invalidación
        // concurrente" a secas, y cuando la causa real fue otra —el campo ausente
        // de todo el corpus— el único rastro del incidente apuntaba al lugar
        // equivocado. Diagnosticar con un log que adivina cuesta horas.
        logger.warn(
            `[matching] el cómputo del vínculo ${startRequest._id} no se selló ` +
                `(gen esperada ${genAlEmpezar}): invalidación concurrente, o el ` +
                `documento cambió/desapareció. El sweep lo retoma.`
        );
    }
    return records;
};

export { ENUM_BOND_REQUEST_STATUS };
