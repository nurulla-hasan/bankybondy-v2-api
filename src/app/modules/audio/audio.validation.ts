import { z } from 'zod';
import { isValidFeelingTag } from './feelingTags';

// Feedback del oyente: texto opcional (<=500) y/o feeling tags del vocabulario
// controlado. Se rechaza solo si AMBOS vienen vacios (nada que guardar). La
// validacion de subconjunto del vocabulario tambien se repite en el servicio.
export const giveAudioFeedbackValidationSchema = z.object({
    body: z
        .object({
            text: z
                .string()
                .trim()
                .max(500, { message: 'Text cannot exceed 500 characters' })
                .optional(),
            feelingTags: z
                .array(
                    z.string().refine((val) => isValidFeelingTag(val), {
                        message: 'Invalid feeling tag',
                    })
                )
                .optional(),
        })
        .refine(
            (data) =>
                (data.text && data.text.trim().length > 0) ||
                (Array.isArray(data.feelingTags) &&
                    data.feelingTags.length > 0),
            {
                message:
                    'Provide at least a text comment or one feeling tag',
            }
        ),
});

export const createAudioValidationSchema = z.object({
    body: z.object({
        audioTopic: z.string().length(24, 'Invalid audioTopic ID'),
        title: z.string({ required_error: 'Title is required' }),
        description: z.string({ required_error: 'Description is required' }),
        // URL ya staged por /upload-audio (subida en dos pasos). El controller
        // valida host, prefijo del dueño y que no esté publicada.
        audio_url: z.string().optional(),
        cover_image: z.string().optional(),
        tags: z.array(z.string()).optional(),
        duration: z.number({ required_error: 'Duration is required' }),
    }),
});

// El chequeo "al menos un campo" NO se hace acá con un `.refine`: la validación
// corre ANTES de que el controller inyecte `audio_url`/`cover_image` del archivo
// subido, así que un update SÓLO-con-archivo (reemplazar el audio o la portada sin
// tocar texto) llegaba con el body vacío y el refine lo rechazaba. El guard de
// "hay algo para actualizar" se aplica en el service (`updateAudio`), que sí ve el
// payload ya con la URL del archivo inyectada.
export const updateAudioValidationSchema = z.object({
    body: z.object({
        audioTopic: z.string().length(24).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        cover_image: z.string().optional(),
        tags: z.array(z.string()).optional(),
        duration: z.number().optional(),
    }),
});

// Puntuación de un audio: entero de 1 a 5. Antes la ruta no validaba nada, así
// que llegaban `rating` fuera de rango / no numéricos hasta el service.
export const giveRatingValidationSchema = z.object({
    body: z.object({
        rating: z
            .number({ required_error: 'Rating is required' })
            .int('Rating must be an integer')
            .min(1, 'Rating must be between 1 and 5')
            .max(5, 'Rating must be between 1 and 5'),
    }),
});

// E0: el player reporta cuánto se escuchó; el server decide si califica.
export const recordListenValidationSchema = z.object({
    body: z.object({
        secondsListened: z.number().min(0).optional(),
        completion: z.number().min(0).max(1).optional(),
    }),
});

const AudioValidations = {
    createAudioValidationSchema,
    updateAudioValidationSchema,
    giveAudioFeedbackValidationSchema,
    giveRatingValidationSchema,
    recordListenValidationSchema,
};

export default AudioValidations;
