/* Match colors (pure, no DB). Per-pair invariant: both ends of one swap (my offer
 * ↔ their want) share a color; empty pairs only with empty or surprise. */

// Pastel palette for concrete pairs (one per cycle position).
export const COLOR_PALETTE = [
    '#ea9999', // red
    '#b6d7a8', // green
    '#9fc5e8', // blue
    '#d5a6bd', // violet
    '#ffe599', // yellow
];

// Special wildcard colors.
export const SPECIAL_COLORS = {
    surprise: '#FF6B9D', // fuchsia — double surprise (both sides surprise)
    empty: '#FF9B54', // coral — gift (empty ↔ empty)
    emptySurprise: '#8B5CF6', // violet — empty ↔ surprise (same on both ends)
};

/** Normalizes a token for comparison (lowercase, no spaces/punctuation). */
const norm = (s?: string): string =>
    (s || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

/** Is the token the 'empty' wildcard (gift)? */
export const isEmptyToken = (t?: string): boolean => norm(t) === 'empty';

/** Is the token the 'surprise' wildcard? */
export const isSurpriseToken = (t?: string): boolean => norm(t) === 'surprise';

/**
 * Special color for a box from its OWN token and the counterpart's (symmetric).
 * Precedence: empty↔surprise (violet), empty (coral), surprise↔surprise (fuchsia),
 * else null for the palette.
 */
export const specialEntryColor = (
    own?: string,
    counterpart?: string
): string | null => {
    const ownEmpty = isEmptyToken(own);
    const ownSurprise = isSurpriseToken(own);
    const cpEmpty = isEmptyToken(counterpart);
    const cpSurprise = isSurpriseToken(counterpart);
    // empty ↔ surprise → violet (same color at both ends of the pair).
    if ((ownEmpty && cpSurprise) || (ownSurprise && cpEmpty)) {
        return SPECIAL_COLORS.emptySurprise;
    }
    // empty ↔ empty → coral (empty only pairs with empty or surprise).
    if (ownEmpty) return SPECIAL_COLORS.empty;
    // surprise ↔ surprise → fuchsia.
    if (ownSurprise && cpSurprise) return SPECIAL_COLORS.surprise;
    return null;
};

export default specialEntryColor;
