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

// Escapes regex metacharacters so the user's term can't inject or break the RegExp.
const escapeRegex = (input: string): string =>
    input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const EMPTY_RESULT = { people: [], bonds: [], audios: [] };

// Lightweight global search over people, bonds and audios in parallel, with projections,
// `.lean()` and a hard cap per category. Never throws on empty input; no heavy aggregations.
const globalSearch = async (profileId: string, rawQuery?: unknown) => {
    const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';

    // Minimum threshold: don't query the DB for 0-1 char terms.
    if (q.length < 2) {
        return EMPTY_RESULT;
    }

    const regex = new RegExp(escapeRegex(q), 'i');
    const LIMIT = 6;

    // Excludes people blocked in either direction.
    const blockedIds = await getBlockedObjectIdsFor(profileId);
    const callerId = new Types.ObjectId(profileId);

    // Profiles hidden from People (listedInPeople:false) must not show in ANY branch:
    // not by name, nor through their bonds or audios. Matching is another engine and is
    // unaffected. Computed once and excluded from the three queries.
    const hiddenUserDocs = await NormalUser.find({ listedInPeople: false })
        .select('_id')
        .lean();
    const hiddenUserIds = (hiddenUserDocs as Array<{ _id: Types.ObjectId }>).map(
        (d) => d._id
    );

    // Admin-banned users (User.isBlocked) must leave search too: moderation has to apply
    // as in People and matching. `User.profileId` is the NormalUser id.
    const adminBlockedIds = await User.find({ isBlocked: true }).distinct(
        'profileId'
    );

    // People also match by skill name (additive, light): pre-resolve matching skill
    // ids and add them to the same $or as the name.
    const matchedSkills = await Skill.find({ name: regex })
        .select('_id')
        .lean();
    const peopleOr: Record<string, unknown>[] = [{ name: { $regex: regex } }];
    if (matchedSkills.length) {
        peopleOr.push({ skills: { $in: matchedSkills.map((s) => s._id) } });
    }

    const [people, bonds, audios] = await Promise.all([
        // 1) People by name or skill name. Email is NEVER exposed.
        //    Blocked and hidden (listedInPeople:false) users are excluded.
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

        // 2) Active, available bonds (not paused, not linked). Bonds of hidden owners excluded.
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

        // 3) Approved, non-blocked audios. Audios of hidden owners excluded.
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

    // Signs audio covers (CloudFront) like the rest of the app.
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
