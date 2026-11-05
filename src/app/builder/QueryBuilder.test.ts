/* Test del QueryBuilder (puro, sin DB).
 *
 * POR QUÉ EXISTE: `sort()` y `fields()` los usan ~21 y ~19 endpoints MONTADOS.
 * Un bug ahí no rompe una pantalla: rompe veinte. Y los dos tenían el mismo
 * defecto —castear a `string` un valor de query que Express entrega como ARRAY
 * cuando la clave se repite (`?sort=a&sort=b`)—, que tiraba TypeError → 500.
 *
 * Se testea con un `modelQuery` FALSO que sólo registra con qué lo llamaron. No
 * hace falta mongoose ni base: el builder es una cadena de llamadas.
 */
import QueryBuilder from './QueryBuilder';

type Case = [name: string, cond: boolean];

/** Doble del `Query` de mongoose: encadena y anota lo recibido. */
const fakeModelQuery = () => {
    const visto: {
        sort?: unknown;
        select?: unknown;
        skip?: number;
        limit?: number;
    } = {};
    const self: Record<string, unknown> = {
        sort: (arg: unknown) => {
            visto.sort = arg;
            return self;
        },
        select: (arg: unknown) => {
            visto.select = arg;
            return self;
        },
        skip: (n: number) => {
            visto.skip = n;
            return self;
        },
        limit: (n: number) => {
            visto.limit = n;
            return self;
        },
        find: () => self,
    };
    return { self, visto };
};

/** Corre un método del builder con una query dada y devuelve lo que recibió el
 *  modelQuery. Si el método TIRA, se marca — porque tirar es el bug. */
const correr = (
    metodo: 'sort' | 'fields' | 'paginate',
    query: Record<string, unknown>
): { visto: ReturnType<typeof fakeModelQuery>['visto']; tiro: boolean } => {
    const { self, visto } = fakeModelQuery();
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const qb = new QueryBuilder<any>(self as any, query);
        qb[metodo]();
        return { visto, tiro: false };
    } catch {
        return { visto, tiro: true };
    }
};

const ORDEN_DEFAULT = '-createdAt';

const cases: Case[] = [
    // ---- sort(): el caso que tiraba 500 ----
    [
        'sort con ARRAY (?sort=a&sort=b) NO tira',
        correr('sort', { sort: ['a', 'b'] }).tiro === false,
    ],
    [
        'sort con ARRAY usa el primer valor',
        JSON.stringify(correr('sort', { sort: ['name', 'x'] }).visto.sort) ===
            '{"name":1}',
    ],
    // ---- sort(): valores que Mongo rechazaba (FieldPath inválido) ----
    [
        'sort=$x cae al orden por defecto en vez de romper',
        correr('sort', { sort: '$x' }).visto.sort === ORDEN_DEFAULT,
    ],
    [
        'sort=- (nombre vacío) cae al orden por defecto',
        correr('sort', { sort: '-' }).visto.sort === ORDEN_DEFAULT,
    ],
    [
        'sort con un objeto (inyección) cae al orden por defecto',
        correr('sort', { sort: { $gte: 'x' } }).visto.sort === ORDEN_DEFAULT,
    ],
    ['sort ausente = orden por defecto', correr('sort', {}).visto.sort === ORDEN_DEFAULT],
    // ---- sort(): lo que SÍ tiene que seguir funcionando ----
    [
        'sort ascendente normal',
        JSON.stringify(correr('sort', { sort: 'name' }).visto.sort) === '{"name":1}',
    ],
    [
        'sort descendente con guión adelante',
        JSON.stringify(correr('sort', { sort: '-createdAt' }).visto.sort) ===
            '{"createdAt":-1}',
    ],
    [
        'sort por subdocumento (con punto)',
        JSON.stringify(correr('sort', { sort: 'user.name' }).visto.sort) ===
            '{"user.name":1}',
    ],
    [
        'un guión EN EL MEDIO ya no corrompe el nombre (antes `replace("-","")` ' +
            'sin anclar lo borraba esté donde esté)',
        correr('sort', { sort: 'created-At' }).visto.sort === ORDEN_DEFAULT,
    ],
    // FieldPaths mal formados que Mongo RECHAZA con 500. Una versión anterior del
    // regex —que sólo miraba el CONJUNTO de caracteres— los dejaba pasar: hay que
    // exigir la ESTRUCTURA de los segmentos separados por punto.
    [
        'sort=a. (termina en punto) cae al default',
        correr('sort', { sort: 'a.' }).visto.sort === ORDEN_DEFAULT,
    ],
    [
        'sort=a..b (punto doble = segmento vacío) cae al default',
        correr('sort', { sort: 'a..b' }).visto.sort === ORDEN_DEFAULT,
    ],
    [
        'sort=a.b. cae al default',
        correr('sort', { sort: 'a.b.' }).visto.sort === ORDEN_DEFAULT,
    ],
    [
        'sort=.a (empieza con punto) cae al default',
        correr('sort', { sort: '.a' }).visto.sort === ORDEN_DEFAULT,
    ],
    // Y los tres valores que el web manda de verdad tienen que seguir funcionando.
    [
        'los sort REALES del front siguen andando (-totalPlay)',
        JSON.stringify(correr('sort', { sort: '-totalPlay' }).visto.sort) ===
            '{"totalPlay":-1}',
    ],
    [
        'los sort REALES del front siguen andando (-trendingScore)',
        JSON.stringify(correr('sort', { sort: '-trendingScore' }).visto.sort) ===
            '{"trendingScore":-1}',
    ],

    // ---- fields(): el otro TypeError ----
    [
        'fields con ARRAY (?fields=a&fields=b) NO tira',
        correr('fields', { fields: ['name', 'email'] }).tiro === false,
    ],
    [
        'fields con ARRAY conserva los dos campos',
        correr('fields', { fields: ['name', 'email'] }).visto.select ===
            'name email',
    ],
    [
        'fields con un objeto no rompe y cae al default',
        correr('fields', { fields: { $ne: null } }).visto.select === '-_v',
    ],
    [
        'fields normal sigue andando',
        correr('fields', { fields: 'name,email' }).visto.select === 'name email',
    ],
    [
        'fields sigue filtrando los campos sensibles (denylist)',
        correr('fields', { fields: 'name,offerVector' }).visto.select === 'name',
    ],

    // ---- paginate(): ya usaba el helper; se blinda que siga así ----
    [
        'paginate con page negativa NO produce skip negativo',
        (correr('paginate', { page: '-3', limit: '10' }).visto.skip ?? -1) === 0,
    ],
    [
        'paginate con page=1e999 NO produce skip infinito',
        Number.isFinite(correr('paginate', { page: '1e999' }).visto.skip ?? NaN),
    ],
    [
        'paginate con limit negativo NO produce limit negativo',
        (correr('paginate', { limit: '-5' }).visto.limit ?? -1) >= 1,
    ],
    [
        'paginate respeta el tope global de 500',
        correr('paginate', { limit: '999999' }).visto.limit === 500,
    ],
];

export const runQueryBuilderTests = (): { pass: number; fail: number } => {
    let pass = 0;
    let fail = 0;
    for (const [name, cond] of cases) {
        if (cond) {
            pass++;
        } else {
            fail++;
            // eslint-disable-next-line no-console
            console.error(`  FALLO: ${name}`);
        }
    }
    return { pass, fail };
};

export default runQueryBuilderTests;
