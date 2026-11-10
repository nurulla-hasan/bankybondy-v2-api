import OpenAI from 'openai';

// Hard time cap: SDK defaults (600 s, 2 retries) could stall signup for ~30 min
// on a degraded OpenAI; this bounds it to ~30 s.
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
