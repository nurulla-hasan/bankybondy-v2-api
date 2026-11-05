/* Clamp de paginación (frontera única).
 *
 * El cliente controla `?page` y `?limit`. Sin tope, `?limit=9999999` fuerza a Mongo
 * a traer/serializar una respuesta enorme (DoS barato), y un limit NaN/negativo
 * ensucia el cálculo de páginas. Estas funciones PURAS acotan SIEMPRE a enteros
 * sanos, en un solo lugar reutilizable (así ningún endpoint queda sin tope por
 * olvido, y la metadata de paginación no puede desincronizarse de la consulta).
 *
 * `max` por defecto = 500 (igual que QueryBuilder): corta lo absurdo sin truncar
 * ningún pedido legítimo (nadie pide de a >500 en una página real).
 */
// OJO con el infinito: `Number('1e999')` es `Infinity`, y la versión anterior
// (`Math.max(1, Math.floor(Number(raw) || 1))`) lo dejaba pasar tal cual → el
// `$skip: Infinity` lo rechaza Mongo → 500. Era el mismo 500 por `?page` que este
// helper venía a cerrar, entrando por otra puerta. Cualquier valor no finito se
// trata como "no me mandaste página": 1.
export const clampPage = (raw: unknown): number => {
    const n = Math.floor(Number(raw));
    return Number.isFinite(n) && n >= 1 ? n : 1;
};

export const clampLimit = (
    raw: unknown,
    fallback = 10,
    max = 500
): number => {
    const n = Math.floor(Number(raw) || fallback);
    return Math.min(Math.max(1, n), max);
};
