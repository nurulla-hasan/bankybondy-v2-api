import httpStatus from 'http-status';
import QueryBuilder from '../../builder/QueryBuilder';
import AppError from '../../error/appError';
import { IRelative } from './relative.interface';
import Relative from './relative.model';

// Create Relative
const createRelative = async (userId: string, payload: IRelative) => {
    const isExists = await Relative.findOne({
        user: userId,
        relative: payload.relative,
    });
    if (userId == payload.relative.toString()) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'You can not add yourself as a relative'
        );
    }
    if (isExists) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'You already added this person as relative'
        );
    }
    // Allowlist (anti mass-assignment): `user` (dueño) se fuerza, jamás del body.
    const result = await Relative.create({
        relative: payload.relative,
        relation: payload.relation,
        familySide: payload.familySide,
        user: userId,
    });
    return result;
};

const getAllRelatives = async (
    userId: string,
    query: Record<string, unknown>
) => {
    const relativeQuery = new QueryBuilder(
        Relative.find({ user: userId }).populate({
            path: 'relative',
            select: 'name profile_image',
        }),
        query
    )
        .search(['relation'])
        .filter()
        .sort()
        .paginate()
        .fields();

    const result = await relativeQuery.modelQuery;
    const meta = await relativeQuery.countTotal();

    return {
        meta,
        result,
    };
};

// Get Relative by ID
const getRelativeById = async (userId: string, relativeId: string) => {
    // Authz: solo el dueño puede leer su registro de familiar. Antes se hacía
    // findById sin filtro → cualquiera con el id lo leía, y el populate filtraba
    // el perfil completo del dueño.
    const relative = await Relative.findOne({ _id: relativeId, user: userId })
        .populate('user')
        .populate('relative');
    if (!relative) {
        throw new AppError(httpStatus.NOT_FOUND, 'Relative not found');
    }
    return relative;
};

// Update Relative
const updateRelative = async (
    userId: string,
    relativeId: string,
    payload: Partial<IRelative>
) => {
    // Authz: el param userId ya venía pero NO se usaba → cualquiera editaba
    // familiares ajenos. Scopeamos por dueño.
    const relative = await Relative.findOne({ _id: relativeId, user: userId });
    if (!relative) {
        throw new AppError(httpStatus.NOT_FOUND, 'Relative not found');
    }

    // Allowlist (anti mass-assignment). El scope de dueño de arriba está bien,
    // pero después se escribía el `payload` CRUDO: `validateRequest` valida una
    // copia del body y no lo recorta, así que las claves que el schema no declara
    // llegaban igual. Con `{"user": "<profileId ajeno>"}` el registro pasaba a
    // pertenecer a otra persona: le aparecía en su lista de familiares un vínculo
    // que nunca creó, y el dueño original ya no podía deshacerlo.
    // Mismo criterio que `createRelative`, que sí arma los campos explícitos.
    const RELATIVE_EDITABLE_FIELDS = ['relative', 'relation'] as const;
    const safePayload: Record<string, unknown> = {};
    for (const key of RELATIVE_EDITABLE_FIELDS) {
        if ((payload as Record<string, unknown>)[key] !== undefined) {
            safePayload[key] = (payload as Record<string, unknown>)[key];
        }
    }

    const updatedRelative = await Relative.findByIdAndUpdate(
        relativeId,
        safePayload,
        { new: true }
    );
    return updatedRelative;
};

// Delete Relative----
const deleteRelative = async (userId: string, relativeId: string) => {
    const relative = await Relative.findOne({ user: userId, _id: relativeId });
    if (!relative) {
        throw new AppError(httpStatus.NOT_FOUND, 'Relative not found');
    }
    const result = await Relative.findByIdAndDelete(relativeId);
    return result;
};

const RelativeService = {
    createRelative,
    getAllRelatives,
    getRelativeById,
    updateRelative,
    deleteRelative,
};

export default RelativeService;
