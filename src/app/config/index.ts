import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';
dotenv.config({ path: path.join(process.cwd(), '.env') });

// Fail-fast env validation: missing required vars abort startup, not runtime.
// Critical payment vars have no fallback: MercadoPago credits only via webhook,
// so without MP_WEBHOOK_SECRET users pay and are never credited — silently.
// A loud crash is better than losing money quietly.
const requiredPaymentEnvInProduction = [
    'PAYPAL_CLIENT_ID',
    'PAYPAL_CLIENT_SECRET',
    'PAYPAL_MODE',
    'PAYPAL_PAYMENT_CAPTURE_URL',
    'PAYPAL_WEBHOOK_ID',
    'MP_ACCESS_TOKEN',
    'MP_WEBHOOK_SECRET',
] as const;

// Recommended payment vars have fallbacks (MP return URLs, default webhook URL),
// so their absence only degrades UX: warn, don't abort.
const recommendedPaymentEnvInProduction = [
    'DONATION_SUCCESS_URL',
    'DONATION_CANCEL_URL',
    'MP_SUCCESS_URL',
    'MP_FAILURE_URL',
    'MP_PENDING_URL',
    'MP_WEBHOOK_URL',
] as const;

const envSchema = z
    .object({
        NODE_ENV: z
            .enum(['development', 'production', 'test'])
            .default('development'),
        PORT: z.string().default('5000'),
        DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
        BCRYPT_SALT_ROUNDS: z.string().min(1, 'BCRYPT_SALT_ROUNDS is required'),
        JWT_ACCESS_SECRET: z.string().min(1, 'JWT_ACCESS_SECRET is required'),
        JWT_REFRESH_SECRET: z.string().min(1, 'JWT_REFRESH_SECRET is required'),
        JWT_ACCESS_EXPIRES_IN: z
            .string()
            .min(1, 'JWT_ACCESS_EXPIRES_IN is required'),
        JWT_REFRESH_EXPIRES_IN: z
            .string()
            .min(1, 'JWT_REFRESH_EXPIRES_IN is required'),
        OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
    })
    .passthrough();

const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) {
    // eslint-disable-next-line no-console
    console.error(
        '\u274c Invalid environment variables:',
        parsedEnv.error.flatten().fieldErrors
    );
    process.exit(1);
}

// Production payment envs: critical ones abort, recommended ones only warn.
if (process.env.NODE_ENV === 'production') {
    const missingRequiredPayment = requiredPaymentEnvInProduction.filter(
        (k) => !process.env[k]
    );
    if (missingRequiredPayment.length) {
        // eslint-disable-next-line no-console
        console.error(
            '❌ Faltan variables de pago CRÍTICAS en producción (el cobro se rompería; sin MP_WEBHOOK_SECRET los pagos no se acreditan en silencio):',
            missingRequiredPayment.join(', ')
        );
        process.exit(1);
    }

    const missingRecommendedPayment = recommendedPaymentEnvInProduction.filter(
        (k) => !process.env[k]
    );
    if (missingRecommendedPayment.length) {
        // eslint-disable-next-line no-console
        console.warn(
            '⚠️  Variables de pago recomendadas faltantes en producción (tienen fallback; se degrada la UX de retorno):',
            missingRecommendedPayment.join(', ')
        );
    }
}

export default {
    NODE_ENV: process.env.NODE_ENV,
    port: process.env.PORT,
    redis_url: process.env.REDIS_URL,
    database_url: process.env.DATABASE_URL,
    bcrypt_salt_rounds: process.env.BCRYPT_SALT_ROUNDS,
    base_url: process.env.BASE_URL,
    default_pass: process.env.DEFAULT_PASS,
    jwt_access_secret: process.env.JWT_ACCESS_SECRET,
    jwt_refresh_secret: process.env.JWT_REFRESH_SECRET,
    jwt_access_expires_in: process.env.JWT_ACCESS_EXPIRES_IN,
    jwt_refresh_expires_in: process.env.JWT_REFRESH_EXPIRES_IN,
    reset_password_ui_link: process.env.RESET_PASSWORD_UI_LINK,
    cloudinary_cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    cloudinary_api_key: process.env.CLOUDINARY_API_KEY,
    cloudinary_api_secret: process.env.CLOUDINARY_API_SECRET,
    super_admin_email: process.env.SUPER_ADMIN_EMAIL,
    super_admin_password: process.env.SUPER_ADMIN_PASSWORD,
    google_api_key: process.env.GOOGLE_API_KEY,
    twilio: {
        accountSid: process.env.TWILIO_ACCOUNT_SID,
        authToken: process.env.TWILIO_AUTH_TOKEN,
        phoneNumber: process.env.TWILIO_PHONE_NUMBER,
    },
    smtp: {
        smtp_host: process.env.SMTP_HOST,
        smtp_port: process.env.SMTP_PORT,
        smtp_service: process.env.SMTP_SERVICE,
        smtp_mail: process.env.SMTP_MAIL,
        smtp_pass: process.env.SMTP_PASS,
        name: process.env.SERVICE_NAME,
        // "From" sender: with SES this is a verified-domain address, not the SMTP
        // user credential, e.g. "BankyBondy <hola@bankybondy.com>".
        from: process.env.EMAIL_FROM,
    },
    // Public site URL for email links (digest deep-link).
    web_url: process.env.WEB_URL || 'https://bankybondy.com',
    paypal: {
        client_id: process.env.PAYPAL_CLIENT_ID,
        client_secret: process.env.PAYPAL_CLIENT_SECRET,
        mode: process.env.PAYPAL_MODE,
        donation_success_url: process.env.DONATION_SUCCESS_URL,
        donation_cancel_url: process.env.DONATION_CANCEL_URL,
        paypal_campaign_run_payment_cancel_url:
            process.env.PAYPAL_CAMPAIGN_RUN_PAYMENT_CANCEL_URL,
        payment_capture_url: process.env.PAYPAL_PAYMENT_CAPTURE_URL,
        base_url: process.env.PAYPAL_BASE_URL,
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        paypal_onboarding_success: process.env.PAYPAL_ONBOARDING_SUCCESS,
        paypal_onboarding_failed: process.env.PAYPAL_ONBOARDING_FAILED,
    },
    mercadopago: {
        access_token: process.env.MP_ACCESS_TOKEN,
        public_key: process.env.MP_PUBLIC_KEY,
        webhook_secret: process.env.MP_WEBHOOK_SECRET,
        currency: process.env.MP_CURRENCY || 'ARS',
        price_standard: Number(process.env.MP_PRICE_STANDARD || 0),
        price_premium: Number(process.env.MP_PRICE_PREMIUM || 0),
        // Orphaned: the real source is modules/normalUser/subscriptionPlans.ts.
        // Kept only so external readers don't break — changing these has no effect.
        usd_standard: Number(process.env.MP_USD_STANDARD || 8),
        usd_premium: Number(process.env.MP_USD_PREMIUM || 15),
        dollar_rate_type: process.env.MP_DOLLAR_RATE_TYPE || 'blue',
        fallback_rate: Number(process.env.MP_FALLBACK_RATE || 0),
        success_url: process.env.MP_SUCCESS_URL || process.env.DONATION_SUCCESS_URL,
        failure_url: process.env.MP_FAILURE_URL || process.env.DONATION_CANCEL_URL,
        // Never send pending payments to the success screen: not yet credited by
        // webhook. Falls back to the neutral cancel/return URL.
        pending_url: process.env.MP_PENDING_URL || process.env.DONATION_CANCEL_URL,
        webhook_url:
            process.env.MP_WEBHOOK_URL ||
            'https://api.bankybondy.com/mercadopago-webhook',
    },
};
