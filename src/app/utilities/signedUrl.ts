/* eslint-disable no-console */
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

// Signs a CloudFront URL when a key pair is configured; otherwise returns the
// direct URL unchanged.
export const getMediaUrl = (url?: string): string => {
    if (!url) return url ?? '';
    const keyPairId = process.env.CLOUDFRONT_KEY_PAIR_ID;
    const privateKey = process.env.CLOUDFRONT_PRIVATE_KEY;
    if (!keyPairId || !privateKey) return url;
    try {
        const dateLessThan = new Date(
            Date.now() + 60 * 60 * 1000 // valid 1 hour
        ).toISOString();
        return getSignedUrl({
            url,
            keyPairId,
            // allows the key to be pasted with escaped \n in .env
            privateKey: privateKey.replace(/\\n/g, '\n'),
            dateLessThan,
        });
    } catch (err) {
        console.error('CloudFront signing failed, returning direct URL:', err);
        return url;
    }
};
