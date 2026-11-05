/* ¿Soy la instancia LÍDER de mi app en PM2?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUÉ HACE FALTA
 *
 * Hasta la escala horizontal esto no existía porque no podía existir: la API y el
 * worker corrían con `instances: 1`, así que "el proceso" y "todos los procesos"
 * eran lo mismo. Al subir `instances`, todo lo que era seguro por ser único deja
 * de serlo, y de dos maneras distintas:
 *
 *  - Los CRON se MULTIPLICAN. Tres workers = tres sweeps de matcheo corriendo el
 *    mismo minuto, con el mismo filtro y el mismo orden → los tres traen EL MISMO
 *    lote de 1.500 vínculos y encolan lo mismo. La deduplicación por `jobId` hace
 *    que no se compute tres veces (bien), pero la capacidad efectiva NO sube: se
 *    paga la consulta tres veces para encolar el mismo trabajo. El paralelismo
 *    real lo da el WORKER de BullMQ consumiendo la cola, no el productor.
 *
 *  - Las MIGRACIONES de arranque corren en paralelo. `collapseMatchNotifications`
 *    colapsa duplicados y crea un índice único; tres copias haciendo eso a la vez
 *    es, en el mejor caso, ruido en los logs.
 *
 * Lo que NO se gatea: el Worker de BullMQ. Ése tiene que correr en TODAS las
 * instancias — es exactamente ahí donde vive el paralelismo que buscamos.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÓMO SE DECIDE
 *
 * PM2 expone `NODE_APP_INSTANCE` con el índice de la instancia DENTRO de su app
 * (0, 1, 2…) cuando `instances` está seteado. Se usa ése y no `pm_id`, que es un
 * contador GLOBAL entre todas las apps: con `bankybondy-api` y
 * `bankybondy-matcher` conviviendo, ningún proceso del matcher tendría `pm_id` 0
 * y los cron del worker no correrían NUNCA. Es el tipo de error que no da ningún
 * síntoma hasta que alguien nota que hace días no se refrescan las coincidencias.
 *
 * Ausente = líder. Es el default seguro: cubre el proceso único, el arranque a
 * mano (`node dist/worker.js`), los tests y cualquier supervisor que no sea PM2.
 * El modo de falla de equivocarse para este lado es "corre de más"; para el otro
 * lado es "no corre nunca", que es mucho peor y además silencioso.
 */

/** `true` si este proceso debe correr las tareas que tienen que ocurrir UNA sola
 *  vez por app (cron periódicos, migraciones de arranque). */
export const esInstanciaLider = (): boolean => {
    const idx = process.env.NODE_APP_INSTANCE;
    if (idx === undefined || idx === '') return true;
    return idx === '0';
};

/** Etiqueta corta para los logs, para poder distinguir de qué instancia viene
 *  cada línea cuando hay varias. */
export const etiquetaInstancia = (): string => {
    const idx = process.env.NODE_APP_INSTANCE;
    return idx === undefined || idx === '' ? 'única' : `#${idx}`;
};

export default esInstanciaLider;
