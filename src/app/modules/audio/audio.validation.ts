import { z } from 'zod';
import { isValidFeelingTag } from './feelingTags';

// Listener feedback: optional text (<=500) and/or controlled-vocabulary feeling
// tags. Rejected only if BOTH are empty. Subset checks repeat in the service.
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
        // URL already staged by /upload-audio (two-step upload). The controller
        // validates host, owner prefix and that it is not yet published.
        audio_url: z.string().optional(),
        cover_image: z.string().optional(),
        tags: z.array(z.string()).optional(),
        duration: z.number({ required_error: 'Duration is required' }),
    }),
});

// No "at least one field" `.refine` here: validation runs BEFORE the controller
// injects `audio_url`/`cover_image` from the uploaded file, so a file-only update
// arrived with an empty body and was rejected. That guard lives in the service
// (`updateAudio`), which sees the payload after the URL injection.
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

// Audio rating: integer 1..5. The route used to validate nothing, so out-of-range
// or non-numeric `rating` reached the service.
export const giveRatingValidationSchema = z.object({
    body: z.object({
        rating: z
            .number({ required_error: 'Rating is required' })
            .int('Rating must be an integer')
            .min(1, 'Rating must be between 1 and 5')
            .max(5, 'Rating must be between 1 and 5'),
    }),
});

// E0: the player reports how much was listened; the server decides if it counts.
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
