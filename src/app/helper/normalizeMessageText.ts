/**
 * El texto de un mensaje siempre es string, venga lo que venga por el socket.
 *
 * `$regex: ''` — el filtro fijo de `getMessages`, ver message.pipeline.ts — solo
 * matchea strings: con `text: null` el mensaje se guardaba y desaparecía del
 * historial sin dar ningún error. Las cuatro ramas de envío comparten este criterio.
 */
export const normalizeMessageText = (text: unknown): string =>
    typeof text === 'string' ? text : '';
