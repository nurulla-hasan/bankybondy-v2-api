/* Semántica PURA de la "escucha calificada" (Etapa 0), sin DB → testeable.
 *
 * El corazón hueco del #2 era que `totalPlay` nunca subía y "más escuchados"
 * ordenaba por un campo siempre en 0. Acá definimos qué cuenta como una escucha
 * REAL (no una impresión ni un replay), para que el trending refleje la verdad.
 *
 * Criterio (mismo espíritu con el que Spotify redefinió "play" para no inflar):
 * una escucha cuenta si el oyente pasó **≥30s O ≥40%** de la pista (lo que ocurra
 * primero) — así vale tanto un audio corto escuchado entero como uno largo del que
 * se escuchó un rato. La deduplicación por (audio, oyente, día) y el conteo solo de
 * usuarios autenticados (no del dueño) viven en el servicio.
 */
export const LISTEN_MIN_SECONDS = 30;
export const LISTEN_MIN_COMPLETION = 0.4; // 40%

export const isQualifiedListen = (input: {
    secondsListened?: unknown;
    completion?: unknown;
}): boolean => {
    const secs = Number(input?.secondsListened);
    const comp = Number(input?.completion);
    const okSecs = Number.isFinite(secs) && secs >= LISTEN_MIN_SECONDS;
    // completion es una fracción 0..1; un valor >1 es basura y no califica por sí
    // solo (defensa en profundidad, además del clamp del endpoint).
    const okComp =
        Number.isFinite(comp) && comp >= LISTEN_MIN_COMPLETION && comp <= 1;
    return okSecs || okComp;
};

// Clave de deduplicación diaria (UTC): 1 escucha calificada por (audio, oyente,
// día). Un índice único sobre esta clave hace idempotente el conteo (el 2º intento
// del mismo día no vuelve a sumar).
export const dayBucketFor = (date: Date): string =>
    date.toISOString().slice(0, 10); // 'YYYY-MM-DD'
