/* Validación de identificadores (PURA, testeable).
 *
 * POR QUÉ EXISTE: mongoose **descarta las claves con valor `undefined`** de un
 * filtro. Eso convierte un chequeo de propiedad en un pase libre:
 *
 *     findOne({ user: undefined, _id: 'X' })  ->  filtro real: { _id: 'X' }
 *     find({ user: undefined })               ->  filtro real: {}
 *     findById(undefined)                     ->  filtro real: {}   (¡el PRIMER doc!)
 *
 * y en un `$or` es peor todavía, porque una rama vacía matchea TODO:
 *
 *     $or: [{ receiver: undefined }, { receiver: 'all' }]  ->  $or: [{}, …]
 *
 * (Todo verificado contra el mongoose 8.24.1 del propio repo.) O sea: si un id de
 * SESIÓN llega `undefined`, el predicado que limita a "lo mío" se evapora y la
 * consulta pasa a alcanzar lo de cualquiera.
 *
 * OJO con una conclusión tentadora y EQUIVOCADA: que `null` es inofensivo. Es
 * cierto SOLO para los filtros (`{_id: null}` se conserva y falla cerrado), pero
 * NO para el constructor: `new mongoose.Types.ObjectId(null)` —igual que con
 * `undefined`— devuelve un id AL AZAR en vez de fallar, así que la consulta opera
 * en silencio sobre una identidad inventada. Un chequeo `!= null` NO alcanza.
 *
 * Se valida con `isValid` y no con `!valor` por dos motivos: el string vacío
 * pasa el `!` en algunos usos y después tira CastError -> 500, y un string
 * arbitrario también.
 *
 * Sobre la advertencia clásica de que `ObjectId.isValid` acepta cualquier string
 * de 12 bytes: con el mongoose 8.24.1 de este repo eso YA NO ES ASÍ
 * ('pepe12345678' da false). Está fijado en objectId.test.ts, así que si un
 * upgrade de mongoose relajara el criterio, el gate avisa en vez de que se
 * afloje en silencio.
 */
import mongoose from 'mongoose';

/** ¿Este valor sirve como ObjectId? Rechaza undefined, null, '', arrays, objetos
 *  y cualquier otra basura. Acepta un string con forma de ObjectId, o un ObjectId
 *  de verdad.
 *
 *  OJO con la tentación de escribirlo como `isValid(String(valor ?? ''))`: eso
 *  APLANA y termina siendo MÁS PERMISIVO que `isValid` crudo. Medido:
 *  `String(['6a76…'])` devuelve el id pelado, así que un ARRAY pasaba la
 *  validación. Y mongoose castea `{_id: [a, b]}` a una búsqueda por varios ids
 *  → el filtro se ENSANCHA para alcanzar documentos ajenos, que es exactamente
 *  la clase de bug que este helper viene a cortar. */
export const esObjectIdUsable = (valor: unknown): boolean => {
    if (valor instanceof mongoose.Types.ObjectId) return true;
    if (typeof valor !== 'string') return false;
    return mongoose.Types.ObjectId.isValid(valor);
};

export default esObjectIdUsable;
