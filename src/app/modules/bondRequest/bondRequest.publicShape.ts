/* eslint-disable @typescript-eslint/no-explicit-any */
/* Public serializer for BondRequest match cards.
 *
 * Explicit WHITELIST: only these fields reach the client. Everything else —
 * notably GPS (`location.coordinates`) and internal flags (*Vector, isLinked,
 * matchesComputedAt...) — stays out by default.
 *
 * A denylist `.select('-location ...')` leaked exact GPS in
 * `getMatchingBondRequest`; with a whitelist, forgetting a field cannot leak PII.
 * Pure function (no DB), testable in runTests.
 */

// User subset the card shows (star rating + minimal identity).
const publicUser = (u: any): any => {
    // Still unpopulated (ObjectId) or absent: return as-is, don't invent a shape.
    if (!u || typeof u !== 'object') return u;
    return {
        _id: u._id,
        name: u.name,
        profile_image: u.profile_image,
        reputation: u.reputation,
    };
};

// Only what the match card needs: identity, offer, want and the narrow user.
// (Swap colors are added by the endpoint; they are per-pair, not stored here.)
export const publicMatchRequest = (raw: any): any => {
    if (!raw) return null;
    return {
        _id: raw._id,
        offer: raw.offer,
        want: raw.want,
        user: publicUser(raw.user),
    };
};
