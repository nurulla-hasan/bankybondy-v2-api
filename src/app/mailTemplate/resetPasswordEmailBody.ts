import { wrapEmail, codeBox, BRAND_FONT, escHtml } from './brandAssets';

// Correo de RESET de contraseña (código OTP). Misma cáscara de marca que la
// activación; cambia el título y el copy.
const resetPasswordEmailBody = (name: string, resetCode: number): string => {
    const body = `
                    <tr>
                        <td class="card px" style="background-color:#ffffff; padding:38px 44px 8px 44px;">
                            <h1 class="h1 poppins card-text" style="margin:0 0 14px 0; font-family:${BRAND_FONT}; font-size:27px; line-height:1.25; color:#0f172a; font-weight:700;">Restablecé tu contraseña</h1>
                            <p class="poppins card-text" style="margin:0 0 24px 0; font-family:${BRAND_FONT}; font-weight:400; font-size:16px; line-height:1.6; color:#475467;">¡Hola <strong style="font-weight:700;">${escHtml(
                                name
                            )}</strong>! Pediste restablecer tu contraseña en <strong class="poppins" style="font-weight:700; color:#4f46e5;">Bankybondy</strong>. Usá este código para continuar:</p>
                        </td>
                    </tr>
                    <tr>
                        <td align="center" class="px" style="padding:0 44px 8px 44px;">${codeBox(
                            resetCode
                        )}</td>
                    </tr>
                    <tr>
                        <td align="center" class="px" style="padding:16px 44px 0 44px;">
                            <p class="poppins muted" style="margin:0; font-family:${BRAND_FONT}; font-weight:400; font-size:13px; line-height:1.5; color:#667085;">El código vence en <strong style="font-weight:700; color:#475467;">5 minutos</strong>.</p>
                        </td>
                    </tr>
                    <tr>
                        <td class="px" style="padding:26px 44px 0 44px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e4e7ec; font-size:0; line-height:0;">&nbsp;</td></tr></table>
                        </td>
                    </tr>
                    <tr>
                        <td class="card px" style="background-color:#ffffff; padding:20px 44px 34px 44px;">
                            <p class="poppins muted" style="margin:0; font-family:${BRAND_FONT}; font-weight:400; font-size:13px; line-height:1.6; color:#667085;">Si no pediste restablecer tu contraseña, ignorá este mensaje — tu cuenta sigue segura.</p>
                        </td>
                    </tr>`;
    return wrapEmail({
        title: 'Restablecé tu contraseña en Bankybondy',
        preheader:
            'Tu código para restablecer la contraseña en Bankybondy vence en 5 minutos.',
        body,
        footerNote:
            'Recibiste este correo porque se pidió restablecer la contraseña de esta cuenta.',
    });
};

export default resetPasswordEmailBody;
