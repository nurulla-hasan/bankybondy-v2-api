/* eslint-disable @typescript-eslint/no-explicit-any */
/* Serializador PÚBLICO de un BondRequest para las tarjetas de match.
 *
 * WHITELIST explícito: SOLO estos campos salen al cliente. Todo lo demás del
 * modelo —en especial la ubicación GPS (`location.coordinates`) y los flags
 * internos (isDeleted / isPause / isLinked / matchesComputedAt / *Vector)—
 * queda FUERA por defecto.
 *
 * Por qué así (y no un `.select('-location ...')` en el endpoint): con denylist,
 * agregar un campo nuevo al modelo lo expone por accidente, y basta olvidarse un
 * `-campo` en UN endpoint para filtrar PII. Eso fue exactamente la fuga de GPS de
 * `getMatchingBondRequest`: el `.select('-wantVector -offerVector')` no excluía
 * `location`, y el `{...request}` mandaba las coordenadas exactas de cada
 * contraparte. Con whitelist es IMPOSIBLE filtrar por olvido.
 *
 * Función PURA (sin DB) → testeable en runTests (ver bondRequest.publicShape.test.ts).
 */

// Subconjunto del usuario que la tarjeta muestra (estrella + identidad mínima).
const publicUser = (u: any): any => {
    // Aún sin poblar (ObjectId) o ausente: se devuelve tal cual, sin inventar shape.
    if (!u || typeof u !== 'object') return u;
    return {
        _id: u._id,
        name: u.name,
        profile_image: u.profile_image,
        reputation: u.reputation,
    };
};

// Devuelve SOLO lo que la tarjeta de match necesita: identidad, oferta, deseo y
// el usuario acotado. (Los colores del intercambio se agregan aparte, en el
// endpoint, porque se calculan por par y no viven en el BondRequest.)
export const publicMatchRequest = (raw: any): any => {
    if (!raw) return null;
    return {
        _id: raw._id,
        offer: raw.offer,
        want: raw.want,
        user: publicUser(raw.user),
    };
};
