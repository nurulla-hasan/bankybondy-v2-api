import OpenAI from 'openai';

// Techo de tiempo, igual que isTextSafe.ts: los defaults del SDK (openai 6.45)
// son 600 s y 2 reintentos, o sea hasta ~30 MINUTOS colgado por vínculo
// publicado con OpenAI degradado, porque el alta espera el embedding. Con esto el
// techo es ~30 s (dos intentos de 15) y después el alta falla con un error.
const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, // keep it secret in .env
    timeout: 15000,
    maxRetries: 1,
});

export const generateEmbedding = async (text: string): Promise<number[]> => {
    if (!text || !text.trim()) return [];
    const response = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
    });
    return response.data[0].embedding;
};
