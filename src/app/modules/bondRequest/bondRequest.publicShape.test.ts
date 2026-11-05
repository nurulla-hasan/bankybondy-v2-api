/* eslint-disable @typescript-eslint/no-explicit-any */
/* Pruebas puras del serializador público de match (sin DB).
 * Blindan la fuga de GPS: si alguien vuelve a exponer `location` (u otro campo
 * interno) en la tarjeta de match, estas aserciones fallan y el gate corta. */
import { publicMatchRequest } from './bondRequest.publicShape';

// BondRequest crudo "peligroso": trae GPS, flags internos, vectores y un user
// con datos de más (email, su propia location). NADA de esto debe salir.
const raw: any = {
    _id: 'req1',
    offer: 'Guitarra',
    want: 'Piano',
    location: { type: 'Point', coordinates: [-58.4173, -34.6118] }, // PII: GPS exacto
    isDeleted: false,
    isPause: false,
    isLinked: false,
    matchesComputedAt: new Date(0),
    status: 'WAITING_FOR_LINK',
    description: 'nota interna',
    offerVector: [0.1, 0.2],
    wantVector: [0.3, 0.4],
    user: {
        _id: 'u1',
        name: 'Ana',
        profile_image: 'ana.png',
        reputation: 4.6,
        email: 'ana@example.com', // no debe salir
        location: { type: 'Point', coordinates: [1, 2] }, // no debe salir
    },
};

const out: any = publicMatchRequest(raw);
const serialized = JSON.stringify(out);

type Case = [name: string, cond: boolean];

const cases: Case[] = [
    // — Lo que la tarjeta SÍ necesita se conserva —
    ['conserva _id/offer/want',
        out._id === 'req1' && out.offer === 'Guitarra' && out.want === 'Piano'],
    ['user conserva name/profile_image/reputation/_id',
        Object.keys(out.user).sort().join(',') === '_id,name,profile_image,reputation'],

    // — La PII y lo interno NO sale (el corazón del blindaje) —
    ['NO expone location (GPS) en el nivel del request', !('location' in out)],
    ['NO aparece "coordinates" en NINGÚN lado del payload',
        serialized.indexOf('coordinates') === -1],
    ['NO expone flags internos (isDeleted/isPause/isLinked/matchesComputedAt)',
        !('isDeleted' in out) && !('isPause' in out) &&
        !('isLinked' in out) && !('matchesComputedAt' in out)],
    ['NO expone los vectores del embedding',
        !('offerVector' in out) && !('wantVector' in out)],
    ['NO expone status/description internos',
        !('status' in out) && !('description' in out)],
    ['el user NO filtra email ni su propia location',
        !('email' in out.user) && !('location' in out.user)],

    // — Robustez ante entradas raras —
    ['input null → null sin throw', publicMatchRequest(null) === null],
    ['user sin poblar (ObjectId) pasa tal cual, sin romper',
        publicMatchRequest({ _id: 'r', offer: 'a', want: 'b', user: 'uid123' }).user === 'uid123'],
];

export const runPublicShapeTests = (): { pass: number; fail: number } => {
    let pass = 0,
        fail = 0;
    for (const [name, cond] of cases) {
        if (cond) pass++;
        else {
            fail++;
            // eslint-disable-next-line no-console
            console.error('FAIL:', name);
        }
    }
    return { pass, fail };
};
