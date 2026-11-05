/* Colores del matcheo (PURO, sin DB — testeable).
 *
 * Modelo: cada MATCH es un ciclo de pares "deseo ← oferta" (la oferta de una
 * persona satisface el deseo de la anterior). El color comunica el concepto de
 * cada caja:
 *
 * REGLA POR-PAR: las DOS puntas del mismo intercambio (mi oferta ↔ el deseo del
 * otro) comparten SIEMPRE el color. El vacío solo matchea con vacío o con
 * sorpresa (nunca con concreto).
 *
 *  - VACÍO ↔ SORPRESA → violeta. Comodín contra comodín: ninguno definió nada,
 *    hay que ponerse de acuerdo. Mismo color en las dos cajas del par.
 *  - VACÍO ↔ VACÍO → coral (regalo mutuo).
 *  - DOBLE SORPRESA (surprise ↔ surprise) → fucsia.
 *  - SORPRESA ↔ CONCRETO → pastel (no se alarma; del otro lado hay un ancla).
 *  - CONCRETO ↔ CONCRETO → pastel de paleta (una por posición del ciclo).
 *
 * Precedencia (specialEntryColor): vacío↔sorpresa (violeta) → vacío (coral) →
 * doble sorpresa (fucsia) → si no, pastel.
 */

// Paleta pastel para los pares concretos (una por posición del ciclo).
export const COLOR_PALETTE = [
    '#ea9999', // Rojo
    '#b6d7a8', // Verde
    '#9fc5e8', // Azul
    '#d5a6bd', // Violeta
    '#ffe599', // Amarillo
];

// Colores especiales de los comodines.
export const SPECIAL_COLORS = {
    surprise: '#FF6B9D', // fucsia — doble sorpresa (ambos lados surprise)
    empty: '#FF9B54', // coral — regalo (vacío ↔ vacío)
    emptySurprise: '#8B5CF6', // violeta — vacío ↔ sorpresa (per-par, mismo color en ambas puntas)
};

/** Normaliza un token a comparar (minúsculas, sin espacios/puntuación). */
const norm = (s?: string): string =>
    (s || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

/** ¿El token es el comodín 'empty' (regalo)? */
export const isEmptyToken = (t?: string): boolean => norm(t) === 'empty';

/** ¿El token es el comodín 'surprise'? */
export const isSurpriseToken = (t?: string): boolean => norm(t) === 'surprise';

/**
 * Color ESPECIAL de una caja según su token PROPIO y el del otro lado del par.
 * REGLA POR-PAR: las DOS puntas del mismo intercambio (mi oferta ↔ el deseo del
 * otro) devuelven SIEMPRE el mismo color. El vacío solo matchea con vacío o con
 * sorpresa (nunca con concreto), así que:
 *
 *  - vacío ↔ sorpresa  → violeta (per-par, ambas puntas). Comodín contra comodín.
 *  - vacío ↔ vacío      → coral (regalo mutuo).
 *  - sorpresa ↔ sorpresa → fucsia (doble sorpresa).
 *  - sorpresa ↔ concreto → null (pastel; no se alarma, del otro lado hay ancla).
 *  - concreto ↔ concreto → null (pastel de paleta).
 *
 * `own` es el token de ESTA caja; `counterpart` el del otro extremo del par.
 * Precedencia: primero el par vacío↔sorpresa (violeta), luego vacío (coral),
 * luego doble sorpresa (fucsia). Simétrico: specialEntryColor(a,b) y
 * specialEntryColor(b,a) dan el mismo color cuando forman un par especial.
 */
export const specialEntryColor = (
    own?: string,
    counterpart?: string
): string | null => {
    const ownEmpty = isEmptyToken(own);
    const ownSurprise = isSurpriseToken(own);
    const cpEmpty = isEmptyToken(counterpart);
    const cpSurprise = isSurpriseToken(counterpart);
    // vacío ↔ sorpresa → violeta (mismo color en las dos puntas del par).
    if ((ownEmpty && cpSurprise) || (ownSurprise && cpEmpty)) {
        return SPECIAL_COLORS.emptySurprise;
    }
    // vacío ↔ vacío → coral (el vacío solo aparea con vacío o sorpresa).
    if (ownEmpty) return SPECIAL_COLORS.empty;
    // sorpresa ↔ sorpresa → fucsia.
    if (ownSurprise && cpSurprise) return SPECIAL_COLORS.surprise;
    return null;
};

export default specialEntryColor;
