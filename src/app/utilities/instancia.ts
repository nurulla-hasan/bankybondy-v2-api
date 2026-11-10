/* Am I the LEADER instance of my app in PM2? Gates what must run ONCE per app
 * (periodic crons, startup migrations); the BullMQ worker is NOT gated.
 *
 * Uses `NODE_APP_INSTANCE` (index within the PM2 app), not `pm_id`, which is
 * GLOBAL across apps: with `bankybondy-api` and `bankybondy-matcher` coexisting no
 * matcher process would be 0 and its crons would NEVER run. Absent = leader, the
 * safe default (single process, manual start, tests, other supervisors).
 */

/** `true` if this process should run the tasks that must happen ONCE per app
 *  (periodic crons, startup migrations). */
export const esInstanciaLider = (): boolean => {
    const idx = process.env.NODE_APP_INSTANCE;
    if (idx === undefined || idx === '') return true;
    return idx === '0';
};

/** Short label for logs, to tell which instance each line came from. */
export const etiquetaInstancia = (): string => {
    const idx = process.env.NODE_APP_INSTANCE;
    return idx === undefined || idx === '' ? 'única' : `#${idx}`;
};

export default esInstanciaLider;
