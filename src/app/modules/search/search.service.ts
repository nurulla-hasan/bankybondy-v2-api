import { Types } from 'mongoose';
import { getMediaUrl } from '../../utilities/signedUrl';
import { ENUM_AUDIO_MODERATION_STATUS } from '../audio/audio.interface';
import Audio from '../audio/audio.model';
import { ENUM_BOND_REQUEST_STATUS } from '../bondRequest/bondRequest.enum';
import BondRequest from '../bondRequest/bondRequest.model';
import NormalUser from '../normalUser/normalUser.model';
import { User } from '../user/user.model';
import { Skill } from '../skill/skill.model';
import { getBlockedObjectIdsFor } from '../userBlock/userBlock.service';

// Escapa los metacaracteres de expresion regular para evitar inyeccion/errores
// al construir el RegExp a partir del termino de busqueda del usuario.
const escapeRegex = (input: string): string =>
    input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const EMPTY_RESULT = { people: [], bonds: [], audios: [] };

// Busqueda global ligera: busca en personas (NormalUser), bonos (BondRequest) y
// audios (Audio) en paralelo, con proyecciones, .lean() y un tope duro por
// categoria. Nunca lanza sobre entrada vacia; nunca usa agregaciones pesadas.
const globalSearch = async (profileId: string, rawQuery?: unknown) => {
    const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';

    // Umbral minimo: no consultamos la base con terminos de 0-1 caracteres.
    if (q.length < 2) {
        return EMPTY_RESULT;
    }

    const regex = new RegExp(escapeRegex(q), 'i');
    const LIMIT = 6;

    // Excluye a las personas bloqueadas (en ambos sentidos) de los resultados.
    const blockedIds = await getBlockedObjectIdsFor(profileId);
    const callerId = new Types.ObjectId(profileId);

    // Perfiles OCULTOS de Personas (listedInPeople:false) no deben aparecer en
    // NINGUNA rama del buscador: ni por nombre (personas), ni a través de sus
    // bonos o audios. El matcheo es OTRO motor y NO se ve afectado: la persona
    // sigue activa y sigue matcheando. Se calcula una vez el set de ids ocultos y
    // se excluye en las tres consultas.
    const hiddenUserDocs = await NormalUser.find({ listedInPeople: false })
        .select('_id')
        .lean();
    const hiddenUserIds = (hiddenUserDocs as Array<{ _id: Types.ObjectId }>).map(
        (d) => d._id
    );

    // Excluir a los BANEADOS POR ADMIN (User.isBlocked): una acción de moderación
    // debe sacarlos del buscador igual que de Personas (getAllUser) y del matcheo
    // (C.5). El search era la única superficie de descubrimiento que faltaba.
    // `User.profileId` es el id de NormalUser (mismo espacio que _id/user de abajo).
    const adminBlockedIds = await User.find({ isBlocked: true }).distinct(
        'profileId'
    );

    // Personas tambien por nombre de skill (aditivo, ligero): pre-resolvemos los
    // ids de skills que matchean y los sumamos al $or junto al nombre.
    const matchedSkills = await Skill.find({ name: regex })
        .select('_id')
        .lean();
    const peopleOr: Record<string, unknown>[] = [{ name: { $regex: regex } }];
    if (matchedSkills.length) {
        peopleOr.push({ skills: { $in: matchedSkills.map((s) => s._id) } });
    }

    const [people, bonds, audios] = await Promise.all([
        // 1) Personas: por nombre o por nombre de skill. NUNCA se expone el email.
        //    Se excluyen bloqueados Y ocultos (listedInPeople:false).
        NormalUser.find({
            $or: peopleOr,
            _id: {
                $ne: callerId,
                $nin: [...blockedIds, ...hiddenUserIds, ...adminBlockedIds],
            },
        })
            .select('name profile_image')
            .limit(LIMIT)
            .lean(),

        // 2) Bonos activos y disponibles (no en pausa, no enlazados). Se excluyen
        //    los bonos cuyo dueño se ocultó de Personas (no debe aparecer en búsquedas).
        BondRequest.find({
            $or: [
                { offer: { $regex: regex } },
                { want: { $regex: regex } },
                { description: { $regex: regex } },
            ],
            status: {
                $in: [
                    ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
                    ENUM_BOND_REQUEST_STATUS.ONGOING,
                ],
            },
            isPause: false,
            isLinked: { $ne: true },
            user: { $nin: [...hiddenUserIds, ...blockedIds, ...adminBlockedIds] },
        })
            .select('offer want modality user status')
            .populate({ path: 'user', select: 'name profile_image' })
            .limit(LIMIT)
            .lean(),

        // 3) Audios aprobados y no bloqueados. Se excluyen los de dueños ocultos.
        Audio.find({
            $or: [
                { title: { $regex: regex } },
                { description: { $regex: regex } },
                { tags: { $regex: regex } },
            ],
            moderationStatus: ENUM_AUDIO_MODERATION_STATUS.READY,
            isBlocked: false,
            user: { $nin: [...hiddenUserIds, ...blockedIds, ...adminBlockedIds] },
        })
            .select('title cover_image user duration')
            .populate({
                path: 'user',
                select: 'name profile_image',
                model: 'NormalUser',
            })
            .limit(LIMIT)
            .lean(),
    ]);

    // Firma las cover_image de los audios (CloudFront) igual que el resto del app.
    const signedAudios = (audios as Array<{ cover_image?: string }>).map(
        (audio) => ({
            ...audio,
            cover_image: audio.cover_image
                ? getMediaUrl(audio.cover_image)
                : audio.cover_image,
        })
    );

    return { people, bonds, audios: signedAudios };
};

const SearchService = {
    globalSearch,
};

export default SearchService;
