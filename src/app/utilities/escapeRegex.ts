/**
 * Escapa los metacaracteres de una regex para poder usar un string del usuario
 * como literal en `$regex` sin ReDoS ni inyección de patrón. Devuelve '' si la
 * entrada es null/undefined.
 */
export const escapeRegex = (s?: unknown): string =>
    String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
