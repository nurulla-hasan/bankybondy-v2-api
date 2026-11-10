import { wrapEmail, codeBox, BRAND_FONT, escHtml } from './brandAssets';

// Account ACTIVATION email (OTP code), Bankybondy branding via brandAssets.
// Called from signup and resend.
const registrationSuccessEmailBody = (
    name: string,
    activationCode: number
): string => {
    const body = `
                    <tr>
                        <td class="card px" style="background-color:#ffffff; padding:38px 44px 8px 44px;">
                            <h1 class="h1 poppins card-text" style="margin:0 0 14px 0; font-family:${BRAND_FONT}; font-size:27px; line-height:1.25; color:#0f172a; font-weight:700;">Activá tu cuenta</h1>
                            <p class="poppins card-text" style="margin:0 0 24px 0; font-family:${BRAND_FONT}; font-weight:400; font-size:16px; line-height:1.6; color:#475467;">¡Hola <strong style="font-weight:700;">${escHtml(
                                name
                            )}</strong>! Gracias por sumarte a <strong class="poppins" style="font-weight:700; color:#4f46e5;">Bankybondy</strong>. Usá este código para verificar tu correo y activar tu cuenta:</p>
                        </td>
                    </tr>
                    <tr>
                        <td align="center" class="px" style="padding:0 44px 8px 44px;">${codeBox(
                            activationCode
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
                            <p class="poppins muted" style="margin:0; font-family:${BRAND_FONT}; font-weight:400; font-size:13px; line-height:1.6; color:#667085;">Si no creaste una cuenta en <strong class="poppins" style="font-weight:700; color:#667085;">Bankybondy</strong>, podés ignorar este mensaje — no se hará nada con tu correo.</p>
                        </td>
                    </tr>`;
    return wrapEmail({
        title: 'Activá tu cuenta en Bankybondy',
        preheader:
            'Tu código para activar la cuenta en Bankybondy vence en 5 minutos.',
        subtitle: 'Intercambiá lo que tenés por lo que buscás.',
        body,
        footerNote:
            'Este correo se envió porque tu dirección se usó para registrarse en Bankybondy.',
    });
};

export default registrationSuccessEmailBody;
