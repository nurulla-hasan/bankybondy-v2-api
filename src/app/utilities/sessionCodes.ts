/* Códigos de SESIÓN MUERTA — lista canónica.
 *
 * Marcan los rechazos que un cliente NO puede arreglar pidiendo un token nuevo:
 * el access token puede ser perfectamente válido y la cuenta igual no sirve. Ante
 * cualquiera de estos, el cliente tiene que DESLOGUEAR, no refrescar.
 *
 * Por qué existe esta lista y no se decide por status HTTP: en esta API el 401 NO
 * significa sólo "autenticación rota" — también se usa para PERMISO DENEGADO
 * (`conversation.service` cuando no sos participante, `chatGroup.service` cuando
 * no sos miembro, y el propio chequeo de ROL de `middlewares/auth.ts`). Un
 * cliente que deslogueara ante cualquier 401 echaría usuarios legítimos: abrir la
 * galería de un chat viejo te sacaría de tu cuenta. Los códigos son inequívocos;
 * el status no.
 *
 * CONTRATO PÚBLICO: estos valores los consume el web y —cuando exista— la app
 * nativa, cuyo ciclo de release está desacoplado del server. Renombrar uno
 * reabre el limbo en todas las versiones instaladas. Se agregan, no se cambian.
 */

export const SESSION_DEAD_CODES = [
    'INVALID_TOKEN', // el token no trae un id usable
    'PROFILE_MISSING', // la cuenta no tiene perfil (no se puede operar)
    'ACCOUNT_NOT_FOUND', // el User fue borrado de verdad (hard delete)
    'ACCOUNT_DELETED', // borrado lógico (isDeleted)
    'ACCOUNT_BLOCKED', // bloqueado por un admin
    'PASSWORD_CHANGED', // la contraseña cambió después de emitir el token
] as const;

export type SessionDeadCode = (typeof SESSION_DEAD_CODES)[number];

const SET = new Set<string>(SESSION_DEAD_CODES);

/** ¿Este código significa "la sesión está muerta, deslogueá"?
 *  Estricto a propósito: sólo strings exactos. Cualquier otra cosa (undefined,
 *  null, arrays, objetos) da false, para que un valor raro NUNCA eche a nadie. */
export const esCodigoDeSesionMuerta = (codigo: unknown): boolean =>
    typeof codigo === 'string' && SET.has(codigo);

export default esCodigoDeSesionMuerta;
