/* eslint-disable @typescript-eslint/no-explicit-any */
import nodemailer from 'nodemailer';
import config from '../config';

const currentDate = new Date();

const formattedDate = currentDate.toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

// Derive a plain-text version of the HTML for deliverability (Gmail penalizes
// HTML-only mail). Strips head/style/script first so the base64 Poppins font never
// leaks into the text.
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
    from?: string; // optional sender override (e.g. notifications@ for the digest)
    text?: string; // plain-text alternative; derived from the HTML if absent
    headers?: Record<string, string>; // extra headers (e.g. List-Unsubscribe)
}) => {
    // Host/port from config (SES-ready); falls back to Gmail when SMTP_HOST is unset.
    const host = config.smtp.smtp_host || 'smtp.gmail.com';
    const port = parseInt((config.smtp.smtp_port as string) || '465');
    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
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
        // Plain-text alternative (multipart/alternative) → better deliverability.
        text: text || htmlToText(html),
        // Optional extra headers (e.g. List-Unsubscribe/One-Click in the digest).
        ...(headers ? { headers } : {}),
    };

    // Fail closed but not fatal: an SMTP rejection must never become an
    // unhandledRejection (server.ts exits on those). Returns true if sent, false
    // if it failed; callers that need delivery can await and check the boolean.
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
