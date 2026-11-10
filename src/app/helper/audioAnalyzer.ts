/* eslint-disable no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import os from 'node:os';
import OpenAI from 'openai';
import path from 'path';
import { pipeline } from 'node:stream/promises';

// ffmpeg path must be explicit under PM2; Windows has no /usr/bin/ffmpeg, so fall
// back to PATH there. Override with AUDIO_FFMPEG_PATH.
const FFMPEG_PATH =
    process.env.AUDIO_FFMPEG_PATH ||
    (process.platform === 'win32' ? 'ffmpeg' : '/usr/bin/ffmpeg');
ffmpeg.setFfmpegPath(FFMPEG_PATH);

// os.tmpdir(): `/tmp` becomes C:\tmp on Windows, which doesn't exist and would make
// every analysis fail before OpenAI is reached.
const TEMP_DIR = os.tmpdir();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// OpenAI transcription rejects files over 25 MB; 24 MiB leaves multipart margin.
const TOPE_TRANSCRIPCION_BYTES = 24 * 1024 * 1024;

// convert any audio -> mp3
//
// Explicit bitrate/channels: libmp3lame's default (~128 kbps stereo) barely
// compressed; 64 kbps mono is plenty for voice (~50 min inside 24 MiB).
//
// Hard time cap with forced kill: fluent-ffmpeg has no timeout, so a hung process
// never settles and leaves the sweep's `running` flag stuck forever, disabling the
// rescue path for the whole process. SIGKILL, and no `.duration()` input trimming,
// which would moderate only the start of the talk. 20 min because the guard targets
// indefinite hangs, and a short cap could kill legitimately long talks.
const FFMPEG_TIMEOUT_MS =
    Number(process.env.AUDIO_FFMPEG_TIMEOUT_MS) || 20 * 60 * 1000;

const convertToMp3 = (inputPath: string, outputPath: string) => {
    return new Promise<void>((resolve, reject) => {
        let reloj: NodeJS.Timeout | null = null;
        const pararReloj = () => {
            if (reloj) {
                clearTimeout(reloj);
                reloj = null;
            }
        };

        const cmd = ffmpeg(inputPath)
            .toFormat('mp3')
            .audioBitrate(64)
            .audioChannels(1)
            .on('end', () => {
                pararReloj();
                resolve();
            })
            .on('error', (err: any) => {
                pararReloj();
                reject(err);
            });

        reloj = setTimeout(() => {
            reloj = null;
            // Reject here first so the reason is the timeout, not ffmpeg's kill error.
            try {
                cmd.kill('SIGKILL');
            } catch {
                /* already gone */
            }
            reject(
                new Error(
                    `La conversión del audio superó ${Math.round(
                        FFMPEG_TIMEOUT_MS / 1000
                    )} s y se abortó.`
                )
            );
        }, FFMPEG_TIMEOUT_MS);

        cmd.save(outputPath);
    });
};

export const analyzeConversationAudio = async (audioUrl: string) => {
    const ext = path.extname(audioUrl) || '.mp3';
    const originalPath = path.join(TEMP_DIR, `audio-${Date.now()}${ext}`);
    let finalAudioPath = originalPath;
    let mp3Path = '';

    try {
        const response: any = await axios({
            url: audioUrl,
            method: 'GET',
            responseType: 'stream',
            // Required timeout: `pipeline` rejects on error, not on silence, so a
            // stalled source left the promise (and cleanup) hanging; axios defaults to 0.
            timeout: Number(process.env.AUDIO_DOWNLOAD_TIMEOUT_MS) || 120_000,
        });

        // Leak fix: piping into the destination and listening only to its
        // 'finish'/'error' hung forever when S3 aborted mid-stream (the source error
        // was swallowed), so `finally` never ran and each retry leaked an fd and a
        // temp file. `pipeline` watches both ends and rejects.
        await pipeline(response.data, fs.createWriteStream(originalPath));

        // Transcode on format OR size: non-mp3 and >24 MiB files previously reached
        // OpenAI and were always rejected, then retried until the sweep gave up.
        const tamOriginal = fs.statSync(originalPath).size;
        if (
            ext.toLowerCase() !== '.mp3' ||
            tamOriginal > TOPE_TRANSCRIPCION_BYTES
        ) {
            mp3Path = path.join(TEMP_DIR, `audio-${Date.now()}.mp3`);
            await convertToMp3(originalPath, mp3Path);
            finalAudioPath = mp3Path;
        }

        // Fail fast here instead of letting OpenAI answer with an opaque 400. This
        // reason only reaches the operator log, not the user (v1.1: code + i18n).
        const tamFinal = fs.statSync(finalAudioPath).size;
        if (tamFinal > TOPE_TRANSCRIPCION_BYTES) {
            throw new Error(
                `El audio pesa ${Math.round(tamFinal / 1024 / 1024)} MB después de ` +
                    `comprimirlo a 64 kbps mono y el máximo para transcribir es 24 MB. ` +
                    `Son cerca de 50 minutos de charla: hay que partirla en partes más cortas.`
            );
        }

        // send to OpenAI transcription
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(finalAudioPath),
            model: 'gpt-4o-mini-transcribe',
        });

        const transcript = transcription.text;

        // analyze conversation using OpenAI Chat
        const analysis = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            temperature: 0,
            messages: [
                {
                    role: 'system',
                    content: `
You are a moderation system for conversation audios. Analyze the transcript for TWO things:

1) valid_conversation: true ONLY if it is a real conversation between multiple people (dialogue). Set false if it is: music, lyrics, a single speaker, narration, or a podcast monologue.

2) prohibited_content: true if the transcript contains ANY prohibited content: sexual content, drug-related crimes, weapons, violence, or the depiction or promotion of any crime.

Return JSON only:
{
 "valid_conversation": true | false,
 "prohibited_content": true | false,
 "speaker_count_estimate": number,
 "reason": "short explanation"
}
`,
                },
                {
                    role: 'user',
                    content: transcript,
                },
            ],
        });

        const result = JSON.parse(analysis.choices[0].message.content || '{}');

        // Content verdict vs. technical failure: both dimensions must be explicit
        // booleans, else treat it as technical. A missing `prohibited_content` used
        // to approve audios nobody had judged (fail-open).
        if (
            typeof result?.valid_conversation !== 'boolean' ||
            typeof result?.prohibited_content !== 'boolean'
        ) {
            throw new Error(
                'Moderation returned no valid content verdict (malformed AI response)'
            );
        }

        return {
            transcript,
            ...result,
        };
    } catch (error: any) {
        console.error('FULL ERROR:', error);
        console.error('MESSAGE:', error?.message);
        console.error('STACK:', error?.stack);

        throw new Error(error?.message || 'Failed to process audio');
    } finally {
        // cleanup temp files
        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
    }
};
