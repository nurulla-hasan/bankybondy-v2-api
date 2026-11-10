/* eslint-disable @typescript-eslint/no-explicit-any */
import {
    S3Client,
    HeadObjectCommand,
    DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
dotenv.config();

// Initialize the S3 client
const s3 = new S3Client({
    region: process.env.AWS_REGION!,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
});

export const deleteFileFromS3 = async (fileName: string) => {
    // Security: derive the key only from the parsed URL pathname, never from a
    // split on the raw string — the query string could smuggle another user's key
    // past the controller's owner check. Require the exact CLOUDFRONT_URL host;
    // query/fragment are ignored by construction.
    if (typeof fileName !== 'string') {
        console.error('deleteFileFromS3: entrada inválida, se ignora.');
        return;
    }
    let url: URL;
    let cdnHost: string;
    try {
        url = new URL(fileName);
        cdnHost = new URL(process.env.CLOUDFRONT_URL as string).host;
    } catch {
        console.error('deleteFileFromS3: URL/CDN inválida, se ignora:', fileName);
        return;
    }
    if (url.host !== cdnHost) {
        console.error('deleteFileFromS3: host no-CDN, se ignora:', fileName);
        return;
    }
    let decodedFileName: string;
    try {
        decodedFileName = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
        console.error('deleteFileFromS3: key mal codificada, se ignora.');
        return;
    }
    if (!decodedFileName || decodedFileName.includes('..')) {
        console.error('deleteFileFromS3: key vacía/sospechosa, se ignora.');
        return;
    }
    const bucket = process.env.AWS_S3_BUCKET_NAME!;

    try {
        const headCommand = new HeadObjectCommand({
            Bucket: bucket,
            Key: decodedFileName,
        });

        try {
            await s3.send(headCommand);
        } catch (err: any) {
            if (err.name === 'NotFound') {
                console.log(`File ${decodedFileName} does not exist in S3.`);
                return;
            }
            throw err;
        }

        const deleteCommand = new DeleteObjectCommand({
            Bucket: bucket,
            Key: decodedFileName,
        });

        await s3.send(deleteCommand);
        console.log(`Successfully deleted ${decodedFileName} from S3`);
    } catch (err: any) {
        if (err.name === 'NotFound') {
            console.error(`File ${decodedFileName} was not found in S3.`);
        } else {
            console.error('Error deleting file from S3:', err);
        }
    }
};
