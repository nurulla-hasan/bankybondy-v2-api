/* Forma del mensaje que se entrega a un cliente ACABA de ser creado (B1).
 *
 * Hay DOS formas del mismo mensaje en esta API, y eso es lo que rompe clientes:
 *  - `get-messages` (historial) sale por un `$project` de agregación y trae
 *    `userDetails{name, profile_image}`, `isMyMessage`, `seen`, y NO trae
 *    `seenBy` ni `__v`.
 *  - El mensaje que emite el socket al llegar, y el que devuelve
 *    `POST /message/send`, eran el documento crudo de mongoose: `msgByUserId`
 *    poblado como objeto, sin `userDetails`, con `seenBy` y `__v` adentro.
 *
 * O sea que el front tenía que adivinar de qué puerta vino el mensaje. Este
 * helper agrega la clave que faltaba (`userDetails`, con EXACTAMENTE los mismos
 * campos que el `$project` de `message.pipeline.ts:74-75`) y saca las que no
 * deberían salir nunca (`seenBy` nombra quién leyó el chat; `__v` es interno de
 * mongoose).
 *
 * A PROPÓSITO NO se tocan:
 *  - `msgByUserId` (sigue viajando poblado, como objeto): v1 y la app nativa leen
 *    `m.msgByUserId?._id`. Cambiar la forma de una clave que alguien ya consume
 *    es romper clientes, no ordenar el contrato.
 *  - `isMyMessage` y `seen`: son POR DESTINATARIO, y el mismo objeto se emite a
 *    los dos. El server no puede saber a quién va cada copia; lo deriva el
 *    cliente contra su propio profileId. Meterlas acá sería mentirle a uno de
 *    los dos.
 *  - El vaciado de borrados: un mensaje recién creado nunca está borrado, así que
 *    no hay contenido que limpiar (el historial ya lo hace en su pipeline, y la
 *    vista previa de la lista en `scrubLastMessageStage`).
 *
 * Puro: recibe el doc (o un objeto plano) y devuelve un objeto plano.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const shapeSentMessage = (message: any): Record<string, any> => {
    if (!message) return message;

    const obj =
        typeof message.toObject === 'function'
            ? message.toObject({ versionKey: false })
            : { ...message };

    const sender = obj.msgByUserId;
    if (sender && typeof sender === 'object') {
        obj.userDetails = {
            name: sender.name,
            profile_image: sender.profile_image,
        };
    }

    delete obj.seenBy;
    delete obj.__v;

    return obj;
};
