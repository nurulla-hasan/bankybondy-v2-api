/* eslint-disable @typescript-eslint/no-explicit-any */
/* Chat attachment URL validation: only URLs served by our own CloudFront are
 * accepted (the socket used to store raw client URLs → phishing/malware). Host
 * match is exact and fail-closed; CLOUDFRONT_URL can be injected for tests.
 */

const cdnProtocolFromEnv = (): string => {
    try {
        const u = new URL(process.env.CLOUDFRONT_URL as string);
        return u.protocol || 'https:';
    } catch {
        return 'https:';
    }
};

const cdnHostFromEnv = (): string | null => {
    try {
        return new URL(process.env.CLOUDFRONT_URL as string).host;
    } catch {
        return null;
    }
};

// Is `value` an attachment URL served by our CloudFront?
export const isCdnAttachmentUrl = (
    value: unknown,
    cdnHost: string | null = cdnHostFromEnv()
): boolean => {
    if (typeof value !== 'string' || !cdnHost) return false;
    let u: URL;
    try {
        u = new URL(value);
    } catch {
        return false; // not a valid absolute URL
    }

    let targetHost = cdnHost;
    let expectedProtocol = 'https:';

    if (cdnHost.includes('://')) {
        try {
            const parsed = new URL(cdnHost);
            targetHost = parsed.host;
            expectedProtocol = parsed.protocol;
        } catch {
            expectedProtocol = cdnProtocolFromEnv();
        }
    } else {
        expectedProtocol = cdnProtocolFromEnv();
    }

    if (u.protocol !== expectedProtocol) return false;
    if (u.host !== targetHost) return false; // exact host (no subdomain/path tricks)
    // The security property is the HOST; path is left to the S3 delete guard.
    return true;
};

// Keeps only valid CDN URLs from a client attachment value (array, string or null).
export const filterCdnAttachmentUrls = (
    value: unknown,
    cdnHost?: string | null
): string[] => {
    const host = cdnHost === undefined ? cdnHostFromEnv() : cdnHost;
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    return list.filter((v): v is string => isCdnAttachmentUrl(v, host));
};

export const ATTACHMENT_FIELDS = ['imageUrl', 'videoUrl', 'pdfUrl'] as const;
export type AttachmentField = (typeof ATTACHMENT_FIELDS)[number];

export type AttachmentPartition = {
    // Accepted URLs, keyed like the socket `data`.
    kept: Record<AttachmentField, string[]>;
    // Dropped count per field, so the client can be told.
    dropped: Record<AttachmentField, number>;
    // `CLOUDFRONT_URL` missing or invalid: everything is dropped (fail-closed).
    cdnUnconfigured: boolean;
    // Attachments the client sent (valid or not); distinguishes "none sent".
    requested: number;
};

/*
 * Splits attachments into kept/dropped with counts.
 *
 * The count is the only signal to emit `attachment-rejected` and to reject a
 * message left with neither text nor attachments (previously stored empty).
 */
export const partitionAttachmentUrls = (
    data: Record<string, any> | null | undefined,
    cdnHost?: string | null
): AttachmentPartition => {
    const host = cdnHost === undefined ? cdnHostFromEnv() : cdnHost;
    const kept = {} as Record<AttachmentField, string[]>;
    const dropped = {} as Record<AttachmentField, number>;
    let requested = 0;

    for (const field of ATTACHMENT_FIELDS) {
        const value = data?.[field];
        const list = Array.isArray(value) ? value : value == null ? [] : [value];
        requested += list.length;
        const accepted = list.filter((v): v is string => isCdnAttachmentUrl(v, host));
        kept[field] = accepted;
        dropped[field] = list.length - accepted.length;
    }

    return { kept, dropped, cdnUnconfigured: !host, requested };
};
