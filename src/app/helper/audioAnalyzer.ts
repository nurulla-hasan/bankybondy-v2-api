/* eslint-disable no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import OpenAI from 'openai';
import path from 'path';
import { pipeline } from 'node:stream/promises';

// Ensure ffmpeg path is set (important when running via PM2)
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// TOPE DE LA TRANSCRIPCIÓN. El endpoint de OpenAI rechaza archivos de más de
// 25 MB. Se trabaja con 24 MiB para dejar margen al multipart.
const TOPE_TRANSCRIPCION_BYTES = 24 * 1024 * 1024;

// convert any audio -> mp3
//
// BITRATE Y CANALES EXPLÍCITOS. Sin ellos, libmp3lame usaba su default (~128 kbps
// estéreo) y "convertir" casi no comprimía: un archivo grande seguía grande. A
// 64 kbps mono —de sobra para voz, que es todo lo que hay acá— 24 MiB dan cerca
// de 50 minutos de charla.
//
// (Una versión anterior de este comentario decía que eso deja margen "holgado"
// sobre el máximo de 45 minutos del producto. Se sacó: ese máximo es una promesa
// de comunicación y NINGÚN código lo impone — el zod acepta `duration` sin tope y
// el único límite real son 50 MB. Un comentario no se puede apoyar en una regla
// que el código no tiene.)
// TECHO DE TIEMPO CON MUERTE FORZADA. Es la guarda más importante de este archivo
// y la puso el panel del 26/9.
//
// `fluent-ffmpeg` no tiene timeout propio: si el proceso se cuelga —entrada
// dañada, disco lento, un códec que entra en bucle— la promesa NUNCA resuelve ni
// rechaza. Y esta función se llama desde `processAudioModeration`, que el barrido
// de audio ejecuta detrás de un flag `running`: un solo ffmpeg colgado deja ese
// flag en `true` **para siempre**, y a partir de ahí la moderación de audio no
// rescata a NADIE más en ese proceso, sin un error, sin un log, sin nada.
//
// El agravante es que todo lo demás que se arregló acá se apoya en ese rescate:
// el veredicto descartado por el sello cuenta con que el barrido vuelva a pasar.
// Sin este techo, el arreglo dependería de la pieza que él mismo puede apagar.
//
// Se mata con SIGKILL y no se acota la entrada con `.duration()`: truncar el
// archivo que se va a analizar abriría un agujero de moderación — se moderaría
// sólo el principio de la charla.
// POR QUÉ 20 MINUTOS Y NO 5 (segunda ronda del panel, 26/9). El propósito de esta
// guarda es un proceso COLGADO —tiempo NO acotado—, y eso lo cierra igual
// cualquier valor finito. El 5 no se derivaba de nada: ni de
// AUDIO_STUCK_MINUTES (10), ni del timeout de descarga (120 s), ni del SDK de
// OpenAI (10 min por intento). Y la asimetría se inclina fuerte para el lado de
// subirlo: dejarlo corto puede convertir una charla larga que HOY publica en un
// fallo permanente, con mensaje opaco, en el producto estrella.
//
// El costo de subirlo NO es cero, y conviene decirlo: el barrido de audio corre
// SERIAL detrás de un flag `running`, así que si la pasada colgada es la del
// propio barrido, la red de rescate queda detenida —para todos— hasta que este
// techo la libere. Contra lo que hay hoy en producción, que no tiene ningún
// techo y la deja detenida PARA SIEMPRE, sigue siendo una mejora estricta.
//
// El número sigue siendo a ciegas mientras la entrada no tenga tope de duración
// (sólo hay tope de bytes: 50 MB, que en el formato del grabador del navegador
// pueden ser una o dos horas). Queda pendiente MEDIR ffmpeg en el servidor con el
// archivo más largo que exista antes de confiar en el margen.
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
            // `kill` dispara 'error', que va a llamar a reject otra vez: la promesa
            // ya está resuelta y el segundo intento se ignora. Se rechaza acá igual
            // para que el motivo sea el timeout y no lo que reporte ffmpeg al morir.
            try {
                cmd.kill('SIGKILL');
            } catch {
                /* ya no existía */
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
    // detect extension from url
    const ext = path.extname(audioUrl) || '.mp3';
    const originalPath = path.join('/tmp', `audio-${Date.now()}${ext}`);
    let finalAudioPath = originalPath;
    let mp3Path = '';

    try {
        // download audio from S3
        const response: any = await axios({
            url: audioUrl,
            method: 'GET',
            responseType: 'stream',
            // TIMEOUT OBLIGATORIO (10/9, panel adversarial). `pipeline` rechaza
            // ante ERROR, no ante SILENCIO: se midió que contra un origen que
            // manda un byte y se calla, la promesa seguía colgada y el `finally`
            // de limpieza no corría — o sea, la fuga de fd + /tmp seguía intacta
            // para el caso de stall. El default de axios es 0, sin límite.
            // Con S3 medio muerto esto componía igual que antes, porque
            // `audio.sweep` reintenta.
            timeout: Number(process.env.AUDIO_DOWNLOAD_TIMEOUT_MS) || 120_000,
        });

        // FUGA DE RECURSOS, TAPADA (10/9). Antes esto era:
        //     response.data.pipe(writer);
        //     await new Promise((res, rej) => {
        //         writer.on('finish', res); writer.on('error', rej);
        //     });
        // La promesa escuchaba sólo al DESTINO. Si la descarga desde S3 se cortaba
        // a mitad (reset de TCP, timeout), el stream de ORIGEN emitía su error
        // —axios ya le pone listener, así que NO explotaba— pero el `writer` nunca
        // llegaba a 'finish' ni a 'error': **la promesa quedaba colgada PARA
        // SIEMPRE**. Consecuencia medida: el `finally` de limpieza de más abajo
        // nunca corría → se fugaba un descriptor de archivo y un temporal de /tmp
        // en CADA descarga cortada.
        //
        // Y componía: `audio.sweep.ts` rescata los audios clavados en 'processing'
        // y vuelve a llamar a esta función, fugando otro fd y otro /tmp en cada
        // reintento, hasta agotar los reintentos.
        //
        // `pipeline` escucha a los DOS extremos y rechaza si cualquiera falla, así
        // que el error entra al `catch` de esta función y el `finally` limpia.
        await pipeline(response.data, fs.createWriteStream(originalPath));

        // SE TRANSCODIFICA POR FORMATO **O POR TAMAÑO**, y éste es el arreglo del
        // fracaso más caro que tenía "Estamos charlando".
        //
        // Antes la condición era sólo `ext !== '.mp3'`, así que un mp3 NUNCA se
        // tocaba, y no había ningún control de tamaño en todo el camino — mientras
        // el uploader acepta 50 MB. Como OpenAI rechaza todo lo que pase 25 MB,
        // una charla de más de ~11 minutos grabada a 320 kbps, o de ~27 minutos a
        // 128 kbps, fallaba **siempre**. Y fallaba en silencio: el audio quedaba
        // en `failed`, el sweep lo reintentaba cinco veces con media hora de
        // espera —quemando la misma descarga y el mismo ffmpeg cada vez— y después
        // se rendía. La persona nunca se enteraba de por qué su charla no aparecía,
        // y el largo era justo el único dato con el que podría haberla partido.
        //
        // En un producto que se llama "Estamos charlando", la charla larga no es
        // el borde: es el caso.
        const tamOriginal = fs.statSync(originalPath).size;
        if (
            ext.toLowerCase() !== '.mp3' ||
            tamOriginal > TOPE_TRANSCRIPCION_BYTES
        ) {
            mp3Path = path.join('/tmp', `audio-${Date.now()}.mp3`);
            await convertToMp3(originalPath, mp3Path);
            finalAudioPath = mp3Path;
        }

        // COMPUERTA EXPLÍCITA. Si ni comprimido entra, se falla ACÁ y rápido, en
        // vez de mandarlo igual para que OpenAI lo rechace con un 400 opaco.
        //
        // OJO CON LO QUE ESTE MOTIVO **NO** HACE, que el panel del 26/9 me corrigió:
        // el texto nombra el largo, pero va al LOG DEL OPERADOR, no a la pantalla.
        // El catch técnico de `processAudioModeration` lo pisa con un mensaje
        // genérico, y la pantalla de subida, en la rama 'failed', ni siquiera lee
        // `moderationReason`. O sea: quien suba una charla de más de ~50 minutos
        // sigue viendo el mismo fallo opaco de antes. Propagar el motivo hasta el
        // usuario es trabajo de producto (código de motivo + clave de i18n) y queda
        // anotado para v1.1.
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

        // Distinguir veredicto de CONTENIDO de fallo TECNICO: solo consideramos
        // que hay dictamen valido si la IA devolvio un boolean explicito en AMBAS
        // dimensiones: valid_conversation Y prohibited_content. Si CUALQUIERA viene
        // ausente/malformada, es un fallo tecnico (respuesta rara del modelo) y lo
        // tratamos como excepcion, para NO aprobar sin veredicto de contenido
        // (fail-open) ni rechazar/borrar un audio valido por un problema del
        // pipeline. Antes solo se exigia valid_conversation: si la IA devolvia
        // valid_conversation:true sin prohibited_content, `!undefined` daba true y
        // el audio se APROBABA sin que nadie hubiera dictaminado el contenido.
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
