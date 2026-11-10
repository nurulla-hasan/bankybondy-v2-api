import { ISolicitudConsumidor } from './consumidor.model';

// Support inbox, same one used by /contact-us (helper/sendContactUsEmail.ts).
export const CASILLA_SOPORTE = 'bankybondyar@gmail.com';

// Same helper as sendContactUsEmail.ts (not exported there): fields come from a
// PUBLIC form and are interpolated into the email HTML.
const escapeHtml = (s: string): string =>
    s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

// Argentina time: governs the 10 calendar days of art. 34, Ley 24.240, and is what
// the recipient reads.
export const fechaLegible = (fecha: Date, idioma: 'es' | 'en'): string =>
    new Intl.DateTimeFormat(idioma === 'en' ? 'en-US' : 'es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
        dateStyle: 'long',
        timeStyle: 'short',
    }).format(fecha);

const envolver = (titulo: string, cuerpo: string): string => `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>${titulo}</title></head>
<body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#111827;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;line-height:1.6;">
    <h1 style="font-size:20px;margin:0 0 16px 0;">${titulo}</h1>
    ${cuerpo}
  </div>
</body>
</html>`;

const bloqueCodigo = (codigo: string): string =>
    `<p style="font-size:22px;font-weight:bold;letter-spacing:1px;background:#f9fafb;border-left:4px solid #e2765a;padding:12px 16px;margin:16px 0;">${escapeHtml(codigo)}</p>`;

/** Mail to the requester, in their language. Deliberately WITHOUT the name: the form
 *  is public, so anyone could enter a third party's email and abuse the name as free
 *  text (phishing with our sender). Reply-To goes to support: replying is the identity
 *  check for the cancellation (Disp. 3/2026). */
export const mailConsumidor = (
    s: Pick<ISolicitudConsumidor, 'codigo' | 'tipo' | 'idioma'>,
    fecha: Date
): { subject: string; html: string } => {
    const cuando = fechaLegible(fecha, s.idioma);

    if (s.idioma === 'en') {
        const que =
            s.tipo === 'baja'
                ? 'your request to cancel the service'
                : 'your withdrawal request (right of withdrawal)';
        const despues =
            s.tipo === 'baja'
                ? 'To confirm it was you, reply to this email: only then will we cancel the account and send you the confirmation. If you did not request it, you do not need to do anything: without your reply, the account stays active.'
                : 'We will refund 100% of what you paid, through the same payment method, within 10 business days. If you did not make this request, reply to this email to let us know.';
        return {
            subject: `We received your request — code ${s.codigo}`,
            html: envolver(
                'We received your request',
                `<p>Hello. We received ${que} on ${cuando} (Argentina time).</p>
                 <p>Your identification code is:</p>${bloqueCodigo(s.codigo)}
                 <p>${despues}</p>
                 <p>If you have any questions, reply to this email (or write to ${CASILLA_SOPORTE} and include your code).</p>`
            ),
        };
    }

    const que =
        s.tipo === 'baja'
            ? 'tu pedido de baja del servicio'
            : 'tu pedido de arrepentimiento';
    const despues =
        s.tipo === 'baja'
            ? 'Para confirmar que la pediste vos, respondé este correo: recién entonces damos de baja la cuenta y te mandamos la constancia. Si no la pediste vos, no hace falta que hagas nada: sin tu respuesta, la cuenta sigue activa.'
            : 'Te devolvemos el 100% de lo que pagaste, por el mismo medio de pago, dentro de los 10 días hábiles. Si no hiciste este pedido, respondé este correo para avisarnos.';
    return {
        subject: `Recibimos tu pedido — código ${s.codigo}`,
        html: envolver(
            'Recibimos tu pedido',
            `<p>Hola. Recibimos ${que} el ${cuando} (hora de Argentina).</p>
             <p>Tu código de identificación es:</p>${bloqueCodigo(s.codigo)}
             <p>${despues}</p>
             <p>Si tenés dudas, respondé este correo (o escribinos a ${CASILLA_SOPORTE} con tu código).</p>`
        ),
    };
};

/** Mail to support: everything needed to handle the request manually. */
export const mailSoporte = (
    s: ISolicitudConsumidor,
    fecha: Date
): { subject: string; html: string } => {
    const etiqueta = s.tipo === 'baja' ? 'BAJA DE SERVICIO' : 'ARREPENTIMIENTO';
    const fila = (k: string, v?: string) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;">${k}</td><td style="padding:6px 0;">${v ? escapeHtml(v) : '—'}</td></tr>`;
    const tarea =
        s.tipo === 'baja'
            ? 'ANTES de ejecutar: el email tiene que ser el de una cuenta, y la persona tiene que haber RESPONDIDO el acuse desde ese mismo email (o escrito desde él citando el código) — Disp. 3/2026. Sin esa respuesta NO borrar: la baja borra la cuenta y es IRREVERSIBLE. Con la respuesta: dar de baja y mandar la constancia por mail dentro de las 72 h del pedido (Ley 24.240, art. 10 ter); si la respuesta llega después, apenas llegue.'
            : 'Devolver el 100% SÓLO como reembolso de la transacción original (PayPal/MercadoPago), NUNCA a una cuenta, CBU o alias que aparezca en el pedido o en un mail. Plazo: 10 días hábiles. Pasar la cuenta a plan gratuito sin borrar lo publicado. Si el email no coincide con ningún pago, pedir por mail el número de operación. Si la persona responde que no lo pidió, NO ejecutar.';
    return {
        subject: `⚖️ ${etiqueta} ${s.codigo} — ${escapeHtml(s.nombre)}`,
        html: envolver(
            `${etiqueta} · ${escapeHtml(s.codigo)}`,
            `<table style="border-collapse:collapse;font-size:14px;">
               ${fila('Recibido', fechaLegible(fecha, 'es'))}
               ${fila('Nombre', s.nombre)}
               ${fila('Email', s.email)}
               ${fila('Medio de pago', s.medioPago)}
               ${fila('N.º de operación', s.operacion)}
               ${fila('Comentario', s.comentario)}
               ${fila('Idioma', s.idioma)}
             </table>
             <p style="margin-top:16px;"><strong>Qué hacer:</strong> ${tarea}</p>
             <p style="color:#6b7280;font-size:12px;">El código ya se le mostró en pantalla al crear el pedido (Disp. 954/2025, art. 5).</p>`
        ),
    };
};
