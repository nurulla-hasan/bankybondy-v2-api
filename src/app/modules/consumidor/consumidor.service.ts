import { randomInt } from 'crypto';
import { errorLogger, logger } from '../../shared/logger';
import sendEmail from '../../utilities/sendEmail';
import { CASILLA_SOPORTE, mailConsumidor, mailSoporte } from './consumidor.email';
import {
    ISolicitudConsumidor,
    SolicitudConsumidor,
    TipoSolicitud,
} from './consumidor.model';

// Sin 0/O ni 1/I: el código se dicta por teléfono o se copia a mano.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `ARR-20260929-7K3F9Q` / `BAJ-…`. La fecha es la de Argentina. CSPRNG, igual
 *  que el OTP de auth.services.ts: el código no tiene que poder adivinarse. */
export const generarCodigo = (tipo: TipoSolicitud, ahora: Date): string => {
    const dia = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    })
        .format(ahora)
        .replace(/-/g, '');
    let sufijo = '';
    for (let i = 0; i < 6; i++) sufijo += ALFABETO[randomInt(ALFABETO.length)];
    return `${tipo === 'baja' ? 'BAJ' : 'ARR'}-${dia}-${sufijo}`;
};

type DatosSolicitud = Pick<
    ISolicitudConsumidor,
    'tipo' | 'nombre' | 'email' | 'medioPago' | 'operacion' | 'comentario'
> & { idioma?: 'es' | 'en' };

// Los dos mails van DESPUÉS de responder. `sendEmail` no lanza (devuelve false
// si falló), pero el `updateOne` sí puede. Un rechazo suelto NO tumba el proceso
// (server.ts lo loguea y sigue), pero lo cuenta para su cortacircuitos, que sí
// sale si llueven: por eso el catch, que además deja el código del pedido en el log.
const avisar = (s: ISolicitudConsumidor, fecha: Date): void => {
    const aConsumidor = mailConsumidor(s, fecha);
    const aSoporte = mailSoporte(s, fecha);
    Promise.all([
        // Reply-To a soporte: la respuesta a este correo es la verificación de la baja.
        sendEmail({
            email: s.email,
            ...aConsumidor,
            headers: { 'Reply-To': CASILLA_SOPORTE },
        }),
        sendEmail({ email: CASILLA_SOPORTE, ...aSoporte }),
    ])
        .then(([okConsumidor, okAdmin]) => {
            if (!okConsumidor || !okAdmin) {
                errorLogger.error(
                    `[consumidor] ${s.codigo}: mail a la persona=${okConsumidor} a soporte=${okAdmin}`
                );
            }
            return SolicitudConsumidor.updateOne(
                { codigo: s.codigo },
                { $set: { mailConsumidor: okConsumidor, mailAdmin: okAdmin } }
            );
        })
        .catch((err) =>
            errorLogger.error(
                `[consumidor] ${s.codigo}: no se pudo anotar el envío de mails: ${
                    (err as Error)?.message || err
                }`
            )
        );
};

/** Guarda el pedido y devuelve el código. El código sale en la RESPUESTA (la
 *  persona lo ve en pantalla en el acto), así que el plazo de 24 horas de la
 *  Disp. 954/2025 art. 5 se cumple aunque el mail no salga. */
const crearSolicitud = async (datos: DatosSolicitud) => {
    const ahora = new Date();
    let creada: ISolicitudConsumidor | null = null;
    // `codigo` es único: ante un choque (1 en ~10^9 por día) se genera otro.
    for (let intento = 1; !creada; intento++) {
        try {
            creada = (
                await SolicitudConsumidor.create({
                    ...datos,
                    idioma: datos.idioma ?? 'es',
                    codigo: generarCodigo(datos.tipo, ahora),
                })
            ).toObject();
        } catch (err) {
            if ((err as { code?: number })?.code === 11000 && intento < 3)
                continue;
            throw err;
        }
    }
    logger.info(`[consumidor] ${creada.tipo} ${creada.codigo} recibido`);
    avisar(creada, creada.createdAt ?? ahora);
    return {
        codigo: creada.codigo,
        tipo: creada.tipo,
        fecha: creada.createdAt ?? ahora,
    };
};

export const ConsumidorService = {
    crearSolicitud,
};
