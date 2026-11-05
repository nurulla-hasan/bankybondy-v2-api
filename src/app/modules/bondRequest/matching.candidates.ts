/* eslint-disable @typescript-eslint/no-explicit-any */
/* Obtención de candidatos para el matcheo de bonds — a escala.
 *
 * Reemplaza el "$sample: 150 al azar" por una búsqueda semántica de vecinos
 * (Atlas Vector Search), SIN cambiar la lógica de match mutuo ni de ciclos.
 *
 * Estrategia (ver DISENO_MATCHEO_BONDS.md §4 y §8):
 *   - Búsqueda A (salida): bonds cuya OFERTA se parece a lo que YO QUIERO.
 *   - Búsqueda B (entrada): bonds cuyo DESEO se parece a lo que YO OFREZCO.
 *   - Unión de A y B = candidatos → cubre pares y ciclos de 3.
 *   - Expansión de frontera de 1 salto en ambas direcciones → trae los
 *     "nodos del medio" de las cadenas, cubriendo ciclos de 4 y 5 de forma
 *     demostrable (no por azar).
 *   - Geo se aplica como $match posterior (solo bonds físicos con radio).
 *
 * Fallback automático: si el índice vectorial no existe todavía (o el bond
 * de partida no tiene vectores), cae al $sample actual. Así se puede desplegar
 * el código antes de crear el índice en Atlas, sin ventanas de caída.
 */
import mongoose from 'mongoose';
import { ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';
import BondRequest from './bondRequest.model';
import { MATCHING } from './matching.config';
import { errorLogger } from '../../shared/logger';

export type CandidateFetchMethod = 'vector' | 'sample';

export interface CandidateFetchResult {
    candidates: any[];
    method: CandidateFetchMethod;
}

const CANDIDATE_PROJECT = {
    $project: {
        _id: 1,
        user: 1,
        offer: 1,
        want: 1,
        offerVector: 1,
        wantVector: 1,
        location: 1,
        updatedAt: 1,
        modality: 1,
        score: { $meta: 'vectorSearchScore' },
    },
};

const hasVector = (v: unknown): v is number[] =>
    Array.isArray(v) && v.length > 0;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

/** Una consulta ANN sobre un path vectorial, con filtro base + geo opcional.
 *  Reintenta ante fallas transitorias (timeout de conexión, elección de
 *  primario, blip de red) ANTES de propagar el error — así el caller solo cae
 *  al $sample aleatorio si el vectorSearch falla de verdad, no por un hipo
 *  momentáneo. Backoff lineal; nº de reintentos y demora son env-ajustables. */
const runVectorSearch = async (
    path: 'offerVector' | 'wantVector',
    queryVector: number[],
    limit: number,
    numCandidates: number,
    baseFilter: Record<string, unknown>,
    geoFilter: Record<string, unknown>
): Promise<any[]> => {
    const pipeline: any[] = [
        {
            $vectorSearch: {
                index: MATCHING.vectorIndexName,
                path,
                queryVector,
                numCandidates,
                limit,
                filter: baseFilter,
            },
        },
    ];
    if (geoFilter && Object.keys(geoFilter).length) {
        pipeline.push({ $match: geoFilter });
    }
    pipeline.push(CANDIDATE_PROJECT);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= MATCHING.vectorSearchRetries; attempt++) {
        try {
            return await BondRequest.aggregate(pipeline);
        } catch (err) {
            lastErr = err;
            if (attempt < MATCHING.vectorSearchRetries) {
                await sleep(MATCHING.vectorSearchRetryDelayMs * (attempt + 1));
            }
        }
    }
    throw lastErr;
};

// Tokens comodín. Sus vectores (embed('surprise'/'empty')) no tienen señal
// semántica → la búsqueda vectorial NO los recupera como "nodos del medio". Los
// traemos con una consulta DIRECTA (no vectorial), acotada, para que puedan ser
// NEXOS en las cadenas. Aditivo: solo suma candidatos.
//
// CASE-INSENSITIVE a propósito: hay DOS UIs de creación que guardan distinto el
// token — `AddNewBondModal` persiste 'Empty'/'Surprise' (Mayúscula) y `bonds/page`
// persiste 'empty'/'surprise' (minúscula). La DB tiene MEZCLA. Un `$in` con strings
// literales es case-sensitive en Mongo → perdía los capitalizados en silencio (no
// se recuperaban como candidatos → no matcheaban). El scoring ya era case-insensitive
// (`normalizeText` lowercasea), así que solo la recuperación quedaba coja. Se usan
// regex ancladas case-insensitive para cubrir TODA la data (mayúscula/minúscula/mixta).
const WILDCARD_TOKEN_MATCHERS = [/^surprise$/i, /^empty$/i];

const WILDCARD_PROJECT = {
    $project: {
        _id: 1,
        user: 1,
        offer: 1,
        want: 1,
        offerVector: 1,
        wantVector: 1,
        location: 1,
        updatedAt: 1,
        modality: 1,
    },
};

/** Trae bonds comodín activos (offer/want = surprise/empty) con el mismo filtro
 *  base (estado/pausa/link/usuario/modalidad) + geo. Acotado por wildcardCap. */
const fetchWildcardCandidates = async (
    baseFilter: Record<string, unknown>,
    geoFilter: Record<string, unknown>
): Promise<any[]> => {
    if (!MATCHING.includeWildcards) return [];
    const match: Record<string, unknown> = {
        ...baseFilter,
        $or: [
            { offer: { $in: WILDCARD_TOKEN_MATCHERS } },
            { want: { $in: WILDCARD_TOKEN_MATCHERS } },
        ],
        ...geoFilter,
    };
    return BondRequest.aggregate([
        { $match: match },
        { $limit: MATCHING.wildcardCap },
        WILDCARD_PROJECT,
    ]);
};

/**
 * Obtiene candidatos de alta calidad para el bond de partida.
 * Intenta Atlas Vector Search (bidireccional + frontera); si falla, $sample.
 */
export const fetchMatchCandidates = async (
    startRequest: any,
    bondRequestId: string,
    userId: string,
    geoFilter: Record<string, unknown>
): Promise<CandidateFetchResult> => {
    const startId = bondRequestId.toString();

    // ¿Podemos usar búsqueda vectorial? Necesitamos los vectores del bond base.
    const canVector =
        hasVector(startRequest.offerVector) &&
        hasVector(startRequest.wantVector);

    // Modalidad como preferencia SUAVE (default): NO se filtra por formato en la
    // recuperación, así online y presencial pueden matchear (la penalización va en
    // el score, en matching.compute). Con MATCH_CROSS_MODALITY=false se vuelve al
    // filtro duro: 'online' con 'online'; físico (o legado sin campo) con físico.
    const modalityFilter: Record<string, unknown> = MATCHING.crossModality
        ? {}
        : startRequest.modality === 'online'
          ? { modality: 'online' }
          : { modality: { $ne: 'online' } };

    // Filtro base compartido: bonds activos que NO son míos, en la modalidad
    // correspondiente. Lo usan la búsqueda vectorial, el $sample y los comodines.
    const activeBaseFilter: Record<string, unknown> = {
        status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
        isPause: false,
        isLinked: { $ne: true },
        user: { $ne: new mongoose.Types.ObjectId(userId) },
        ...modalityFilter,
    };

    if (canVector) {
        try {
            // El filtro base excluye mis propios bonds (incluye el de partida),
            // pausados y no-activos. user != yo ya cubre el $ne del _id.
            const baseFilter = activeBaseFilter;

            // Vecinos directos: A (salida) y B (entrada).
            const [outNeighbors, inNeighbors] = await Promise.all([
                runVectorSearch(
                    'offerVector',
                    startRequest.wantVector,
                    MATCHING.candidateK,
                    MATCHING.numCandidates,
                    baseFilter,
                    geoFilter
                ),
                runVectorSearch(
                    'wantVector',
                    startRequest.offerVector,
                    MATCHING.candidateK,
                    MATCHING.numCandidates,
                    baseFilter,
                    geoFilter
                ),
            ]);

            const byId = new Map<string, any>();
            const add = (docs: any[]) => {
                for (const d of docs) {
                    const id = d._id.toString();
                    if (id === startId) continue;
                    if (!byId.has(id)) byId.set(id, d);
                }
            };
            add(outNeighbors);
            add(inNeighbors);

            // Expansión de frontera (1 salto, ambas direcciones) para traer
            // los nodos del medio de cadenas de 4–5.
            if (MATCHING.frontierEnabled) {
                const outSeeds = outNeighbors
                    .filter((d) => hasVector(d.wantVector))
                    .slice(0, MATCHING.frontierSeeds);
                const inSeeds = inNeighbors
                    .filter((d) => hasVector(d.offerVector))
                    .slice(0, MATCHING.frontierSeeds);

                const frontierQueries: Promise<any[]>[] = [];
                // Adelante: quién OFRECE lo que mi vecino-de-salida QUIERE.
                for (const seed of outSeeds) {
                    frontierQueries.push(
                        runVectorSearch(
                            'offerVector',
                            seed.wantVector,
                            MATCHING.frontierK,
                            MATCHING.frontierNumCandidates,
                            baseFilter,
                            geoFilter
                        )
                    );
                }
                // Atrás: quién QUIERE lo que mi vecino-de-entrada OFRECE.
                for (const seed of inSeeds) {
                    frontierQueries.push(
                        runVectorSearch(
                            'wantVector',
                            seed.offerVector,
                            MATCHING.frontierK,
                            MATCHING.frontierNumCandidates,
                            baseFilter,
                            geoFilter
                        )
                    );
                }

                const frontierResults = await Promise.all(frontierQueries);
                for (const docs of frontierResults) add(docs);
            }

            // Comodines como nexos de cadena: se agregan SIEMPRE (aditivo, acotado).
            add(await fetchWildcardCandidates(activeBaseFilter, geoFilter));

            return { candidates: [...byId.values()], method: 'vector' };
        } catch (err) {
            // ALARMA DURA: caer a $sample = matcheo degradado a AZAR en prod
            // (indice vectorial ausente/caido). Debe verse como error, no warn.
            errorLogger.error(
                '[matching] ALARMA: vectorSearch caido, degradando a $sample',
                { message: (err as Error)?.message, name: (err as Error)?.name }
            );
        }
    }

    // Fallback: muestreo aleatorio (comportamiento previo, seguro a pequeña escala).
    const candidates = await BondRequest.aggregate([
        {
            $match: {
                _id: { $ne: new mongoose.Types.ObjectId(bondRequestId) },
                user: { $ne: new mongoose.Types.ObjectId(userId) },
                status: ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
                isPause: false,
                isLinked: { $ne: true },
                ...modalityFilter,
                ...geoFilter,
            },
        },
        { $sample: { size: 150 } },
        {
            $project: {
                _id: 1,
                user: 1,
                offer: 1,
                want: 1,
                offerVector: 1,
                wantVector: 1,
                location: 1,
                updatedAt: 1,
                modality: 1,
            },
        },
    ]);

    // Comodines como nexos: unir (deduplicado) también en el fallback aleatorio,
    // para que estén presentes aunque el $sample no los haya sorteado.
    const wildcards = await fetchWildcardCandidates(activeBaseFilter, geoFilter);
    const seen = new Set(candidates.map((c: any) => c._id.toString()));
    for (const w of wildcards) {
        const id = w._id.toString();
        if (id === bondRequestId.toString() || seen.has(id)) continue;
        seen.add(id);
        candidates.push(w);
    }

    return { candidates, method: 'sample' };
};

export default fetchMatchCandidates;
