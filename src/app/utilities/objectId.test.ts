/* Test de la validación de ids (pura, sin DB).
 *
 * Blinda la guarda que cierra el bypass de autorización: mongoose DESCARTA las
 * claves `undefined` de un filtro, así que un id de sesión ausente borra el
 * predicado de propiedad y la consulta pasa a alcanzar lo de cualquiera. El caso
 * que más importa es `undefined`; los demás están para que nadie "simplifique"
 * esto a un `!valor` y reabra el agujero.
 */
import mongoose from 'mongoose';
import { esObjectIdUsable } from './objectId';

type Case = [name: string, cond: boolean];

const ID_VALIDO = '6a766b6954b574a9211ff164'; // 24 hex

const cases: Case[] = [
    // --- lo que TIENE que pasar ---
    ['un ObjectId de 24 hex es usable', esObjectIdUsable(ID_VALIDO) === true],
    [
        'mayúsculas/minúsculas mezcladas también',
        esObjectIdUsable('6A766B6954B574A9211FF164') === true,
    ],

    // --- EL CASO CRÍTICO: lo que borraba el predicado del filtro ---
    [
        'undefined NO es usable (es el que vacía el filtro)',
        esObjectIdUsable(undefined) === false,
    ],
    ['null NO es usable', esObjectIdUsable(null) === false],
    ['string vacío NO es usable', esObjectIdUsable('') === false],

    // --- basura varia: todo lo que un `!valor` dejaría pasar ---
    ['texto arbitrario NO es usable', esObjectIdUsable('abc') === false],
    [
        'un hex de 23 (uno de menos) NO es usable',
        esObjectIdUsable('6a766b6954b574a9211ff16') === false,
    ],
    [
        'un hex de 25 (uno de más) NO es usable',
        esObjectIdUsable('6a766b6954b574a9211ff1644') === false,
    ],
    [
        'con caracteres no-hex NO es usable',
        esObjectIdUsable('6a766b6954b574a9211ff16z') === false,
    ],
    ['un objeto NO es usable', esObjectIdUsable({}) === false],
    ['un array vacío NO es usable', esObjectIdUsable([]) === false],
    ['un booleano NO es usable', esObjectIdUsable(true) === false],
    ['un número NO es usable', esObjectIdUsable(0) === false],

    // --- EL BYPASS QUE UNA VERSIÓN ANTERIOR DE ESTE HELPER DEJABA PASAR ---
    // Escrito como `isValid(String(valor ?? ''))`, el String() APLANA: un array de
    // un elemento devolvía el id pelado y pasaba la validación, quedando MÁS
    // permisivo que `isValid` crudo. Y mongoose castea `{_id: [a, b]}` a una
    // búsqueda por varios ids → el filtro se ENSANCHA hasta documentos ajenos,
    // que es justo la clase de bug que este helper viene a cortar.
    [
        'BYPASS: un ARRAY de un id NO es usable',
        esObjectIdUsable([ID_VALIDO]) === false,
    ],
    [
        'BYPASS: un array de DOS ids NO es usable (ensancharía el filtro)',
        esObjectIdUsable([ID_VALIDO, '6a766b6954b574a9211ff165']) === false,
    ],
    [
        'BYPASS: un objeto con toString() NO es usable',
        esObjectIdUsable({ toString: () => ID_VALIDO }) === false,
    ],
    // Un ObjectId de verdad SÍ, para no romper a un caller que pase el tipo nativo.
    [
        'un ObjectId nativo SÍ es usable',
        esObjectIdUsable(new mongoose.Types.ObjectId(ID_VALIDO)) === true,
    ],
    [
        'el string "undefined" NO es usable (llega así si alguien concatena)',
        esObjectIdUsable('undefined') === false,
    ],
    [
        'el string "null" NO es usable',
        esObjectIdUsable('null') === false,
    ],

    // --- el famoso "12 bytes": NO aplica en esta versión ---
    // La advertencia clásica sobre `ObjectId.isValid` es que acepta cualquier
    // string de 12 bytes ('pepe12345678'). Con el mongoose 8.24.1 de este repo eso
    // ya NO es así: da false. Este test lo fija, para que si un upgrade de mongoose
    // relajara el criterio, el gate avise en vez de que se afloje en silencio.
    [
        'un string cualquiera de 12 caracteres NO es usable (en esta versión)',
        esObjectIdUsable('pepe12345678') === false,
    ],
];

// ---------------------------------------------------------------------------
// LA PREMISA. Todo el fix de autorización se apoya en un COMPORTAMIENTO DE
// MONGOOSE, no en código nuestro. Si un upgrade lo cambiara, las guardas
// quedarían como código muerto y nadie se enteraría. Esto lo fija.
// No necesita base de datos: `getFilter()` muestra el filtro ya casteado.
// ---------------------------------------------------------------------------
const esquemaPrueba = new mongoose.Schema({
    user: mongoose.Schema.Types.ObjectId,
    receiver: mongoose.Schema.Types.ObjectId,
});
// Nombre único para no chocar si otro test registra un modelo.
const ModeloPrueba: mongoose.Model<any> =
    mongoose.models.__objectIdTestModel ||
    mongoose.model('__objectIdTestModel', esquemaPrueba);

const filtro = (q: { getFilter: () => unknown }) => JSON.stringify(q.getFilter());

const premisa: Case[] = [
    [
        'PREMISA: mongoose DESCARTA la clave undefined -> el predicado de propiedad DESAPARECE',
        filtro(ModeloPrueba.findOne({ user: undefined, _id: ID_VALIDO })) ===
            `{"_id":"${ID_VALIDO}"}`,
    ],
    [
        'PREMISA: find({user: undefined}) queda en {} -> devuelve TODA la colección',
        filtro(ModeloPrueba.find({ user: undefined })) === '{}',
    ],
    [
        'PREMISA: findById(undefined) queda en {} -> devuelve el PRIMER documento',
        filtro(ModeloPrueba.findById(undefined)) === '{}',
    ],
    [
        'PREMISA: en un $or, la rama con undefined queda VACÍA y matchea todo',
        filtro(
            ModeloPrueba.find({
                $or: [{ receiver: undefined }, { receiver: ID_VALIDO }],
            })
        ) === `{"$or":[{},{"receiver":"${ID_VALIDO}"}]}`,
    ],
    [
        'PREMISA: null SÍ se conserva en el filtro (falla cerrado, a diferencia de undefined)',
        filtro(ModeloPrueba.findById(null)) === '{"_id":null}',
    ],
    [
        'PREMISA: el CONSTRUCTOR es otra historia — new ObjectId(undefined) NO tira, ' +
            'inventa un id (por eso un chequeo `!= null` no alcanza)',
        new mongoose.Types.ObjectId(undefined) instanceof mongoose.Types.ObjectId,
    ],
    [
        // El cast es a propósito: TypeScript NO deja pasar `null` en la firma del
        // constructor, pero en runtime no tira — inventa un id igual. Justamente
        // esa brecha entre lo que el tipo promete y lo que el runtime hace es lo
        // que hace peligrosa esta clase de bug en los `any` del código.
        'PREMISA: new ObjectId(null) TAMBIÉN inventa un id (el tipo lo prohíbe, el runtime no)',
        new mongoose.Types.ObjectId(null as unknown as string) instanceof
            mongoose.Types.ObjectId,
    ],
    [
        'PREMISA: dos ObjectId inventados son DISTINTOS (identidad al azar, no determinista)',
        new mongoose.Types.ObjectId(undefined).toString() !==
            new mongoose.Types.ObjectId(undefined).toString(),
    ],
];

cases.push(...premisa);

export const runObjectIdTests = (): { pass: number; fail: number } => {
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

export default runObjectIdTests;
