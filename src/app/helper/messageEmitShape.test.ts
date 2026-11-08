/* Prueba pura de la forma del mensaje recién enviado (B1).
 *
 * Lo que se protege es la diferencia entre dos puertas de la misma API: el
 * historial (`get-messages`, que sale de un `$project` de agregación) y el
 * mensaje que devuelve `POST /message/send` o emite el socket, que era el
 * documento crudo de mongoose. Un front que no sepa de qué puerta vino el
 * mensaje adivina, y ahí es donde aparecen los bubbles vacíos y los nombres que
 * no salen.
 *
 * Las tres reglas que importan, en este orden:
 *  1. `userDetails` tiene que salir con EXACTAMENTE las mismas claves que el
 *     `$project` de `message.pipeline.ts` (`name`, `profile_image`) — ni `_id`,
 *     ni una clave de más.
 *  2. `msgByUserId` NO se toca: v1 y la app nativa leen `m.msgByUserId?._id`.
 *     Sacarlo o convertirlo en string rompe clientes que ya funcionan.
 *  3. `seenBy` y `__v` no tienen que salir nunca, y nada más puede cambiar.
 *
 * `isMyMessage`/`seen` se prueban por ausentes a propósito: son POR DESTINATARIO
 * y el mismo objeto se emite a los dos, así que el server no las puede llenar.
 */
import { shapeSentMessage } from './messageEmitShape';

type Case = [name: string, cond: boolean];

const SENDER_ID = '64b00000000000000000000b';

// Documento que se comporta como un doc de mongoose: trae `toObject` y devuelve
// una copia nueva cada vez (mongoose lo hace así, y el helper no debe mutar el
// documento que recibe).
const fakeDoc = (
    fields: Record<string, any>,
    captured?: { options?: any }
): any => ({
    ...fields,
    toObject: (options: any) => {
        if (captured) captured.options = options;
        return { ...fields };
    },
});

const POPULATED_SENDER = {
    _id: SENDER_ID,
    name: 'Emilio',
    profile_image: 'https://cdn.example/emilio.jpg',
    email: 'emilio@example.com',
};

const SENT_DOC = {
    _id: '64c00000000000000000000c',
    text: 'hola',
    imageUrl: ['https://cdn.example/a.jpg'],
    videoUrl: [],
    pdfUrl: [],
    clientId: 'cid-1',
    isDeleted: false,
    conversationId: '64d00000000000000000000d',
    createdAt: '2026-11-05T12:00:00.000Z',
    updatedAt: '2026-11-05T12:00:00.000Z',
    __v: 0,
    seenBy: ['64e00000000000000000000e'],
    msgByUserId: POPULATED_SENDER,
};

const sortedKeys = (o: Record<string, any>): string[] =>
    Object.keys(o).sort();

const cases: Case[] = [
    ['userDetails sale con las dos claves del pipeline, ni una más',
        (() => {
            const ud = shapeSentMessage(fakeDoc(SENT_DOC)).userDetails;
            return (
                ud.name === 'Emilio' &&
                ud.profile_image === 'https://cdn.example/emilio.jpg' &&
                sortedKeys(ud).join(',') === 'name,profile_image'
            );
        })()],

    ['msgByUserId sigue viajando poblado como objeto (v1/nativo leen ._id)',
        (() => {
            const out = shapeSentMessage(fakeDoc(SENT_DOC));
            return (
                out.msgByUserId &&
                out.msgByUserId._id === SENDER_ID &&
                typeof out.msgByUserId === 'object'
            );
        })()],

    ['seenBy (__v) no salen: quién leyó el chat es interno',
        (() => {
            const out = shapeSentMessage(fakeDoc(SENT_DOC));
            return !('seenBy' in out) && !('__v' in out);
        })()],

    ['el resto del payload viaja idéntico (texto, adjuntos, fechas, clientId)',
        (() => {
            const out = shapeSentMessage(fakeDoc(SENT_DOC));
            return (
                out.text === 'hola' &&
                out.imageUrl[0] === 'https://cdn.example/a.jpg' &&
                out.videoUrl.length === 0 &&
                out.pdfUrl.length === 0 &&
                out.clientId === 'cid-1' &&
                out.isDeleted === false &&
                out.conversationId === '64d00000000000000000000d' &&
                out.createdAt === '2026-11-05T12:00:00.000Z' &&
                out.updatedAt === '2026-11-05T12:00:00.000Z' &&
                out._id === '64c00000000000000000000c'
            );
        })()],

    ['las claves son exactamente las del doc menos las dos que se sacan, más userDetails',
        (() => {
            const out = shapeSentMessage(fakeDoc(SENT_DOC));
            const esperado = [
                ...sortedKeys(SENT_DOC).filter(
                    (k) => k !== 'seenBy' && k !== '__v'
                ),
                'userDetails',
            ].sort();
            return sortedKeys(out).join(',') === esperado.join(',');
        })()],

    ['se le pide a mongoose la versión SIN clave de versión',
        (() => {
            const cap: { options?: any } = {};
            shapeSentMessage(fakeDoc(SENT_DOC, cap));
            return cap.options?.versionKey === false;
        })()],

    ['sin poblar (msgByUserId es solo un id) no se inventa userDetails',
        (() => {
            const out = shapeSentMessage(
                fakeDoc({ ...SENT_DOC, msgByUserId: SENDER_ID })
            );
            return !('userDetails' in out) && out.msgByUserId === SENDER_ID;
        })()],

    ['un remitente poblado incompleto no reventa: las claves van igual, vacías',
        (() => {
            const out = shapeSentMessage(
                fakeDoc({ ...SENT_DOC, msgByUserId: { _id: SENDER_ID } })
            );
            return (
                out.userDetails &&
                out.userDetails.name === undefined &&
                sortedKeys(out.userDetails).join(',') === 'name,profile_image'
            );
        })()],

    ['objeto plano (un lean, o algo ya serializado) también se forma',
        (() => {
            const out = shapeSentMessage({ ...SENT_DOC });
            return (
                out.userDetails?.name === 'Emilio' &&
                !('seenBy' in out) &&
                !('__v' in out)
            );
        })()],

    ['no muta la entrada: el objeto que recibe queda intacto',
        (() => {
            const plano = { ...SENT_DOC };
            shapeSentMessage(plano);
            return (
                'seenBy' in plano &&
                '__v' in plano &&
                !('userDetails' in plano)
            );
        })()],

    ['isMyMessage y seen NO se agregan acá: son por destinatario',
        (() => {
            const out = shapeSentMessage(fakeDoc(SENT_DOC));
            return !('isMyMessage' in out) && !('seen' in out);
        })()],

    ['doc nulo/undefined pasa tal cual, sin reventar (el llamador puede no tener mensaje)',
        (() => {
            const nulo: any = shapeSentMessage(null);
            const ausente: any = shapeSentMessage(undefined);
            return nulo === null && ausente === undefined;
        })()],
];

export const runMessageEmitShapeTests = (): { pass: number; fail: number } => {
    let pass = 0,
        fail = 0;
    for (const [name, cond] of cases) {
        if (cond) pass++;
        else {
            fail++;
            // eslint-disable-next-line no-console
            console.error('FAIL:', name);
        }
    }
    return { pass, fail };
};
