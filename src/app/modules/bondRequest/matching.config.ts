/* Configuración ajustable del matcheo de bonds.
 * Todos los pesos/umbrales se pueden overridear por variables de entorno.
 * Los pesos del puntaje final suman 1.0 por defecto. */

import { AGENDA } from './matching.schedule';

const num = (
    v: string | undefined,
    def: number,
    opts?: { min?: number; max?: number }
): number => {
    // Una env VACÍA o en blanco (`MATCH_MIN_SCORE=`) cuenta como ausente. Sin
    // esto Number('') da 0 —que es finito— y pisaba el default: el umbral
    // quedaba en 0 y TODO matcheaba con todo. Mismo riesgo en los pesos.
    const raw = typeof v === 'string' ? v.trim() : v;
    const n = raw === '' || raw === undefined ? NaN : Number(raw);
    let out = Number.isFinite(n) ? n : def;
    // Clamp de seguridad: un env mal tipado (p.ej. MATCH_MAX_CYCLE_SIZE=9999)
    // NO debe poder descapar el DFS / conjunto de candidatos. Los topes acotan
    // el peor caso de cómputo (grafo O(N²), explosión combinatoria de ciclos).
    if (opts) {
        if (opts.min !== undefined && out < opts.min) out = opts.min;
        if (opts.max !== undefined && out > opts.max) out = opts.max;
    }
    return out;
};

export const MATCHING = {
    // Gate duro: ambos sentidos deben superar esto para siquiera calificar.
    minScore: num(process.env.MATCH_MIN_SCORE, 0.4),

    // Cuánto pesa el "eslabón más débil" (min) vs el promedio en la calidad semántica.
    wMin: num(process.env.MATCH_W_MIN, 0.7),

    // Pesos del puntaje final (idealmente suman 1).
    weights: {
        sem: num(process.env.MATCH_W_SEM, 0.5),
        rep: num(process.env.MATCH_W_REP, 0.25),
        prox: num(process.env.MATCH_W_PROX, 0.15),
        // ⚠️ `fresh` ESTÁ NEUTRALIZADO EN LA PRÁCTICA, Y ESO ES DELIBERADO.
        //
        // `freshnessFactor` lee `updatedAt`, y nuestra propia contabilidad (el
        // sellado de cada recómputo) lo pisa todo el tiempo, así que en los
        // hechos vale ~1 para todos. Parece un accidente y en su origen lo fue;
        // la DECISIÓN de dejarlo así se tomó a conciencia el 11/9.
        //
        // NO lo "arregles" poniendo `timestamps: false` en el sellado del
        // cómputo. Eso despierta la frescura real (vida media 30 días) y, como
        // EDITAR UN VÍNCULO ESTÁ PROHIBIDO por producto, la persona no tendría
        // ninguna forma legítima de refrescarlo: un vínculo de 6 meses cae por
        // debajo de `minServeScore` y DESAPARECE de los resultados. Ver el
        // desarrollo completo, con los números, en matching.schedule.ts.
        //
        // Lo que corresponde es neutralizarlo EXPLÍCITAMENTE (poner este peso en 0
        // y repartir el 0.1 entre `sem` y `rep`), pero eso es tocar los pesos del
        // motor y se hace con datos reales, no antes de lanzar.
        fresh: num(process.env.MATCH_W_FRESH, 0.1),
    },

    // Reputación bayesiana.
    reputation: {
        prior: num(process.env.REP_PRIOR, 0.6), // valor neutro / cold-start
        priorWeight: num(process.env.REP_PRIOR_WEIGHT, 5), // pseudo-conteo
    },

    // Frescura: vida media (días) del decaimiento.
    freshnessHalfLifeDays: num(process.env.MATCH_FRESHNESS_HALFLIFE_DAYS, 30),

    // Búsqueda vectorial.
    // NOTA (perf): estos defaults se bajaron para abaratar el "cold compute"
    // (cuando el robot recomputa un bond). N más pequeño = menos candidatos y,
    // sobre todo, un grafo O(N²) de aristas mucho más barato. La CALIDAD/scoring
    // no cambia: solo se estrecha el fan-out de recuperación. Overrideable por env.
    vectorIndexName: process.env.MATCH_VECTOR_INDEX || 'bond_vector_index',
    candidateK: num(process.env.MATCH_CANDIDATE_K, 120, { min: 1, max: 500 }), // candidatos que se trabajan por dirección (antes 200)
    numCandidates: num(process.env.MATCH_NUM_CANDIDATES, 500, {
        min: 1,
        max: 2000,
    }), // amplitud del ANN (antes 1000)

    // Reintento del $vectorSearch ante fallas TRANSITORIAS (timeout de conexión,
    // elección de primario, blip de red) ANTES de degradar a $sample aleatorio.
    // Un tier dedicado (M10+) baja la FRECUENCIA de estos baches; el reintento
    // neutraliza el IMPACTO de los pocos que queden, para que un hipo momentáneo
    // nunca deje un bond con matcheo al azar. Ajustable por env; 0 = sin reintento
    // (comportamiento previo). El backoff crece linealmente por intento.
    vectorSearchRetries: num(process.env.MATCH_VECTOR_SEARCH_RETRIES, 1, {
        min: 0,
        max: 5,
    }),
    vectorSearchRetryDelayMs: num(
        process.env.MATCH_VECTOR_SEARCH_RETRY_DELAY_MS,
        150,
        { min: 0, max: 2000 }
    ),

    // Expansión de frontera (para no perder ciclos de 4–5 en la petición).
    // Traemos los "nodos del medio" de las cadenas dando 1 salto ANN desde
    // los vecinos directos, en ambas direcciones. Con 1 salto por dirección
    // se cubren de forma demostrable ciclos de hasta 5. Se conserva habilitada;
    // solo se recortan las semillas/candidatos para reducir el coste.
    frontierEnabled:
        (process.env.MATCH_FRONTIER_ENABLED ?? 'true').toLowerCase() !== 'false',
    frontierSeeds: num(process.env.MATCH_FRONTIER_SEEDS, 5, { min: 1, max: 20 }), // cuántos vecinos top se expanden por dirección (antes 12)
    frontierK: num(process.env.MATCH_FRONTIER_K, 10, { min: 1, max: 50 }), // vecinos que trae cada expansión (antes 20)
    frontierNumCandidates: num(process.env.MATCH_FRONTIER_NUM_CANDIDATES, 100, {
        min: 1,
        max: 2000,
    }), // antes 200

    // Preferencia SUAVE por cadenas más cortas (más fáciles de coordinar en el
    // mundo real). Se aplica en el SERVING como resta al ranking: por cada
    // integrante de más allá de 2, se descuenta `pairBias` del score de ranking
    // (size 2 = 0; size 3 = -pairBias; size 4 = -2·pairBias; ...). NO es un
    // dictador: un ciclo bastante mejor por cálculo igual puede ganarle a un par.
    // 0 = sin preferencia (score puro). Ajustable por env SIN recomputar (basta
    // reiniciar la API, porque se aplica al leer la cache). Único dial de tamaño.
    pairBias: num(process.env.MATCH_PAIR_BIAS, 0.05),

    // Interruptor de seguridad. 'false' (default) = ranking NUEVO: orden por
    // score, sin dictadores de tamaño ni de tipo, ciclo con la misma MEZCLA que
    // los pares (0.7·min + 0.3·promedio), y `pairBias` como preferencia suave.
    // 'true' = vuelve al ranking VIEJO (orden duro size→type→score, ciclo por min
    // pelado) para revertir al instante si algo se va de las manos. (El sort del
    // serving revierte con solo reiniciar; la mezcla del ciclo necesita recomputar.)
    legacyRanking:
        (process.env.MATCH_LEGACY_RANKING ?? 'false').toLowerCase() === 'true',

    // Ciclos.
    maxCycleSize: num(process.env.MATCH_MAX_CYCLE_SIZE, 5, { min: 2, max: 6 }),

    // Tope duro de resultados por bond: se guardan/sirven SOLO los N mejores por
    // finalScore. Nunca más de esto (evita miles de cadenas redundantes).
    maxResults: num(process.env.MATCH_MAX_RESULTS, 100, { min: 1, max: 500 }),
    // Umbral de SERVICIO sobre el score FINAL compuesto (no el gate por-arista
    // `minScore`). Al servir por `bonds` se junta el superset de cadenas que el
    // bond originó Y las que originaron otros bonds donde participa → hay que
    // re-topear al SERVIR: se devuelven SOLO las `maxResults` (100) mejores cuyo
    // score final supere esto. Sin este tope el front paginaba el superset entero
    // (40+ páginas). Ajustable por env sin recomputar (se aplica al leer la cache).
    minServeScore: num(process.env.MATCH_MIN_SERVE_SCORE, 0.4, { min: 0, max: 1 }),
    // Beam de exploración: en cada nodo del DFS solo se extiende por las K aristas
    // más fuertes (el cierre del ciclo se evalúa aparte, sin límite). Acota la
    // explosión combinatoria manteniendo los ciclos de mayor puntaje.
    cycleBeamK: num(process.env.MATCH_CYCLE_BEAM_K, 8, { min: 1, max: 20 }),
    // Presupuesto duro de ciclos emitidos antes de cortar el DFS (red de seguridad).
    cycleBudget: num(process.env.MATCH_CYCLE_BUDGET, 4000, {
        min: 1,
        max: 20000,
    }),

    // Tope de fan-out de la invalidación (matching.robot.ts): máximo de
    // sourceBonds afectados que se reencolan de golpe al editar/pausar/borrar un
    // bond. El resto se difiere al sweep. Evita avalanchas de recomputos O(N²).
    invalidationFanout: num(process.env.MATCH_MAX_INVALIDATION_FANOUT, 200, {
        min: 1,
        max: 2000,
    }),

    // `lockDuration` del Worker BullMQ (ms); el porqué del valor, en
    // matching.robot.ts. Acotado: con un env negativo el worker no tomaba NINGÚN
    // job (Redis rechaza el vencimiento), y uno de pocos segundos stallearía
    // cómputos normales.
    lockDurationMs: num(process.env.MATCH_LOCK_DURATION_MS, 120000, {
        min: 30000,
        max: 600000,
    }),

    // Caché de matches precomputados (BondMatch): minutos de validez de un
    // cómputo "al vuelo" antes de recomputar. El robot (paso 5) lo mantiene fresco.
    // Es el umbral de "¿conviene REFRESCAR?", NO el de "¿se puede mostrar?".
    cacheTtlMinutes: num(process.env.MATCH_CACHE_TTL_MINUTES, 60),

    // Umbral de "¿todavía vale la pena MOSTRAR esta caché?", separado del de
    // arriba a propósito (ver el comentario largo en getMatchingBondRequest).
    //
    // Mientras fueron el mismo número, una caché de 61 minutos hacía que el
    // usuario viera un spinner y CERO coincidencias teniendo sus matches
    // guardados. Con el TTL adaptativo —vínculos fríos cada 24 h— ese bug habría
    // pasado de molesto a permanente.
    //
    // El default (48 h) es holgado a propósito: cubre con margen el TTL más frío
    // (24 h) para que un vínculo apenas atrasado nunca caiga en pantalla vacía.
    // Mostrar coincidencias de ayer mientras se refrescan es honesto; mostrar un
    // spinner teniéndolas, no.
    //
    // EL MÍNIMO SE ATA AL TTL MÁS FRÍO, NO AL DE REFRESCO (panel del 11/9). Una
    // versión anterior decía en prosa que 48 h "cubre con margen las 24 h" pero
    // clampeaba contra `MATCH_CACHE_TTL_MINUTES` (60). Con
    // `MATCH_TTL_COLD_MINUTES=10080` (7 días, que el clamp de la agenda permite)
    // un vínculo frío pasaba una semana sin recomputarse y su caché dejaba de ser
    // servible a las 48 h → volvía exactamente la pantalla vacía con spinner que
    // esto vino a cerrar. La invariante estaba escrita en el comentario y no en el
    // código; ahora está en el código, que es la única forma de que sea cierta.
    serveTtlMinutes: num(process.env.MATCH_SERVE_TTL_MINUTES, 48 * 60, {
        min: Math.max(
            num(process.env.MATCH_CACHE_TTL_MINUTES, 60),
            AGENDA.ttlFrioMin
        ),
        max: 30 * 24 * 60,
    }),

    // Cross-modalidad: online y presencial PUEDEN matchear entre sí, pero con una
    // penalización de score (preferencia suave, NO filtro duro). Así un vínculo
    // inverso creado desde un perfil siempre evalúa aunque los formatos difieran, y
    // nunca se excluye a nadie por modalidad. Reversible por env (poner en 'false'
    // vuelve al filtro duro online↔online / presencial↔presencial).
    crossModality:
        (process.env.MATCH_CROSS_MODALITY ?? 'true').toLowerCase() !== 'false',
    // Factor multiplicativo cuando AMBOS formatos son explícitos y DIFIEREN. Si a
    // alguno le falta la modalidad (datos legado), no se penaliza (factor 1).
    modalityMismatchFactor: num(process.env.MATCH_MODALITY_MISMATCH_FACTOR, 0.85, {
        min: 0,
        max: 1,
    }),

    // Comodín "surprise" (aplica SIMÉTRICO: el deseo O la oferta es comodín).
    // Modelo de TRES niveles (ver surpriseAdjustedScore):
    //   - comodín ↔ comodín  = surpriseFloor (0.45): pasa el gate (0.4) pero es el
    //     valor más bajo → la doble sorpresa (nadie definió nada) rankea al fondo.
    //   - comodín ↔ concreto = surpriseFloor + surpriseMargin (0.55): el comodín
    //     LLENA una necesidad concreta → vale más que otro comodín.
    //   - concreto ↔ concreto = similitud real (un match fuerte le gana a todo).
    // `surpriseMargin` es el BONUS por llenar un concreto (ya NO multiplica sim).
    // Reversible/ajustable por env sin deploy.
    surpriseFloor: num(process.env.MATCH_SURPRISE_FLOOR, 0.45, { min: 0, max: 1 }),
    surpriseMargin: num(process.env.MATCH_SURPRISE_MARGIN, 0.1, { min: 0, max: 1 }),

    // Comodín 'vacío' (nada). Ver Matcheo-Comodines-Spec-2026-08.md §4/§8.
    // "Ofrecer vacío" = dar nada, así que satisface distinto según qué te pidan:
    //   - vacío(deseo) ← vacío(oferta) = emptyEncounter (ALTO): el "encuentro" —
    //     dos que no ofrecen ni piden nada y se calzan perfecto (la app de citas).
    //   - vacío ↔ sorpresa = emptyMixed (piso del gate): matchea pero FLOJO —
    //     alguien recibe nada teniendo un deseo abierto.
    //   - vacío ↔ concreto = 0 (EXCLUIDO, estructural): "nada por algo puntual" no
    //     es trueque; la arista queda en 0 y el par/eslabón lo filtra `passesGate`.
    // emptyMixed decide la INCLUSIÓN: >= minScore (0.4) → esos matches existen (flojos);
    // < minScore → no se arman (lista más limpia, pero se pierde visibilidad cruzada).
    emptyEncounter: num(process.env.MATCH_EMPTY_ENCOUNTER, 0.9, { min: 0, max: 1 }),
    emptyMixed: num(process.env.MATCH_EMPTY_MIXED, 0.4, { min: 0, max: 1 }),

    // Comodines como NEXOS de cadena. Los bonds cuyo deseo u oferta es 'surprise'
    // o 'empty' tienen vectores SIN señal semántica, así que la búsqueda vectorial
    // NO los recupera cuando están "en el medio" de una cadena → se perdían como
    // nexos. Se los trae SIEMPRE al conjunto de candidatos con una consulta directa
    // (no vectorial), ACOTADA. Es puramente ADITIVO: suma candidatos, nunca quita
    // ni cambia el scoring/gating. Reversible por env.
    includeWildcards:
        (process.env.MATCH_INCLUDE_WILDCARDS ?? 'true').toLowerCase() !== 'false',
    // Tope de comodines agregados por cómputo (acota el crecimiento del grafo O(N²)).
    wildcardCap: num(process.env.MATCH_WILDCARD_CAP, 100, { min: 1, max: 1000 }),
};

export default MATCHING;
