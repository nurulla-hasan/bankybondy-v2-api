/* AGENDA del recómputo: CUÁNDO se vuelve a calcular un vínculo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ EXISTE (el techo de 800 usuarios)
 *
 * Hasta acá el sweep usaba un TTL UNIFORME: `MATCHING.cacheTtlMinutes` (60 min)
 * para todos. O sea que un vínculo parado hace tres semanas, que nadie mira, se
 * recalculaba cada hora igual que uno recién creado. Con lote 200 cada 5 minutos
 * eso da 2.400 recomputos/hora, y como cada vínculo activo necesita uno por hora,
 * el sistema techa en ~2.400 vínculos ≈ 800 usuarios. Más arriba, la caché
 * envejece más rápido de lo que el sweep la puede refrescar y no se recupera.
 *
 * Con 50.000 usuarios (~100.000 vínculos activos) el TTL uniforme pediría 100.000
 * recomputos/hora: 42× lo de hoy. Inviable.
 *
 * LA OBSERVACIÓN: el problema es el TTL uniforme, no el volumen. La mayoría de
 * los vínculos están fríos. Con tres niveles la misma cobertura cuesta ~16.200
 * recomputos/hora (7× lo de hoy), que sí es alcanzable.
 *
 *   caliente ~10%  × 24/día = 240.000/día
 *   tibio    ~20%  ×  4/día =  80.000/día
 *   frío     ~70%  ×  1/día =  70.000/día
 *                             ─────────────
 *                             390.000/día ≈ 16.200/hora
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESTO NO TOCA EL MOTOR: no cambia scoring, pesos, gates, ciclos ni ranking.
 * Cambia CUÁNDO se recalcula, no CÓMO.
 *
 * ⚠️ PERO NO ES DEL TODO NEUTRO, Y ACÁ ESTÁ LA LETRA CHICA. Una versión anterior
 * de este comentario decía que "un vínculo frío que se recalcula cada 24 h produce
 * EXACTAMENTE el mismo resultado que uno caliente". **Es falso**, y lo probó el
 * panel de refutadores. La cadena es indirecta pero real:
 *
 *   1. `computeAndCacheMatches` sella `matchesComputedAt` con un `updateOne`;
 *   2. el schema tiene `timestamps: true`, así que ese sellado mueve `updatedAt`;
 *   3. `updatedAt` es la entrada de `freshnessFactor` (matching.compute → scoring),
 *      que pesa 0.1 del puntaje final.
 *
 * O sea que la CADENCIA se filtra al puntaje: un vínculo resellado cada hora tiene
 * `fresh = 0.99904` y uno resellado cada 24 h tiene `0.97716`. La diferencia en el
 * score final es **~0.0022** a favor del caliente, en la lista de todos los demás.
 *
 * POR QUÉ NO SE "ARREGLA" ACÁ. La solución obvia —`timestamps: false` en el
 * sellado— haría que `updatedAt` volviera a significar "último cambio real del
 * vínculo", y entonces `freshnessFactor` mediría la EDAD REAL con vida media de 30
 * días: un vínculo de dos meses pasaría a `fresh = 0.25`, o sea ~0.025 de score.
 * **Eso mueve el ranking diez veces más que el defecto que arregla.** Hoy la
 * frescura está anestesiada por accidente (todo se resella seguido), no por
 * diseño, y despertarla es una decisión de producto sobre el motor, no una
 * corrección de contabilidad.
 *
 * DECIDIDO (Emilio, 11/9): SE DEJA ASÍ. Y el motivo NO es "es más chico", es que
 * la frescura real sería ACTIVAMENTE MALA para este producto. La razón está en el
 * propio repo:
 *
 *   · **Editar un vínculo está PROHIBIDO** por regla de producto (sólo se puede
 *     pausar/reanudar, ver `updateBondRequestIntoDB`). Así que si la frescura
 *     decayera por edad real, **no habría NINGUNA forma legítima de refrescar un
 *     vínculo que se hunde**: sólo pausar y despausar —un toggle vacío que se
 *     volvería un truco de ranking— o borrar y recrear, perdiendo historial y
 *     reseña.
 *   · No es "bajar en la lista", es DESAPARECER. Con vida media de 30 días y peso
 *     0.1 sobre una suma ponderada con `minServeScore` en 0.4, un match real que
 *     puntúa 0.45 cae por debajo del umbral a los pocos meses y deja de servirse.
 *     A los 90 días el castigo es −0.09; a los 180, −0.098.
 *   · Y contradice dos decisiones de producto explícitas: que un vínculo **sigue
 *     corriendo después de un trueque concretado, porque probablemente quieras
 *     repetirlo** (o sea: un vínculo viejo VALE), y el guardarraíl de optimizar
 *     que el usuario logre lo que vino a buscar. La persona que ofrece lo mismo
 *     hace ocho meses sin encontrar a nadie es exactamente para quien existe el
 *     producto, y la frescura la iría borrando sin que pueda hacer nada.
 *
 * Un "ofrezco clases de guitarra" no se pone rancio. La frescura tiene sentido en
 * un marketplace de publicaciones puntuales; acá las ofertas son permanentes, y
 * el componente parece traído de ese otro mundo.
 *
 * ⚠️ PENDIENTE PARA LA PRÓXIMA TANDA, no para el lanzamiento: hoy la frescura
 * queda neutralizada **por accidente** (nuestra contabilidad le pisa el
 * `updatedAt`), y lo correcto es neutralizarla **a propósito** — `MATCH_W_FRESH=0`
 * repartiendo ese 0.1 entre semántica y reputación. Es un cambio de PESOS, o sea
 * el motor, y no se toca a días de lanzar ni sin datos reales para medirlo.
 *
 * Lo que SÍ se cerró es el camino directo y explotable: sellar `lastServedAt` va
 * con `timestamps: false`, así que tener la pantalla abierta ya no sube el
 * ranking propio; y la invalidación también, así que editar un vínculo popular ya
 * no resetea la frescura de miles.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * QUÉ SEÑAL DE TEMPERATURA SE USA, Y POR QUÉ NO `updatedAt`
 *
 * `updatedAt` parece la señal obvia y NO SIRVE: el schema tiene
 * `timestamps: true`, así que nuestra propia contabilidad lo pisa. Cada vez que
 * `computeAndCacheMatches` sella `matchesComputedAt`, o que `invalidateAndRefresh`
 * hace `$unset`, el `updatedAt` salta. O sea que TODO vínculo que el sweep toca
 * aparece "recién actualizado": la señal mide nuestro propio trabajo, no el
 * interés del usuario. Se descartó por eso.
 *
 * Las dos que sí sirven:
 *   - `createdAt`  — nunca cambia. Un vínculo nuevo merece atención.
 *   - `lastServedAt` — lo sella el serving cuando el DUEÑO abre la pantalla de
 *     coincidencias de ese vínculo. Es la señal honesta de interés real.
 *
 * Se toma la MÁS RECIENTE de las dos: un vínculo viejo que alguien acaba de mirar
 * está caliente, y uno recién creado que nadie miró todavía también.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FUNCIÓN PURA a propósito: sin DB, sin red, sin `Date.now()` adentro (el `ahora`
 * entra por parámetro). Así entra en `scripts/runTests.js` como el resto del
 * motor, y la política de escala queda blindada por tests igual que el scoring.
 */

/** Los tres niveles de atención. */
export type TemperaturaVinculo = 'caliente' | 'tibio' | 'frio';

/** AGENDA VENCIDA: "a este hay que recomputarlo YA".
 *
 * Es un valor centinela (la época Unix), no la ausencia del campo, y la
 * diferencia es de rendimiento, no de estilo.
 *
 * La primera versión usaba `$exists: false` para "nunca agendado". Eso obliga al
 * sweep a consultar con `$or: [{$exists:false}, {$lte: ahora}]`, y un `$or` sobre
 * la clave de orden le impide al índice proveer el `sort` → Mongo mete un SORT
 * BLOQUEANTE, que tiene un tope duro de 32 MB sin `allowDiskUse`. Y estos
 * documentos son GORDOS: `offerVector` + `wantVector` son 2 × 1536 doubles ≈
 * **40 KB cada uno** (BSON guarda como texto la clave de cada uno de los 1536
 * elementos; medido el 29/9). Con el lote viejo de 200 eran 8 MB y entraba; con
 * el lote nuevo de 1.500 son ~60 MB y **no entra**.
 *
 * El modo de falla era el más caro posible: el sweep tira `Sort exceeded memory
 * limit`, lo come el `catch`, devuelve 0, y NADIE SE RECOMPUTA NUNCA MÁS — en
 * silencio, hasta que alguien lea los logs.
 *
 * Con el centinela el campo está SIEMPRE presente, el filtro es un rango puro
 * (`$lte`) y el índice compuesto provee filtro Y orden de una. No hay sort
 * bloqueante que pueda desbordar, con ningún lote.
 */
// `Object.freeze` sobre un Date NO impide `setTime`, así que la inmutabilidad de
// verdad la da devolver una instancia NUEVA. Se exporta como getter para que
// nadie pueda mutar un Date compartido que se asigna a documentos y viaja en
// filtros de update en varios lugares: una sola llamada a `.setTime()` en
// cualquier parte del árbol movería la agenda de todo el sistema.
const EPOCA_MS = 0;
export const agendaVencida = (): Date => new Date(EPOCA_MS);

const MINUTO_MS = 60 * 1000;
const HORA_MS = 60 * MINUTO_MS;

/** Lee un número de env con default y clamp (mismo criterio que matching.config:
 *  una env VACÍA cuenta como ausente, y los topes acotan el peor caso). */
const num = (
    v: string | undefined,
    def: number,
    opts: { min: number; max: number }
): number => {
    const raw = typeof v === 'string' ? v.trim() : v;
    const n = raw === '' || raw === undefined ? NaN : Number(raw);
    let out = Number.isFinite(n) ? n : def;
    if (out < opts.min) out = opts.min;
    if (out > opts.max) out = opts.max;
    return out;
};

/** Diales de la agenda. Todos overrideables por env SIN tocar código.
 *  Los mínimos NO son cosméticos: un TTL de 0 volvería a poner el sweep en
 *  recómputo continuo, que es exactamente el "cómputo desbocado" que ya frenó la
 *  API una vez (ver el comentario de matching.sweep.ts). */
const ventanaCalienteHoras = num(process.env.MATCH_HOT_WINDOW_HOURS, 72, {
    min: 1,
    max: 24 * 30,
});

export const AGENDA = {
    // Ventana de "caliente": creado o mirado dentro de estas horas.
    ventanaCalienteHoras,
    // Ventana de "tibio": creado o mirado dentro de estas horas (14 días).
    // El `Math.max` NO es cosmético: si alguien exportara una ventana tibia MENOR
    // que la caliente, el nivel 'tibio' se volvería inalcanzable y todo caería en
    // caliente o frío, sin ningún error visible. Se fuerza el orden acá, en el
    // único lugar donde se puede, en vez de confiar en que nadie se equivoque.
    ventanaTibiaHoras: Math.max(
        ventanaCalienteHoras,
        num(process.env.MATCH_WARM_WINDOW_HOURS, 24 * 14, {
            min: 1,
            max: 24 * 365,
        })
    ),
    // TTL por nivel, en minutos.
    ttlCalienteMin: num(process.env.MATCH_TTL_HOT_MINUTES, 60, {
        min: 5,
        max: 24 * 60,
    }),
    ttlTibioMin: num(process.env.MATCH_TTL_WARM_MINUTES, 360, {
        min: 5,
        max: 24 * 60,
    }),
    ttlFrioMin: num(process.env.MATCH_TTL_COLD_MINUTES, 1440, {
        min: 5,
        max: 24 * 7 * 60,
    }),
};

/** Entrada mínima para decidir la temperatura. Todo opcional salvo `ahora`:
 *  un vínculo legado sin `createdAt` legible NO debe romper el sweep. */
export type EntradaTemperatura = {
    ahora: number;
    createdAt?: Date | string | number | null;
    lastServedAt?: Date | string | number | null;
};

/** Convierte a milisegundos o devuelve null si no es una fecha usable.
 *  `new Date(undefined)` da Invalid Date y `getTime()` da NaN: si eso se filtrara,
 *  toda comparación daría false y el vínculo caería en 'frio' por accidente. */
const aMs = (v: Date | string | number | null | undefined): number | null => {
    if (v === null || v === undefined) return null;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
};

/** Temperatura de un vínculo: la señal es la MÁS RECIENTE entre creación y
 *  última vez servido. Sin ninguna señal usable → 'frio' (conservador: el sweep
 *  igual lo va a tomar, sólo que más espaciado). */
export const temperaturaDe = (
    e: EntradaTemperatura,
    dials = AGENDA
): TemperaturaVinculo => {
    const creado = aMs(e.createdAt);
    const servido = aMs(e.lastServedAt);

    // Sin ninguna señal: frío. No es "nunca calculado" —de eso se encarga el
    // `$exists: false` de matchesNextAt en el sweep, que lo hace elegible YA—,
    // es sólo con qué cadencia se lo refresca de acá en adelante.
    if (creado === null && servido === null) return 'frio';

    const masReciente = Math.max(creado ?? -Infinity, servido ?? -Infinity);
    const antiguedadHoras = (e.ahora - masReciente) / HORA_MS;

    // Una señal en el FUTURO (reloj torcido, dato sembrado) da antigüedad
    // negativa: cuenta como caliente, que es el lado seguro (se refresca más, no
    // menos). Se deja explícito para que no parezca un descuido.
    if (antiguedadHoras <= dials.ventanaCalienteHoras) return 'caliente';
    if (antiguedadHoras <= dials.ventanaTibiaHoras) return 'tibio';
    return 'frio';
};

/** Minutos de TTL para una temperatura dada. */
export const ttlMinutosDe = (
    t: TemperaturaVinculo,
    dials = AGENDA
): number => {
    if (t === 'caliente') return dials.ttlCalienteMin;
    if (t === 'tibio') return dials.ttlTibioMin;
    return dials.ttlFrioMin;
};

/** CUÁNDO le toca el próximo recómputo a este vínculo.
 *
 *  Se guarda la AGENDA (el instante futuro), no la historia. Así el sweep es una
 *  sola consulta —`matchesNextAt <= ahora`— resuelta por un solo índice, en vez
 *  de una consulta por nivel con un `$or` de rangos distintos. La política vive
 *  acá, en un solo lugar y del lado de la ESCRITURA, que es donde ya sabemos
 *  todo sobre el vínculo. */
export const proximoRecomputoEn = (
    e: EntradaTemperatura,
    dials = AGENDA
): Date => {
    const ttlMin = ttlMinutosDe(temperaturaDe(e, dials), dials);
    return new Date(e.ahora + ttlMin * MINUTO_MS);
};

export default AGENDA;
