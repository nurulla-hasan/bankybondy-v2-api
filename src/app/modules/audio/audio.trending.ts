/* Ranking honesto de "trending" (E1) — función PURA, sin DB → testeable y ajustable.
 *
 * "Trending" = lo que está SUBIENDO (distinto de "más escuchados" = totalPlay crudo).
 *
 *   score = ( escuchas × completion_promedio  +  PESO_GUARDADO × guardados ) × frescura
 *
 * - escuchas × completion: cuánta gente lo escuchó DE VERDAD (E0 ya deduplica por
 *   día y descarta el seek). Un audio con muchos plays pero 20% de completion vale
 *   menos que uno con menos plays pero 90%. Imposible ganar apretando play.
 * - guardados (bookmarks): señal COSTOSA — alguien lo escuchó Y se molestó en
 *   guardarlo. Pesa más que una escucha.
 * - frescura: decae con la edad → oxigena lo nuevo (cold-start liviano; estilo
 *   Hacker News). Lo viejo cae del trending aunque tenga muchas escuchas (para eso
 *   está "más escuchados").
 *
 * Las CALIFICACIONES NO entran en el trending: premia ESCUCHAR y GUARDAR, no opinar
 * (las estrellas son fáciles de brigadear y son otra cosa — calidad/opinión).
 *
 * Los pesos son constantes AJUSTABLES: se afinan con datos reales sin tocar la forma.
 */
export const TRENDING_BOOKMARK_WEIGHT = 5;
export const TRENDING_FRESHNESS_OFFSET_HOURS = 24;
export const TRENDING_FRESHNESS_GRAVITY = 1.2;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export interface TrendingSignals {
    listens?: number; // escuchas calificadas únicas (deduped, de E0)
    avgCompletion?: number; // 0..1, promedio de cuánto se escuchó
    bookmarks?: number; // guardados (bookmarks)
    ageHours?: number; // edad del audio en horas
}

export const computeTrendingScore = (s: TrendingSignals): number => {
    const listens = Math.max(0, Number(s?.listens) || 0);
    const comp = clamp01(Number(s?.avgCompletion) || 0);
    const bookmarks = Math.max(0, Number(s?.bookmarks) || 0);
    const ageHours = Math.max(0, Number(s?.ageHours) || 0);

    const engagement = listens * comp + TRENDING_BOOKMARK_WEIGHT * bookmarks;
    const freshness =
        1 /
        Math.pow(
            ageHours + TRENDING_FRESHNESS_OFFSET_HOURS,
            TRENDING_FRESHNESS_GRAVITY
        );
    return engagement * freshness;
};
