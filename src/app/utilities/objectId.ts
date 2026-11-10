/* ObjectId validation (PURE, testable): mongoose DROPS `undefined` filter keys, so an
 * undefined session id silently widens the query to other users' documents. */
import mongoose from 'mongoose';

/** Is this usable as an ObjectId? Rejects undefined, null, '', arrays and objects
 *  (`new ObjectId(null)` yields a RANDOM id). Don't wrap it in `String(...)`: that
 *  lets arrays through and widens the filter. */
export const esObjectIdUsable = (valor: unknown): boolean => {
    if (valor instanceof mongoose.Types.ObjectId) return true;
    if (typeof valor !== 'string') return false;
    return mongoose.Types.ObjectId.isValid(valor);
};

export default esObjectIdUsable;
