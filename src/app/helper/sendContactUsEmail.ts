import { Request, Response } from 'express';
import { z } from 'zod';
import sendEmail from '../utilities/sendEmail';

// Escape HTML: these four public-form fields go raw into the support inbox.
const escapeHtml = (s: string): string =>
    s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

// Length caps and email format keep public requests bounded.
const contactUsValidationSchema = z.object({
    body: z.object({
        name: z
            .string({ required_error: 'Name is required' })
            .trim()
            .min(1, 'Name is required')
            .max(100, 'Name is too long'),
        email: z
            .string({ required_error: 'Email is required' })
            .trim()
            .email('Invalid email')
            .max(254, 'Email is too long'),
        phone: z
            .string({ required_error: 'Phone number is required' })
            .trim()
            .max(40, 'Phone number is too long'),
        message: z
            .string({ required_error: 'Message is required' })
            .trim()
            .min(1, 'Message is required')
            .max(5000, 'Message is too long'),
    }),
});

const sendContactUsEmail = async (req: Request, res: Response) => {
    try {
        contactUsValidationSchema.parse(req);

        const { name, phone, email, message } = req.body;

        // `await` required: an unhandled rejection could crash the process, and
        // the response must reflect the real send result.
        const ok = await sendEmail({
            email: 'bankybondyar@gmail.com',
            // Subject also carries the escaped name.
            subject: `📩 New Contact Message from ${escapeHtml(name)}`,
            html: contactUsEmailTemplate({ name, phone, email, message }),
        });

        if (!ok) {
            res.status(502).json({
                error: 'No pudimos enviar tu mensaje. Probá de nuevo en un rato.',
            });
            return;
        }

        res.status(200).json({ message: 'Contact email sent successfully' });
    } catch (error) {
        const errorMessage =
            error instanceof Error
                ? error.message
                : 'An unexpected error occurred';
        res.status(400).json({ error: errorMessage });
    }
};

const contactUsEmailTemplate = ({
    name,
    phone,
    email,
    message,
}: {
    name: string;
    phone: string;
    email: string;
    message: string;
}) => `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Contact Message</title>
</head>

<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:Arial,Helvetica,sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8;padding:30px 0;">
  <tr>
    <td align="center">

      <!-- Container -->
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 15px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:25px;text-align:center;">
            <h1 style="color:#ffffff;margin:0;font-size:24px;">
              📬 New Contact Message
            </h1>
            <p style="color:#e0e7ff;margin:5px 0 0 0;font-size:14px;">
              You have received a new message from your website
            </p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:30px;">

            <table width="100%" cellpadding="0" cellspacing="0">

              <!-- Name -->
              <tr>
                <td style="padding:12px 0;border-bottom:1px solid #eee;">
                  <strong style="color:#6b7280;">👤 Name:</strong><br/>
                  <span style="font-size:16px;color:#111827;">${escapeHtml(name)}</span>
                </td>
              </tr>

              <!-- Email -->
              <tr>
                <td style="padding:12px 0;border-bottom:1px solid #eee;">
                  <strong style="color:#6b7280;">📧 Email:</strong><br/>
                  <span style="font-size:16px;color:#111827;">${escapeHtml(email)}</span>
                </td>
              </tr>

              <!-- Phone -->
              <tr>
                <td style="padding:12px 0;border-bottom:1px solid #eee;">
                  <strong style="color:#6b7280;">📱 Phone:</strong><br/>
                  <span style="font-size:16px;color:#111827;">${escapeHtml(phone)}</span>
                </td>
              </tr>

              <!-- Message -->
              <tr>
                <td style="padding:20px 0;">
                  <strong style="color:#6b7280;">💬 Message:</strong>
                  <div style="
                    margin-top:10px;
                    background:#f9fafb;
                    padding:15px;
                    border-radius:8px;
                    border-left:4px solid #4f46e5;
                    color:#111827;
                    line-height:1.6;
                    white-space:pre-line;
                  ">
                    ${escapeHtml(message)}
                  </div>
                </td>
              </tr>

            </table>

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:20px;text-align:center;font-size:12px;color:#6b7280;">
            This message was sent from your website contact form.<br/>
            © ${new Date().getFullYear()} Your Company. All rights reserved.
          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>

</body>
</html>
`;

export default sendContactUsEmail;
