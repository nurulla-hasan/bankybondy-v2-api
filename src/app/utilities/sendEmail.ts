/* eslint-disable @typescript-eslint/no-explicit-any */
// import nodemailer from 'nodemailer';
// import config from '../config';
// export const sendEmail = async (to: string, subject: string, html: string) => {
//   console.log('receiver email', to);
//   console.log( config.smtp.smtp_host)
//   console.log( config.smtp.smtp_pass)
//   const transporter = nodemailer.createTransport({
//     host: 'smtp.gmail.com',
//     port: 465,
//     secure: config.NODE_ENV === 'production',
//     auth: {
//       //   TODO: replace `user` and `pass` values from <https://forwardemail.net>
//       user: config.smtp.smtp_host,
//       pass: config.smtp.smtp_pass,
//     },
//   });
//   await transporter.sendMail({
//     from: 'maniksarker265@gmail.com', // sender address
//     to, // list of receivers
//     subject: subject, // Subject line
//     text: '', // plain text body
//     html, // html body
//   });
// };

import nodemailer from 'nodemailer';
import config from '../config';

const currentDate = new Date();

const formattedDate = currentDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

// Deriva una versión TEXTO PLANO del HTML. Importa para entregabilidad: Gmail
// penaliza los correos HTML-only, así que SIEMPRE se manda multipart (html + text).
// Primero se sacan head/style/script/comentarios (clave: el <style> trae la fuente
// Poppins en base64, que jamás debe filtrarse al texto), luego se convierten los
// bloques a saltos de línea y se limpian entidades/espacios.
const htmlToText = (html: string): string =>
    String(html || '')
        .replace(/<head[\s\S]*?<\/head>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(p|div|tr|h1|h2|h3|li|td)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

const sendEmail = async (options: {
    email: string;
    subject: string;
    html: any;
    from?: string; // override opcional del remitente (ej. notificaciones@ para el digest)
    text?: string; // alternativa texto plano; si no viene, se deriva del HTML
    headers?: Record<string, string>; // headers extra (ej. List-Unsubscribe del digest)
}) => {
    // Host/puerto por config (SES-ready). Si no hay SMTP_HOST, cae al Gmail de
    // siempre → no cambia el comportamiento actual. Con SES: SMTP_HOST =
    // email-smtp.<region>.amazonaws.com, SMTP_MAIL/PASS = credenciales SMTP de
    // SES, EMAIL_FROM = una dirección de tu dominio verificado.
    const host = config.smtp.smtp_host || 'smtp.gmail.com';
    const port = parseInt((config.smtp.smtp_port as string) || '465');
    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465, // 465 = TLS directo; 587 = STARTTLS
        auth: {
            user: config.smtp.smtp_mail,
            pass: config.smtp.smtp_pass,
        },
    });

    const { email, subject, html, from, text, headers } = options;

    const mailOptions = {
        from:
            from ||
            config.smtp.from ||
            `${config.smtp.name} <${config.smtp.smtp_mail}>`,
        to: email,
        date: formattedDate,
        subject,
        html,
        // Alternativa texto plano (multipart/alternative) → mejor entregabilidad.
        text: text || htmlToText(html),
        // Headers extra opcionales (ej. List-Unsubscribe/One-Click en el digest).
        ...(headers ? { headers } : {}),
    };

    // Falla CERRADA pero NO fatal. Un rechazo de SMTP (corte, throttle de
    // Gmail/SES, credencial mala, destinatario rechazado) NUNCA debe convertirse
    // en unhandledRejection: server.ts sale del proceso ante uno, así que una
    // promesa de mail suelta (registro, reset, contact-us, resend) podía tumbar
    // el server (crash-loop). Acá se atrapa y loguea: devuelve true si salió,
    // false si falló. Los flujos que NECESITAN saber si llegó pueden await-ear
    // y chequear el booleano; los fire-and-forget quedan a salvo por diseño.
    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (err) {
        console.error(
            'sendEmail failed:',
            (err as Error)?.message || err
        );
        return false;
    }
};

export default sendEmail;
