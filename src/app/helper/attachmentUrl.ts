/* eslint-disable @typescript-eslint/no-explicit-any */
/* Validación de URLs de adjuntos de chat.
 *
 * Los adjuntos legítimos se suben por REST a nuestro S3 y se sirven SIEMPRE desde
 * nuestro CloudFront (`getCloudFrontUrl` = `${CLOUDFRONT_URL}/<key>`). El socket
 * `send-message`, en cambio, recibía `data.imageUrl/videoUrl/pdfUrl` CRUDOS del
 * cliente y los guardaba tal cual → un cliente malicioso podía inyectar CUALQUIER
 * URL (phishing / malware / rastreo por beacon) como "adjunto" del chat.
 *
 * Acá exigimos que cada URL sea de NUESTRO CDN: host EXACTO, parseado con
 * `new URL()` para ignorar query/fragment (mismo criterio endurecido que
 * `deleteFromS3`, que frena bypass tipo `https://evil.com/x?u=cdn/...`). Fail-closed:
 * si CLOUDFRONT_URL no está o la URL no matchea, se descarta (no se guarda).
 *
 * Funciones PURAS (el host del CDN se puede inyectar) → testeables en runTests.
 */

const cdnHostFromEnv = (): string | null => {
    try {
        return new URL(process.env.CLOUDFRONT_URL as string).host;
    } catch {
        return null;
    }
};

// ¿`value` es una URL de adjunto servida por NUESTRO CloudFront?
export const isCdnAttachmentUrl = (
    value: unknown,
    cdnHost: string | null = cdnHostFromEnv()
): boolean => {
    if (typeof value !== 'string' || !cdnHost) return false;
    let u: URL;
    try {
        u = new URL(value);
    } catch {
        return false; // no es una URL absoluta válida
    }
    if (u.protocol !== 'https:') return false; // sin http/data/javascript/etc.
    if (u.host !== cdnHost) return false; // host EXACTO (no subdominio ni path)
    // La propiedad de seguridad es el HOST: si es nuestro CDN, el contenido es
    // nuestro (no hay phishing/malware). El path no hace falta validarlo acá
    // (y `new URL` ya normaliza los `..`); el borrado en S3 tiene su propio guard.
    return true;
};

// Deja SOLO las URLs válidas del CDN de un adjunto (array del cliente).
// Acepta array, string suelto o null; siempre devuelve un array saneado.
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
    // Lo que se guarda, con las mismas claves que `data` del socket.
    kept: Record<AttachmentField, string[]>;
    // Cuántos adjuntos se fueron a la basura, por tipo, para poder decírselo.
    dropped: Record<AttachmentField, number>;
    // `CLOUDFRONT_URL` ausente o inválido: se descarta TODO por fail-closed.
    cdnUnconfigured: boolean;
    // El cliente mandó adjuntos (válidos o no); sirve para distinguirse de "sin adjuntos".
    requested: number;
};

/*
 * Reparte los adjuntos en "guardable" y "descartado", con conteo.
 *
 * Por qué no basta `filterCdnAttachmentUrls`: el filtro tiraba lo que no pasaba
 * SIN DECIR NADA, y el bubble del cliente quedaba "enviado" con el archivo
 * perdido para siempre. El contador es la única señal para emitir
 * `attachment-rejected` y para rechazar por adelantado el mensaje que se queda
 * sin texto Y sin adjuntos (que antes se guardaba vacío e invisible).
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
