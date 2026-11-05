/* eslint-disable no-console */
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

// Firma una URL de CloudFront si hay key pair configurado; si no,
// devuelve la URL directa (comportamiento actual, sin romper nada).
export const getMediaUrl = (url?: string): string => {
    if (!url) return url ?? '';
    const keyPairId = process.env.CLOUDFRONT_KEY_PAIR_ID;
    const privateKey = process.env.CLOUDFRONT_PRIVATE_KEY;
    if (!keyPairId || !privateKey) return url;
    try {
        const dateLessThan = new Date(
            Date.now() + 60 * 60 * 1000 // válida 1 hora
        ).toISOString();
        return getSignedUrl({
            url,
            keyPairId,
            // permite pegar la clave con \n escapados en el .env
            privateKey: privateKey.replace(/\\n/g, '\n'),
            dateLessThan,
        });
    } catch (err) {
        console.error('CloudFront signing failed, returning direct URL:', err);
        return url;
    }
};
