/* Prueba pura del token de handshake del socket (B0).
 *
 * Lo que se prueba no es el JWT (eso lo firma `jsonwebtoken`), sino las CLAIMS:
 * que el socket reciba un `id` usable, que el `scope` sea siempre el mismo
 * string que mira `middlewares/auth.ts` para rechazar la API HTTP, y que el TTL
 * declarado coincida con el TTL firmado. Si esas dos piezas se separan, el
 * cliente refresca el token en el momento equivocado y el socket se cae en
 * silencio; si el `scope` se escribe a mano en un lado y en el otro no, el token
 * del chat vuelve a ser un access token normal.
 */
import {
    SOCKET_TOKEN_EXPIRES_IN,
    SOCKET_TOKEN_SCOPE,
    SOCKET_TOKEN_TTL_SECONDS,
    buildSocketTokenClaims,
} from './socketToken';

type Case = [name: string, cond: boolean];

const OID_LIKE = { toString: () => '64b00000000000000000000f' };

const cases: Case[] = [
    ['sesión completa → claims con las cuatro claves + scope',
        (() => {
            const c = buildSocketTokenClaims({
                id: '64a00000000000000000000a',
                profileId: '64b00000000000000000000b',
                email: 'a@b.c',
                role: 'user',
            });
            return (
                c !== null &&
                c.id === '64a00000000000000000000a' &&
                c.profileId === '64b00000000000000000000b' &&
                c.email === 'a@b.c' &&
                c.role === 'user' &&
                c.scope === 'socket'
            );
        })()],

    ['el id puede venir como ObjectId (se serializa, no se vuelve "[object Object]")',
        buildSocketTokenClaims({ id: OID_LIKE, profileId: OID_LIKE })?.id ===
            '64b00000000000000000000f'],

    ['sin id → null (el socket haría `User.findById(undefined)` = primer usuario)',
        buildSocketTokenClaims({ id: '', profileId: 'x' }) === null],
    ['sin profileId → null (misma razón que en auth.ts: sesión inservible)',
        buildSocketTokenClaims({ id: 'x', profileId: undefined }) === null],
    ['null/undefined → null, sin reventar',
        buildSocketTokenClaims(null) === null &&
            buildSocketTokenClaims(undefined) === null],

    ['el role NO se inventa: si la sesión no trae rol queda vacío',
        buildSocketTokenClaims({ id: 'x', profileId: 'y' })?.role === ''],

    ['el scope manda siempre el nuestro: un scope raro en la entrada se pisa',
        buildSocketTokenClaims({
            id: 'x',
            profileId: 'y',
            scope: 'http',
        } as any)?.scope === SOCKET_TOKEN_SCOPE],

    ['la claim que firma este helper es la MISMA que rechaza la API HTTP',
        buildSocketTokenClaims({ id: 'x', profileId: 'y' })?.scope ===
            SOCKET_TOKEN_SCOPE],

    ['TTL firmado y TTL declarado coinciden (el cliente programa el refresh con él)',
        SOCKET_TOKEN_EXPIRES_IN === '30m' &&
            SOCKET_TOKEN_TTL_SECONDS === 30 * 60 &&
            SOCKET_TOKEN_TTL_SECONDS === 1800],

    ['email/role faltantes no arruinan un token por lo demás válido',
        (() => {
            const c = buildSocketTokenClaims({ id: 'i', profileId: 'p' });
            return c !== null && c.email === '' && c.scope === 'socket';
        })()],
];

export const runSocketTokenTests = (): { pass: number; fail: number } => {
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
