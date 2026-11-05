import { INotification } from '../modules/notification/notification.interface';
import Notification from '../modules/notification/notification.model';
import { getIO } from '../socket/socket';
import getUserNotificationCount from './getUserNotificationCount';

interface SendNotificationOptions {
    // Colapsar por vínculo: en vez de crear una fila nueva, mantiene UNA sola
    // notificación por (receiver + type + redirectId). Si ya existe, la refresca
    // (texto), la sube al tope (createdAt) y la vuelve a NO-leída (seenBy=[]) y
    // visible (deleteBy=[]). Se usa para las notificaciones de match: el robot ya
    // no acumula una fila por cada pasada, sino que actualiza la del vínculo.
    collapseByRedirect?: boolean;
    // Firmas de match nuevas a registrar en `notifiedSignatures` (solo colapso de
    // MATCH). Se mergean con $addToSet: una reaparición de la MISMA firma ya no
    // vuelve a resetear seenBy la próxima vez (anti-rebote del badge).
    addSignatures?: string[];
}

const sendNotification = async (
    notificationData: INotification,
    options?: SendNotificationOptions
) => {
    // Camino COLAPSAR (match): upsert por (receiver, type, redirectId). Requiere
    // redirectId; si faltara, cae al create normal para no colapsar de más.
    if (options?.collapseByRedirect && notificationData.redirectId) {
        const { receiver, type, redirectId } = notificationData;
        const filter = { receiver, type, redirectId };
        const now = new Date();
        // timestamps:false → manejamos createdAt/updatedAt a mano (así podemos
        // BUMPEAR createdAt al tope sin que Mongoose meta su propio updatedAt y
        // choque con nuestro $set). createdAt nuevo = sube en el listado (ordena
        // por createdAt desc); seenBy/deleteBy vacíos = no-leída y visible.
        const update: Record<string, unknown> = {
            $set: {
                title: notificationData.title,
                message: notificationData.message,
                seenBy: [],
                deleteBy: [],
                createdAt: now,
                updatedAt: now,
            },
        };
        // Registrar las firmas GENUINAMENTE nuevas por las que se avisa. El caller
        // (notifyNewMatches) ya sólo llama cuando hay firmas nuevas, así que acá
        // reseteamos seenBy (arriba) y acumulamos esas firmas para que una futura
        // reaparición de la misma no vuelva a rebotar el badge.
        const sigs = options?.addSignatures;
        if (sigs && sigs.length) {
            // $push con $slice acota el array a las últimas N firmas (evita que un
            // bond muy activo acumule miles de firmas y las relea enteras en cada
            // recomputo). Las firmas ya vienen dedupeadas por el caller. Si una muy
            // vieja cae del tope y reaparece, se re-avisa una vez (aceptable).
            update.$push = { notifiedSignatures: { $each: sigs, $slice: -300 } };
        }
        try {
            await Notification.findOneAndUpdate(filter, update, {
                upsert: true,
                new: true,
                timestamps: false,
            });
        } catch (err: unknown) {
            // Índice único parcial (receiver, redirectId | type=MATCH): si dos
            // pasadas del robot corren a la vez, la 2ª choca con 11000. La fila ya
            // existe → aplicamos sólo el update (sin upsert). Idempotente.
            if ((err as { code?: number })?.code === 11000) {
                await Notification.updateOne(filter, update, {
                    timestamps: false,
                });
            } else {
                throw err;
            }
        }
    } else {
        // Persistimos SIEMPRE primero: la notificación NO debe perderse aunque el
        // socket no esté disponible. Esto importa ahora que el cómputo de matcheo
        // corre en un proceso worker dedicado que NO inicializa el `io` — antes,
        // llamar a getIO() primero tiraba y se perdía hasta el registro en la base.
        await Notification.create(notificationData);
    }

    // Push en vivo: best-effort. Si no hay `io` (proceso worker) o falla el
    // socket, la notificación ya quedó guardada y aparece en la próxima
    // carga/poll del cliente. Nunca rompe el flujo que la disparó.
    try {
        const io = getIO();
        const updatedNotification = await getUserNotificationCount(
            notificationData.receiver.toString()
        );
        io.to(notificationData.receiver.toString()).emit(
            'notification',
            updatedNotification
        );
    } catch {
        /* sin socket en este proceso: notificación ya persistida */
    }
};

export default sendNotification;
