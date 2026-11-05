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

// El chequeo "al menos un campo" NO se hace acá con un `.refine`: la validación
// corre ANTES de que el controller inyecte la portada (`cover_image`) del archivo
// subido, así que un update SÓLO-con-archivo llegaba con el body vacío y el refine
// lo rechazaba. El guard se aplica en el service (`updatePlaylist`), que ya ve el
// payload con la portada inyectada.
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
