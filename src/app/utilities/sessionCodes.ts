/* DEAD SESSION codes: the client must LOG OUT, not refresh (401 is also used for
 * denied permission here). PUBLIC CONTRACT: codes are added, never renamed.
 */

export const SESSION_DEAD_CODES = [
    'INVALID_TOKEN', // token carries no usable id
    'PROFILE_MISSING', // account has no profile (cannot operate)
    'ACCOUNT_NOT_FOUND', // User was hard-deleted
    'ACCOUNT_DELETED', // soft-deleted (isDeleted)
    'ACCOUNT_BLOCKED', // blocked by an admin
    'PASSWORD_CHANGED', // password changed after the token was issued
] as const;

export type SessionDeadCode = (typeof SESSION_DEAD_CODES)[number];

const SET = new Set<string>(SESSION_DEAD_CODES);

/** Does this code mean "dead session, log out"? Strict: exact strings only, so a
 *  weird value (undefined, null, arrays, objects) never logs anyone out. */
export const esCodigoDeSesionMuerta = (codigo: unknown): boolean =>
    typeof codigo === 'string' && SET.has(codigo);

export default esCodigoDeSesionMuerta;
