import { z } from 'zod';

// Valida (de forma laxa) el termino de busqueda. Es opcional: si falta o es
// corto, el servicio responde con listas vacias sin consultar la base.
export const globalSearchValidationSchema = z.object({
    query: z
        .object({
            q: z.string().optional(),
        })
        .optional(),
});

const SearchValidations = {
    globalSearchValidationSchema,
};

export default SearchValidations;
