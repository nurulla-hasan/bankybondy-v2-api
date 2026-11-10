import { randomInt } from 'crypto';
import { errorLogger, logger } from '../../shared/logger';
import sendEmail from '../../utilities/sendEmail';
import { CASILLA_SOPORTE, mailConsumidor, mailSoporte } from './consumidor.email';
import {
    ISolicitudConsumidor,
    SolicitudConsumidor,
    TipoSolicitud,
} from './consumidor.model';

// No 0/O or 1/I: the code is dictated by phone or copied by hand.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `ARR-20260929-7K3F9Q` / `BAJ-…`. Date is Argentina's. CSPRNG, like the auth
 *  OTP: the code must not be guessable. */
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

// Both mails go AFTER responding. `sendEmail` never throws (returns false on
// failure) but the `updateOne` can: an isolated rejection does not kill the
// process but counts toward its circuit breaker, hence the catch, which also
// logs the request code.
const avisar = (s: ISolicitudConsumidor, fecha: Date): void => {
    const aConsumidor = mailConsumidor(s, fecha);
    const aSoporte = mailSoporte(s, fecha);
    Promise.all([
        // Reply-To to support: replying to this mail is the cancellation proof.
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

/** Saves the request and returns the code. The code is in the RESPONSE (the
 *  person sees it on screen immediately), so the 24-hour deadline of Disp.
 *  954/2025 art. 5 holds even if the mail fails. */
const crearSolicitud = async (datos: DatosSolicitud) => {
    const ahora = new Date();
    let creada: ISolicitudConsumidor | null = null;
    // `codigo` is unique: on collision (1 in ~10^9 per day) generate another.
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
