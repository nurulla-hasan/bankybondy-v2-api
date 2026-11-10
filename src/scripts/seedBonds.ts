/* eslint-disable no-console */
/**
 * DEMO data for the Bonds section (requests + matches + links); idempotent and
 * re-runnable, dev only. Requires BONDS_SEED_DATABASE_URL to name a disposable DB.
 */
import mongoose, { Types } from 'mongoose';
import { ENUM_BOND_REQUEST_STATUS } from '../app/modules/bondRequest/bondRequest.enum';
import BondRequest from '../app/modules/bondRequest/bondRequest.model';
import { BondLink } from '../app/modules/bondLink/bondLink.model';
import { ENUM_BOND_LINK_STATUS } from '../app/modules/bondLink/bondLink.enum';
import BondMatch from '../app/modules/bondMatch/bondMatch.model';
import NormalUser from '../app/modules/normalUser/normalUser.model';
import { Skill } from '../app/modules/skill/skill.model';
import { USER_ROLE } from '../app/modules/user/user.constant';
import { User } from '../app/modules/user/user.model';

const DEMO_PASSWORD = process.env.DEFAULT_PASS || 'User@12345';
const DEMO_OWNER_EMAIL = 'demo@bankybondy.dev';

const COUNTERPART_USERS = [
    {
        key: 'ana',
        name: 'Ana Pérez',
        email: 'ana.demo@bankybondy.dev',
        bio: 'Profesora de inglés y fanática de las bicis.',
        address: 'Palermo, Buenos Aires',
        skills: ['Inglés', 'Reparación de bicis', 'Traducción'],
        coords: [-58.42, -34.6] as [number, number],
        reputation: { avg: 4.8, count: 12 },
    },
    {
        key: 'luis',
        name: 'Luis Gómez',
        email: 'luis.demo@bankybondy.dev',
        bio: 'Guitarrista y vecino del barrio.',
        address: 'Almagro, Buenos Aires',
        skills: ['Guitarra', 'Piano', 'Música'],
        coords: [-58.43, -34.61] as [number, number],
        reputation: { avg: 4.5, count: 7 },
    },
    {
        key: 'marta',
        name: 'Marta Ruiz',
        email: 'marta.demo@bankybondy.dev',
        bio: 'Doy clases de inglés y aprendo guitarra.',
        address: 'Belgrano, Buenos Aires',
        skills: ['Inglés', 'Guitarra', 'Enseñanza'],
        coords: [-58.41, -34.59] as [number, number],
        reputation: { avg: 4.9, count: 21 },
    },
    {
        key: 'diego',
        name: 'Diego Sosa',
        email: 'diego.demo@bankybondy.dev',
        bio: 'Community manager freelance.',
        address: 'Villa Crespo, Buenos Aires',
        skills: ['Community management', 'Redes sociales', 'Fotografía'],
        coords: [-58.44, -34.62] as [number, number],
        reputation: { avg: 4.2, count: 4 },
    },
    {
        key: 'sofia',
        name: 'Sofía Lara',
        email: 'sofia.demo@bankybondy.dev',
        bio: 'Profesora de yoga, curiosa de la música.',
        address: 'Recoleta, Buenos Aires',
        skills: ['Yoga', 'Música', 'Bienestar'],
        coords: [-58.4, -34.58] as [number, number],
        reputation: { avg: 4.6, count: 9 },
    },
];

type BondSeed = {
    key: string;
    owner: 'owner' | 'ana' | 'luis' | 'marta' | 'diego' | 'sofia';
    offer: string;
    want: string;
    description: string;
    modality: 'physical' | 'online';
    radius?: number;
    status?: 'WAITING_FOR_LINK' | 'CANCELED';
    isPause?: boolean;
    hoursAgo: number;
};

const BOND_SEEDS: BondSeed[] = [
    // ── Owner / demo account ─────────────────────────────────────────────
    {
        key: 'ob1',
        owner: 'owner',
        offer: 'Reparación y ajuste de bicis',
        want: 'Clases de inglés',
        description:
            'Taller propio en Palermo. Incluye ajuste de cambios, frenos y puesta a punto general.',
        modality: 'physical',
        radius: 20,
        hoursAgo: 2,
    },
    {
        key: 'ob2',
        owner: 'owner',
        offer: 'Fotografía de producto',
        want: 'Diseño de logo',
        description: 'Sesión de 10 fotos editadas, ideal para tiendas online.',
        modality: 'online',
        hoursAgo: 6,
    },
    {
        key: 'ob3',
        owner: 'owner',
        offer: 'Clases de guitarra',
        want: 'Clases de yoga',
        description: 'Nivel inicial e intermedio, una hora por semana.',
        modality: 'physical',
        radius: 10,
        status: 'CANCELED',
        hoursAgo: 120,
    },
    {
        key: 'ob4',
        owner: 'owner',
        offer: 'Masa madre de centeno',
        want: 'Esquejes de plantas',
        description: 'Masa activa con instrucciones de mantenimiento.',
        modality: 'physical',
        radius: 5,
        isPause: true,
        hoursAgo: 30,
    },
    {
        key: 'ob5',
        owner: 'owner',
        offer: 'Reparación de computadoras',
        want: 'Community management',
        description: 'Limpieza, cambio de disco y reinstalación de sistema.',
        modality: 'online',
        hoursAgo: 20,
    },
    {
        key: 'ob6',
        owner: 'owner',
        offer: 'Reparación de muebles',
        want: 'Pintura de interiores',
        description: 'Restauro sillas y mesas de madera.',
        modality: 'physical',
        radius: 15,
        hoursAgo: 190,
    },

    // ── Counterparts ─────────────────────────────────────────────────────
    {
        key: 'ab1',
        owner: 'ana',
        offer: 'Clases de inglés',
        want: 'Reparación de bicis',
        description: 'Conversación y gramática, todos los niveles.',
        modality: 'physical',
        radius: 15,
        hoursAgo: 4,
    },
    {
        key: 'ab2',
        owner: 'ana',
        offer: 'Diseño de logo',
        want: 'Fotografía de producto',
        description: 'Tres propuestas y manual de marca.',
        modality: 'online',
        hoursAgo: 50,
    },
    {
        key: 'lb1',
        owner: 'luis',
        offer: 'Clases de guitarra',
        want: 'Reparación de bicis',
        description: 'Acordes, ritmo y primeras canciones.',
        modality: 'physical',
        radius: 15,
        hoursAgo: 8,
    },
    {
        key: 'lb2',
        owner: 'luis',
        offer: 'Clases de piano',
        want: 'Reparación de muebles',
        description: 'Lectura de partituras y práctica guiada.',
        modality: 'physical',
        radius: 20,
        hoursAgo: 200,
    },
    {
        key: 'mb1',
        owner: 'marta',
        offer: 'Clases de inglés',
        want: 'Clases de guitarra',
        description: 'Preparación de exámenes y conversación.',
        modality: 'online',
        hoursAgo: 12,
    },
    {
        key: 'mb2',
        owner: 'marta',
        offer: 'Pintura de interiores',
        want: 'Clases de piano',
        description: 'Paredes y cielorrasos, materiales incluidos.',
        modality: 'physical',
        radius: 20,
        hoursAgo: 210,
    },
    {
        key: 'db1',
        owner: 'diego',
        offer: 'Community management',
        want: 'Reparación de computadoras',
        description: 'Gestión de redes y calendario de contenidos.',
        modality: 'online',
        hoursAgo: 16,
    },
    {
        key: 'sb1',
        owner: 'sofia',
        offer: 'Clases de yoga',
        want: 'Clases de guitarra',
        description: 'Hatha y respiración, clases individuales.',
        modality: 'physical',
        radius: 10,
        hoursAgo: 130,
    },
];

const SEED_OFFERS = [...new Set(BOND_SEEDS.map((bond) => bond.offer))];

const LINK_SEEDS = [
    {
        key: 'l1',
        name: 'Círculo de reparaciones del barrio',
        status: ENUM_BOND_LINK_STATUS.Ongoing,
        bondKeys: ['ob6', 'mb2', 'lb2'],
        participantOwners: ['owner', 'marta', 'luis'],
        markAsCompletedBy: [] as string[],
        hoursAgo: 5,
    },
    {
        key: 'l2',
        name: 'Fotos y logos',
        status: ENUM_BOND_LINK_STATUS.Completed,
        bondKeys: ['ob2', 'ab2'],
        participantOwners: ['owner', 'ana'],
        markAsCompletedBy: ['owner', 'ana'],
        hoursAgo: 72,
    },
    {
        key: 'l3',
        name: 'Clases y yoga',
        status: ENUM_BOND_LINK_STATUS.Canceled,
        bondKeys: ['ob3', 'sb1'],
        participantOwners: ['owner', 'sofia'],
        markAsCompletedBy: [] as string[],
        hoursAgo: 192,
    },
];

const MATCH_SEEDS = [
    {
        sourceBond: 'ob1',
        bondKeys: ['ob1', 'mb1', 'lb1'],
        users: ['owner', 'marta', 'luis'],
        score: 0.94,
        parts: { sem: 0.95, rep: 0.9, prox: 0.85, fresh: 0.8 },
        type: 'entry' as const,
    },
    {
        sourceBond: 'ob1',
        bondKeys: ['ob1', 'ab1'],
        users: ['owner', 'ana'],
        score: 0.88,
        parts: { sem: 0.9, rep: 0.85, prox: 0.9, fresh: 0.75 },
        type: 'entry' as const,
    },
    {
        sourceBond: 'ob5',
        bondKeys: ['ob5', 'db1'],
        users: ['owner', 'diego'],
        score: 0.82,
        parts: { sem: 0.85, rep: 0.8, prox: 0.9, fresh: 0.7 },
        type: 'entry' as const,
    },
];

/** Deterministic 1536-dim vector: the schema only validates its length. */
const vectorFor = (seed: string): number[] => {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    const v = new Array<number>(1536);
    for (let i = 0; i < 1536; i += 1) {
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        v[i] = (((h >>> 0) % 2001) - 1000) / 1000;
    }
    return v;
};

const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * 60 * 60 * 1000);

const parseArgs = () => {
    const args = process.argv.slice(2);
    const userIndex = args.indexOf('--user');
    const targetEmail =
        userIndex >= 0 ? (args[userIndex + 1] || '').trim() : '';

    if (userIndex >= 0 && !targetEmail) {
        throw new Error('Falta el email después de --user');
    }

    return {
        targetEmail: targetEmail || null,
        cleanOnly: args.includes('--clean'),
    };
};

async function ensureSkill(name: string) {
    const skill = await Skill.findOneAndUpdate(
        { name },
        { $setOnInsert: { name } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    )
        .select('_id')
        .lean();

    if (!skill) throw new Error(`No se pudo resolver la skill ${name}`);

    return skill._id;
}

async function resolveSkillIds(names: string[]) {
    return Promise.all(names.map((name) => ensureSkill(name)));
}

async function createDemoPerson(person: (typeof COUNTERPART_USERS)[number]) {
    const user = await User.create({
        email: person.email,
        password: DEMO_PASSWORD,
        role: USER_ROLE.user,
        isVerified: true,
        isActive: true,
    });

    const skills = await resolveSkillIds(person.skills);

    const profile = await NormalUser.create({
        user: user._id,
        name: person.name,
        email: person.email,
        bio: person.bio,
        address: person.address,
        skills,
        location: { type: 'Point', coordinates: person.coords },
        locationUpdatedAt: new Date(),
        locationMode: 'manual',
        reputation: {
            avg: person.reputation.avg,
            count: person.reputation.count,
            score: Math.min(person.reputation.avg / 5, 1),
        },
        hasActiveBonds: true,
    });

    await User.findByIdAndUpdate(user._id, { profileId: profile._id });

    return profile;
}

async function createDemoOwner() {
    const user = await User.create({
        email: DEMO_OWNER_EMAIL,
        password: DEMO_PASSWORD,
        role: USER_ROLE.user,
        isVerified: true,
        isActive: true,
    });

    const skills = await resolveSkillIds([
        'Reparación de bicis',
        'Fotografía',
        'Reparación de computadoras',
    ]);

    const profile = await NormalUser.create({
        user: user._id,
        name: 'Demo BankyBondy',
        email: DEMO_OWNER_EMAIL,
        bio: 'Cuenta de demostración con vínculos, coincidencias y trueques de ejemplo.',
        address: 'Palermo, Buenos Aires',
        skills,
        location: { type: 'Point', coordinates: [-58.4173, -34.6037] },
        locationUpdatedAt: new Date(),
        locationMode: 'manual',
        reputation: { avg: 4.7, count: 18, score: 0.94 },
        hasActiveBonds: true,
    });

    await User.findByIdAndUpdate(user._id, { profileId: profile._id });

    return profile;
}

async function cleanup(targetProfileId: Types.ObjectId | null) {
    const demoEmails = [
        DEMO_OWNER_EMAIL,
        ...COUNTERPART_USERS.map((person) => person.email),
    ];

    const demoAuthUsers = await User.find({ email: { $in: demoEmails } })
        .select('_id profileId')
        .lean();
    const demoProfileIds = demoAuthUsers
        .map((user) => user.profileId)
        .filter((id): id is string => Boolean(id));
    const demoAuthIds = demoAuthUsers.map((user) => user._id);

    const bondFilterParts: Record<string, unknown>[] = [];
    if (demoProfileIds.length) {
        bondFilterParts.push({ user: { $in: demoProfileIds } });
    }
    if (targetProfileId) {
        bondFilterParts.push({
            user: targetProfileId,
            offer: { $in: SEED_OFFERS },
        });
    }

    if (!bondFilterParts.length) return { bonds: 0, links: 0, matches: 0, users: 0 };

    const seedBonds = await BondRequest.find({ $or: bondFilterParts })
        .select('_id')
        .lean();
    const seedBondIds = seedBonds.map((bond) => bond._id);

    let matches = 0;
    let links = 0;
    let bonds = 0;

    if (seedBondIds.length) {
        const matchResult = await BondMatch.deleteMany({
            $or: [
                { sourceBond: { $in: seedBondIds } },
                { bonds: { $in: seedBondIds } },
            ],
        });
        matches = matchResult.deletedCount ?? 0;

        const linkResult = await BondLink.deleteMany({
            requestedBonds: { $in: seedBondIds },
        });
        links = linkResult.deletedCount ?? 0;

        const bondResult = await BondRequest.deleteMany({
            _id: { $in: seedBondIds },
        });
        bonds = bondResult.deletedCount ?? 0;
    }

    if (demoProfileIds.length) {
        await NormalUser.deleteMany({ _id: { $in: demoProfileIds } });
    }
    if (demoAuthIds.length) {
        await User.deleteMany({ _id: { $in: demoAuthIds } });
    }

    return {
        bonds,
        links,
        matches,
        users: demoAuthIds.length,
    };
}

async function resolveTargetProfile(email: string) {
    if (email === DEMO_OWNER_EMAIL) {
        throw new Error(
            'Ese email es la cuenta demo: usá el seed sin --user para recrearla'
        );
    }

    const authUser = await User.findOne({ email }).select('_id profileId').lean();
    if (!authUser) {
        throw new Error(`No existe un User con email ${email}`);
    }
    if (!authUser.profileId) {
        throw new Error(`El User ${email} no tiene profileId (NormalUser)`);
    }

    const profile = await NormalUser.findById(authUser.profileId).select('_id');
    if (!profile) {
        throw new Error(`No existe el NormalUser ${authUser.profileId}`);
    }

    return profile._id as Types.ObjectId;
}

async function main() {
    const { targetEmail, cleanOnly } = parseArgs();

    const uri = process.env.BONDS_SEED_DATABASE_URL;
    const database = uri?.replace(/^mongodb(\+srv)?:\/\//, '').split('?')[0].split('@').pop()?.split('/')[1];
    if (process.env.NODE_ENV === 'production' || !database ||
        !/^(?:bankybondy[-_])?(?:verify|scratch|descartable|prueba)[-_][a-z0-9_-]+$/i.test(database)) {
        throw new Error('BONDS_SEED_DATABASE_URL must explicitly name a disposable database; production seeding is prohibited');
    }
    await mongoose.connect(uri, {
        autoIndex: false, autoCreate: false, maxPoolSize: 10,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
    });
    if (mongoose.connection.db?.databaseName !== database) {
        await mongoose.disconnect();
        throw new Error('Seed database differs from the approved disposable target');
    }
    console.log('[seed:bonds] Disposable DB connected');

    const targetProfileId = targetEmail
        ? await resolveTargetProfile(targetEmail)
        : null;

    const removed = await cleanup(targetProfileId);
    console.log(
        `[seed:bonds] limpieza → bonds=${removed.bonds} links=${removed.links} matches=${removed.matches} users=${removed.users}`
    );

    if (cleanOnly) return;

    const ownerProfile = targetProfileId
        ? await NormalUser.findById(targetProfileId).select('_id')
        : await createDemoOwner();

    if (!ownerProfile) {
        throw new Error('No se pudo resolver el perfil dueño del seed');
    }

    const profiles = new Map<string, Types.ObjectId>();
    profiles.set('owner', ownerProfile._id as Types.ObjectId);

    for (const person of COUNTERPART_USERS) {
        const profile = await createDemoPerson(person);
        profiles.set(person.key, profile._id as Types.ObjectId);
    }

    // Outside the recompute pool: the seeded cache is served as-is.
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    const bondIdByKey = new Map<string, Types.ObjectId>();

    for (const seed of BOND_SEEDS) {
        const ownerId = profiles.get(seed.owner);
        if (!ownerId) throw new Error(`Owner desconocido: ${seed.owner}`);

        const createdAt = hoursAgo(seed.hoursAgo);

        const bond = await BondRequest.create({
            user: ownerId,
            offer: seed.offer,
            want: seed.want,
            description: seed.description,
            modality: seed.modality,
            radius: seed.radius,
            status: seed.status ?? ENUM_BOND_REQUEST_STATUS.WAITING_FOR_LINK,
            isPause: seed.isPause ?? false,
            isLinked: false,
            offerVector: vectorFor(`${seed.key}:offer:${seed.offer}`),
            wantVector: vectorFor(`${seed.key}:want:${seed.want}`),
            // Now: bonds with no seeded matches answer an empty 'ready' (otherwise
            // the front polls 'computing' forever).
            matchesComputedAt: new Date(),
            matchesNextAt: farFuture,
            matchesGen: 1,
            createdAt,
            updatedAt: createdAt,
            ...(seed.modality === 'physical'
                ? {
                      location: {
                          type: 'Point',
                          coordinates: [-58.4173, -34.6037],
                      },
                  }
                : {}),
        });

        bondIdByKey.set(seed.key, bond._id as Types.ObjectId);
    }

    for (const seed of MATCH_SEEDS) {
        const sourceBond = bondIdByKey.get(seed.sourceBond);
        const bondIds = seed.bondKeys.map((key) => bondIdByKey.get(key));
        const userIds = seed.users.map((key) => profiles.get(key));

        if (!sourceBond || bondIds.some((id) => !id) || userIds.some((id) => !id)) {
            throw new Error(`Match seed inválido: ${seed.sourceBond}`);
        }

        await BondMatch.create({
            sourceBond,
            bonds: bondIds,
            users: userIds,
            score: seed.score,
            parts: seed.parts,
            type: seed.type,
            size: bondIds.length,
            computedAt: new Date(),
        });
    }

    for (const seed of LINK_SEEDS) {
        const bondIds = seed.bondKeys.map((key) => bondIdByKey.get(key));
        const participantIds = seed.participantOwners.map((key) =>
            profiles.get(key)
        );

        if (bondIds.some((id) => !id) || participantIds.some((id) => !id)) {
            throw new Error(`Link seed inválido: ${seed.name}`);
        }

        const createdAt = hoursAgo(seed.hoursAgo);
        const bondsKey = bondIds
            .map((id) => String(id))
            .sort()
            .join('_');

        await BondLink.create({
            name: seed.name,
            participants: participantIds,
            requestedBonds: bondIds,
            bondsKey,
            status: seed.status,
            markAsCompletedBy: seed.markAsCompletedBy.map((key) =>
                profiles.get(key)
            ),
            createdAt,
            updatedAt: createdAt,
        });
    }

    await NormalUser.updateOne(
        { _id: ownerProfile._id },
        { $set: { hasActiveBonds: true } }
    );

    const ownerEmail = targetEmail || DEMO_OWNER_EMAIL;
    console.log('[seed:bonds] listo');
    console.log(`  dueño:      ${ownerEmail}`);
    if (!targetEmail) {
        console.log(`  password:   ${DEMO_PASSWORD}`);
    }
    console.log(`  requests:   ${BOND_SEEDS.length}`);
    console.log(`  matches:    ${MATCH_SEEDS.length}`);
    console.log(`  links:      ${LINK_SEEDS.length}`);
    console.log(`  contrapartes: ${COUNTERPART_USERS.map((p) => p.email).join(', ')}`);
}

main()
    .then(async () => {
        await mongoose.connection.close();
        process.exit(0);
    })
    .catch(async (err) => {
        console.error('[seed:bonds] fatal error', err);
        try {
            await mongoose.connection.close();
        } catch {
            /* noop */
        }
        process.exit(1);
    });
