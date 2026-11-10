import { z } from 'zod';

export const createPlaylistValidationSchema = z.object({
    body: z.object({
        name: z.string({ required_error: 'Name is required' }),
        description: z.string({ required_error: 'Description is required' }),
        tags: z.array(z.string()).optional(),
        audios: z
            .array(z.string().length(24, 'Invalid audio ID'))
            .nonempty('At least one audio is required'),
    }),
});

// The "at least one field" check is NOT a `.refine` here: validation runs BEFORE
// the controller injects the uploaded `cover_image`, so an update with ONLY a
// file arrived with an empty body and the refine rejected it. The guard lives in
// the service (`updatePlaylist`), which sees the payload with the cover injected.
export const updatePlaylistValidationSchema = z.object({
    body: z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        cover_image: z.string().optional(),
        audios: z.array(z.string().length(24)).optional(),
    }),
});

const PlaylistValidations = {
    createPlaylistValidationSchema,
    updatePlaylistValidationSchema,
};

export default PlaylistValidations;
