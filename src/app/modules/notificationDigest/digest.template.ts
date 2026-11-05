/* Plantilla del resumen/notificaciones (digest) — estética Bankybondy unificada.
 * Reusa la cáscara compartida de marca (logo exacto + Poppins incrustada + azul)
 * de mailTemplate/brandAssets. Mantiene la interfaz DigestSection y el orden de
 * secciones que arma digest.service.ts (matches/trueques/reseñas/amistades). */

import { wrapEmail, BRAND_FONT, escHtml } from '../../mailTemplate/brandAssets';

export interface DigestSection {
    label: string;
    color: string;
    count: number | null; // número en la pastilla; null → solo un punto
    line: string;
}

// Tinte suave del círculo por color de categoría (sin alpha-hex: Outlook no lo soporta).
const TINT: Record<string, string> = {
    '#1f4288': '#e8eefb', // matches (azul)
    '#0ea5e9': '#e2f4fd', // trueques (celeste)
    '#f59e0b': '#fdf2e0', // reseñas (ámbar)
    '#8b5cf6': '#efeafe', // amistades (violeta)
};
const tintFor = (c: string): string => TINT[(c || '').toLowerCase()] || '#eef2f9';

const sectionRow = (s: DigestSection, last: boolean): string => {
    const border = last ? '' : 'border-bottom:1px solid #eef1f6;';
    const badge =
        s.count === null
            ? `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background-color:${s.color};"></span>`
            : `<span style="display:inline-block;min-width:22px;height:22px;line-height:22px;padding:0 6px;border-radius:11px;background-color:${s.color};color:#ffffff;font-family:${BRAND_FONT};font-size:12px;font-weight:700;text-align:center;">${escHtml(
                  String(s.count)
              )}</span>`;
    return `
                                <tr>
                                    <td class="row" width="52" valign="top" style="padding:16px 0;${border}">
                                        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                                            <td width="40" height="40" align="center" valign="middle" style="width:40px;height:40px;background-color:${tintFor(
                                                s.color
                                            )};border-radius:50%;">${badge}</td>
                                        </tr></table>
                                    </td>
                                    <td class="row" valign="top" style="padding:16px 0 16px 14px;${border}">
                                        <div class="poppins card-text" style="font-family:${BRAND_FONT};font-size:15px;font-weight:700;color:#101828;">${escHtml(
                                            s.label
                                        )}</div>
                                        <div class="poppins muted" style="font-family:${BRAND_FONT};font-weight:400;font-size:14px;color:#475467;line-height:1.5;margin-top:2px;">${escHtml(
                                            s.line
                                        )}</div>
                                    </td>
                                </tr>`;
};

export const buildDigestHtml = (opts: {
    name?: string;
    sections: DigestSection[];
    siteUrl: string;
}): string => {
    const { name, sections, siteUrl } = opts;
    const hello = name ? `Hola ${escHtml(name)} 👋` : 'Hola 👋';
    const rows = sections
        .map((s, i) => sectionRow(s, i === sections.length - 1))
        .join('');
    const url = escHtml(siteUrl);

    const body = `
                    <tr>
                        <td class="card px" style="background-color:#ffffff; padding:34px 44px 6px 44px;">
                            <h1 class="h1 poppins card-text" style="margin:0 0 10px 0; font-family:${BRAND_FONT}; font-size:24px; line-height:1.28; color:#0f2044; font-weight:700;">${hello}</h1>
                            <p class="poppins card-text" style="margin:0; font-family:${BRAND_FONT}; font-weight:400; font-size:15px; line-height:1.6; color:#475467;">Esto es lo que pasó en tu mundo <strong class="poppins" style="font-weight:700; color:#1f4288;">Bankybondy</strong>:</p>
                        </td>
                    </tr>
                    <tr>
                        <td class="px" style="padding:18px 44px 6px 44px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td class="px" align="center" style="padding:26px 44px 30px 44px;">
                            <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:48px;v-text-anchor:middle;width:230px;" arcsize="29%" strokecolor="#1f4288" fillcolor="#1f4288"><w:anchorlock/><center style="color:#ffffff;font-family:Segoe UI,Arial,sans-serif;font-size:15px;font-weight:bold;">Ver en Bankybondy</center></v:roundrect><![endif]-->
                            <!--[if !mso]><!-->
                            <a href="${url}" class="poppins" style="display:inline-block; background-color:#1f4288; background-image:linear-gradient(135deg,#1f4288 0%,#2b7fff 130%); color:#ffffff; font-family:${BRAND_FONT}; font-weight:700; font-size:15px; line-height:1; text-decoration:none; padding:16px 34px; border-radius:14px;">Ver en Bankybondy</a>
                            <!--<![endif]-->
                            <div class="poppins muted" style="font-family:${BRAND_FONT}; font-weight:400; font-size:12px; color:#98a2b3; margin-top:14px;">Iniciás sesión en bankybondy.com como siempre — este correo no te pide ningún dato.</div>
                        </td>
                    </tr>`;

    return wrapEmail({
        title: 'Tus novedades en Bankybondy',
        preheader:
            'Tus novedades en Bankybondy: matches, trueques, reseñas y amistades.',
        body,
        footerNote:
            'Recibís este resumen porque tenés novedades y notificaciones activas en Bankybondy. Podés elegir qué te avisamos desde la campana.',
    });
};

export default buildDigestHtml;
