/* eslint-disable @typescript-eslint/no-explicit-any */
import Audio from '../audio/audio.model';
import { ENUM_BOND_LINK_STATUS } from '../bondLink/bondLink.enum';
import { BondLink } from '../bondLink/bondLink.model';
import BondRequest from '../bondRequest/bondRequest.model';
import { ENUM_DONATE_STATUS } from '../donate/donate.enum';
import { Donate } from '../donate/donate.model';
import Institution from '../institution/institution.model';
import { ENUM_SUBSCRIPTION_TYPE } from '../normalUser/normalUser.enum';
import NormalUser from '../normalUser/normalUser.model';
import Transaction from '../transaction/transaction.model';
import { User } from '../user/user.model';
import { ENUM_TRANSACTION_TYPE } from '../../utilities/enum';

const getDashboardMetaData = async () => {
    const [totalUser, totalBlockAccount, donationStats] = await Promise.all([
        NormalUser.countDocuments(),
        User.countDocuments({ isBlocked: true }),
        Donate.aggregate([
            // C.1/C.3 (Tanda 2) FIX: el modelo Donate guarda status 'Paid'
            // (ENUM_DONATE_STATUS), no 'PAID' (ENUM_PAYMENT_STATUS). El match
            // anterior nunca coincidia, dejando donantes/monto en 0.
            {
                $match: { status: ENUM_DONATE_STATUS.Paid },
            },
            {
                $group: {
                    _id: null,
                    totalAmount: { $sum: '$amount' },
                    uniqueDonors: { $addToSet: '$user' },
                },
            },
            {
                $project: {
                    _id: 0,
                    totalAmount: 1,
                    totalUniqueDonors: { $size: '$uniqueDonors' },
                },
            },
        ]),
    ]);

    const { totalAmount = 0, totalUniqueDonors = 0 } = donationStats[0] || {};

    return {
        totalUser,
        totalBlockAccount,
        totalDonationAmount: totalAmount,
        totalDonors: totalUniqueDonors,
    };
};

const getUserChartData = async (year: number) => {
    const currentYear = year || new Date().getFullYear();

    const startOfYear = new Date(currentYear, 0, 1);
    const endOfYear = new Date(currentYear + 1, 0, 1);

    const chartData = await NormalUser.aggregate([
        {
            $match: {
                createdAt: {
                    $gte: startOfYear,
                    $lt: endOfYear,
                },
            },
        },
        {
            $group: {
                _id: { $month: '$createdAt' },
                totalUser: { $sum: 1 },
            },
        },
        {
            $project: {
                month: '$_id',
                totalUser: 1,
                _id: 0,
            },
        },
        {
            $sort: { month: 1 },
        },
    ]);

    const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];

    const data = Array.from({ length: 12 }, (_, index) => ({
        month: months[index],
        totalUser:
            chartData.find((item) => item.month === index + 1)?.totalUser || 0,
    }));

    const yearsResult = await NormalUser.aggregate([
        {
            $group: {
                _id: { $year: '$createdAt' },
            },
        },
        {
            $project: {
                year: '$_id',
                _id: 0,
            },
        },
        {
            $sort: { year: 1 },
        },
    ]);

    const yearsDropdown = yearsResult.map((item: any) => item.year);

    return {
        chartData: data,
        yearsDropdown,
    };
};

const getInstitutionChartData = async (year?: number) => {
    const currentYear = year || new Date().getFullYear();
    const startOfYear = new Date(currentYear, 0, 1);
    const endOfYear = new Date(currentYear + 1, 0, 1);

    const chartAgg = await Institution.aggregate([
        { $match: { createdAt: { $gte: startOfYear, $lt: endOfYear } } },

        // Efficient lookup that returns a count for each institution
        {
            $lookup: {
                from: 'institutionmembers',
                let: { instId: '$_id' },
                pipeline: [
                    {
                        $match: {
                            $expr: { $eq: ['$institution', '$$instId'] },
                        },
                    },
                    { $count: 'count' },
                ],
                as: 'memberCounts',
            },
        },
        {
            $addFields: {
                memberCount: {
                    $ifNull: [{ $arrayElemAt: ['$memberCounts.count', 0] }, 0],
                },
            },
        },

        // Group by month and sum members/institutions
        {
            $group: {
                _id: { $month: '$createdAt' },
                totalInstitutions: { $sum: 1 },
                totalMembers: { $sum: '$memberCount' },
            },
        },

        // Compute average after grouping; round to 2 decimals
        {
            $project: {
                month: '$_id',
                totalInstitutions: 1,
                totalMembers: 1,
                avgMembersPerInstitution: {
                    $cond: [
                        { $eq: ['$totalInstitutions', 0] },
                        0,
                        {
                            $round: [
                                {
                                    $divide: [
                                        '$totalMembers',
                                        '$totalInstitutions',
                                    ],
                                },
                                2,
                            ],
                        },
                    ],
                },
                _id: 0,
            },
        },

        // Sort by month number
        { $sort: { month: 1 } },
    ]);

    const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];

    const data = months.map((m, i) => {
        const found = chartAgg.find((c: any) => c.month === i + 1) || {
            totalInstitutions: 0,
            totalMembers: 0,
            avgMembersPerInstitution: 0,
        };
        return {
            month: m,
            totalInstitutions: found.totalInstitutions,
            totalMembers: found.totalMembers,
            avgMembersPerInstitution: found.avgMembersPerInstitution,
        };
    });

    // Years dropdown from Institution (not Donate)
    const yearsResult = await Institution.aggregate([
        { $group: { _id: { $year: '$createdAt' } } },
        { $project: { year: '$_id', _id: 0 } },
        { $sort: { year: 1 } },
    ]);
    const yearsDropdown = yearsResult.map((r: any) => r.year);

    return { chartData: data, yearsDropdown };
};

const donorGrowthChartData = async (year: number) => {
    const currentYear = year || new Date().getFullYear();

    const startOfYear = new Date(currentYear, 0, 1);
    const endOfYear = new Date(currentYear + 1, 0, 1);

    const chartData = await Donate.aggregate([
        {
            $match: {
                createdAt: {
                    $gte: startOfYear,
                    $lt: endOfYear,
                },
            },
        },
        {
            $group: {
                _id: { $month: '$createdAt' },
                totalDonate: { $sum: 1 },
            },
        },
        {
            $project: {
                month: '$_id',
                totalDonate: 1,
                _id: 0,
            },
        },
        {
            $sort: { month: 1 },
        },
    ]);

    const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];

    const data = Array.from({ length: 12 }, (_, index) => ({
        month: months[index],
        totalDonate:
            chartData.find((item) => item.month === index + 1)?.totalDonate ||
            0,
    }));

    const yearsResult = await Donate.aggregate([
        {
            $group: {
                _id: { $year: '$createdAt' },
            },
        },
        {
            $project: {
                year: '$_id',
                _id: 0,
            },
        },
        {
            $sort: { year: 1 },
        },
    ]);

    const yearsDropdown = yearsResult.map((item: any) => item.year);

    return {
        chartData: data,
        yearsDropdown,
    };
};

const bondChartData = async (year: number) => {
    const startOfYear = new Date(year, 0, 1);
    const endOfYear = new Date(year + 1, 0, 1);

    const result = await BondLink.aggregate([
        {
            $match: {
                createdAt: { $gte: startOfYear, $lt: endOfYear },
            },
        },
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 },
            },
        },
    ]);

    let total = 0;
    let ongoing = 0;
    let completed = 0;
    let canceled = 0;

    result.forEach((item) => {
        total += item.count;
        if (item._id === ENUM_BOND_LINK_STATUS.Ongoing) ongoing = item.count;
        if (item._id === ENUM_BOND_LINK_STATUS.Completed)
            completed = item.count;
        if (item._id === ENUM_BOND_LINK_STATUS.Canceled) canceled = item.count;
    });

    const chartData = await BondLink.aggregate([
        {
            $match: {
                createdAt: {
                    $gte: startOfYear,
                    $lt: endOfYear,
                },
            },
        },
        {
            $group: {
                _id: { $month: '$createdAt' },
                total: { $sum: 1 },
                ongoing: {
                    $sum: {
                        $cond: [
                            { $eq: ['$status', ENUM_BOND_LINK_STATUS.Ongoing] },
                            1,
                            0,
                        ],
                    },
                },
                completed: {
                    $sum: {
                        $cond: [
                            {
                                $eq: [
                                    '$status',
                                    ENUM_BOND_LINK_STATUS.Completed,
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
                canceled: {
                    $sum: {
                        $cond: [
                            {
                                $eq: [
                                    '$status',
                                    ENUM_BOND_LINK_STATUS.Canceled,
                                ],
                            },
                            1,
                            0,
                        ],
                    },
                },
            },
        },
        {
            $project: {
                month: '$_id',
                total: 1,
                ongoing: 1,
                completed: 1,
                canceled: 1,
                _id: 0,
            },
        },
        {
            $sort: { month: 1 },
        },
    ]);

    const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];

    // Fill missing months with 0 values
    const data = Array.from({ length: 12 }, (_, index) => {
        const found = chartData.find((item) => item.month === index + 1);
        return {
            month: months[index],
            total: found?.total || 0,
            ongoing: found?.ongoing || 0,
            completed: found?.completed || 0,
            canceled: found?.canceled || 0,
        };
    });

    // Distinct years dropdown
    const yearsResult = await BondLink.aggregate([
        {
            $group: {
                _id: { $year: '$createdAt' },
            },
        },
        {
            $project: {
                year: '$_id',
                _id: 0,
            },
        },
        { $sort: { year: 1 } },
    ]);

    const yearsDropdown = yearsResult.map((item: any) => item.year);

    return {
        total,
        ongoing,
        completed,
        canceled,
        chartData: data,
        yearsDropdown,
    };
};

const getAudioPieChartData = async () => {
    const audioStats = await Audio.aggregate([
        {
            $group: {
                _id: null,
                shortAudioCount: {
                    $sum: { $cond: [{ $lt: ['$duration', 300] }, 1, 0] },
                },
                longAudioCount: {
                    $sum: { $cond: [{ $gte: ['$duration', 300] }, 1, 0] },
                },
                totalCount: { $sum: 1 },
            },
        },
        {
            $project: {
                _id: 0,
                shortAudioCount: 1,
                longAudioCount: 1,
                totalCount: 1,
            },
        },
    ]);
    const stats = audioStats[0] || {
        shortAudioCount: 0,
        longAudioCount: 0,
        totalCount: 0,
    };

    return stats;
};

// get instation chart
const getEarningChartData = async (year: number) => {
    const currentYear = year || new Date().getFullYear();

    const startOfYear = new Date(currentYear, 0, 1);
    const endOfYear = new Date(currentYear + 1, 0, 1);

    const chartData = await Donate.aggregate([
        {
            $match: {
                createdAt: {
                    $gte: startOfYear,
                    $lt: endOfYear,
                },
                // C.3 (Tanda 2) FIX: mismo bug de status; usar ENUM_DONATE_STATUS.Paid.
                status: ENUM_DONATE_STATUS.Paid,
            },
        },
        {
            $group: {
                _id: { $month: '$createdAt' },
                totalEarning: { $sum: '$amount' }, // Sum amounts
            },
        },
        {
            $project: {
                month: '$_id',
                totalEarning: 1,
                _id: 0,
            },
        },
        {
            $sort: { month: 1 },
        },
    ]);

    const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];

    const data = Array.from({ length: 12 }, (_, index) => ({
        month: months[index],
        totalEarning:
            chartData.find((item) => item.month === index + 1)?.totalEarning ||
            0,
    }));

    const yearsResult = await Donate.aggregate([
        {
            $match: { status: ENUM_DONATE_STATUS.Paid },
        },
        {
            $group: {
                _id: { $year: '$createdAt' },
            },
        },
        {
            $project: {
                year: '$_id',
                _id: 0,
            },
        },
        {
            $sort: { year: 1 },
        },
    ]);

    const yearsDropdown = yearsResult.map((item: any) => item.year);

    return {
        chartData: data,
        yearsDropdown,
    };
};

/**
 * C.1 (Tanda 2) - Estadistica de donantes/donaciones (admin).
 * Cantidad de donantes distintos (usuarios que donaron) y monto total donado,
 * usando el modelo Donate con status 'Paid'.
 */
const getDonationStats = async () => {
    const [stats] = await Donate.aggregate([
        { $match: { status: ENUM_DONATE_STATUS.Paid } },
        {
            $group: {
                _id: null,
                totalAmount: { $sum: '$amount' },
                totalDonations: { $sum: 1 },
                uniqueDonors: { $addToSet: '$user' },
            },
        },
        {
            $project: {
                _id: 0,
                totalAmount: 1,
                totalDonations: 1,
                totalDonors: { $size: '$uniqueDonors' },
            },
        },
    ]);

    return {
        totalDonors: stats?.totalDonors || 0,
        totalDonationAmount: stats?.totalAmount || 0,
        totalDonations: stats?.totalDonations || 0,
    };
};

/**
 * C.2 (Tanda 2) - Conteo de usuarios por tipo de suscripcion (admin).
 * Devuelve las tres cantidades (Free, Standard=10 USD, Premium=25 USD) y el
 * total, que SIEMPRE coincide con el total de NormalUser (los usuarios sin
 * subscriptionType se cuentan como Free por el default del schema).
 */
const getSubscriptionStats = async () => {
    const grouped = await NormalUser.aggregate([
        {
            $group: {
                _id: '$subscriptionType',
                count: { $sum: 1 },
            },
        },
    ]);

    const counts: Record<string, number> = {
        [ENUM_SUBSCRIPTION_TYPE.Free]: 0,
        [ENUM_SUBSCRIPTION_TYPE.Standard]: 0,
        [ENUM_SUBSCRIPTION_TYPE.Premium]: 0,
    };

    for (const row of grouped) {
        // Usuarios sin subscriptionType (null/undefined) => Free.
        const key = row._id || ENUM_SUBSCRIPTION_TYPE.Free;
        counts[key] = (counts[key] || 0) + row.count;
    }

    const free = counts[ENUM_SUBSCRIPTION_TYPE.Free];
    const standard = counts[ENUM_SUBSCRIPTION_TYPE.Standard];
    const premium = counts[ENUM_SUBSCRIPTION_TYPE.Premium];

    return {
        free, // gratis
        standard, // 10 USD
        premium, // 25 USD
        total: free + standard + premium,
    };
};

/**
 * C.4 (Tanda 2) - Agregacion de usuarios para el mapa de calor (admin).
 *
 * NormalUser NO guarda coordenadas: solo un `address` (string, ciudad libre).
 * Las coordenadas reales viven en BondRequest.location (GeoJSON [lng, lat]).
 * Por eso se devuelven DOS agrupaciones:
 *  - byCoordinate: usuarios DISTINTOS agrupados por coordenada redondeada de sus
 *    bond requests => [{ lat, lng, count }] (ideal para dibujar los circulos).
 *  - byCity: usuarios agrupados por `address` de NormalUser => [{ city, count }]
 *    (fallback textual cuando no hay coordenadas).
 */
const getUserGeoAggregation = async () => {
    // --- Por coordenada (desde BondRequest, contando usuarios distintos) ---
    const byCoordinate = await BondRequest.aggregate([
        {
            $match: {
                'location.coordinates': { $exists: true, $type: 'array' },
            },
        },
        {
            // Redondear a ~2 decimales (~1.1 km) para agrupar puntos cercanos.
            $group: {
                _id: {
                    lng: {
                        $round: [
                            { $arrayElemAt: ['$location.coordinates', 0] },
                            2,
                        ],
                    },
                    lat: {
                        $round: [
                            { $arrayElemAt: ['$location.coordinates', 1] },
                            2,
                        ],
                    },
                },
                users: { $addToSet: '$user' },
            },
        },
        {
            $project: {
                _id: 0,
                lat: '$_id.lat',
                lng: '$_id.lng',
                count: { $size: '$users' },
            },
        },
        { $sort: { count: -1 } },
    ]);

    // --- Por ciudad (desde NormalUser.address) ---
    const byCity = await NormalUser.aggregate([
        {
            $match: {
                address: { $nin: [null, ''] },
            },
        },
        {
            $group: {
                _id: { $trim: { input: '$address' } },
                count: { $sum: 1 },
            },
        },
        {
            $project: {
                _id: 0,
                city: '$_id',
                count: 1,
            },
        },
        { $sort: { count: -1 } },
    ]);

    return { byCoordinate, byCity };
};

/**
 * Income (agosto 2026): ingresos por categoría a lo largo del tiempo, para el
 * panel "Income" del dashboard. Fuente: colección Transaction (los cobros reales
 * acreditados por PayPal/MercadoPago).
 *
 * Tres categorías, discriminadas SIN adivinar por monto:
 *  - Donación   -> type === 'Donation'
 *  - Standard   -> type === 'Subscription' && plan === 'Standard'
 *  - Premium    -> type === 'Subscription' && plan === 'Premium'
 *
 * `plan` empezó a guardarse en agosto/2026; las suscripciones ARS viejas no lo
 * tienen y por eso NO entran en Standard/Premium (decisión: robusto de acá en
 * adelante, las históricas no importan).
 *
 * USD (PayPal) y ARS (MercadoPago) NO se pueden sumar entre sí, así que SIEMPRE
 * se filtra por una moneda (el dashboard tiene un selector USD/ARS).
 * granularity: 'month' (12 meses de un año) | 'year' (total por año, todos).
 */
const getIncomeChartData = async (
    year: number,
    currency = 'USD',
    granularity = 'month'
) => {
    const cur = currency === 'ARS' ? 'ARS' : 'USD';

    // Para USD también contamos los registros sin `currency` (histórico
    // dolarizado anterior al campo; el default del schema es 'USD').
    const currencyMatch: any =
        cur === 'USD'
            ? { $or: [{ currency: 'USD' }, { currency: { $exists: false } }] }
            : { currency: 'ARS' };

    // Suma condicional del monto según la categoría (todo en un solo $group).
    const sumIf = (cond: any) => ({ $sum: { $cond: [cond, '$amount', 0] } });
    const isDonation = { $eq: ['$type', ENUM_TRANSACTION_TYPE.DONATION] };
    const isStandard = {
        $and: [
            { $eq: ['$type', ENUM_TRANSACTION_TYPE.SUBSCRIPTION] },
            { $eq: ['$plan', ENUM_SUBSCRIPTION_TYPE.Standard] },
        ],
    };
    const isPremium = {
        $and: [
            { $eq: ['$type', ENUM_TRANSACTION_TYPE.SUBSCRIPTION] },
            { $eq: ['$plan', ENUM_SUBSCRIPTION_TYPE.Premium] },
        ],
    };

    // Años con datos en la moneda elegida (para el selector del dashboard).
    const yearsResult = await Transaction.aggregate([
        { $match: currencyMatch },
        { $group: { _id: { $year: '$createdAt' } } },
        { $project: { year: '$_id', _id: 0 } },
        { $sort: { year: 1 } },
    ]);
    const yearsDropdown = yearsResult.map((r: any) => r.year);

    // ---- Modo anual: total por año, todos los años ----
    if (granularity === 'year') {
        const yearAgg = await Transaction.aggregate([
            { $match: currencyMatch },
            {
                $group: {
                    _id: { $year: '$createdAt' },
                    donation: sumIf(isDonation),
                    standard: sumIf(isStandard),
                    premium: sumIf(isPremium),
                },
            },
            { $sort: { _id: 1 } },
        ]);

        const yearChart = yearAgg.map((r: any) => ({
            period: String(r._id),
            donation: r.donation || 0,
            standard: r.standard || 0,
            premium: r.premium || 0,
        }));

        return {
            chartData: yearChart,
            yearsDropdown,
            currency: cur,
            granularity: 'year',
        };
    }

    // ---- Modo mensual: 12 meses de un año ----
    const currentYear = year || new Date().getFullYear();
    const startOfYear = new Date(currentYear, 0, 1);
    const endOfYear = new Date(currentYear + 1, 0, 1);

    const monthAgg = await Transaction.aggregate([
        {
            $match: {
                ...currencyMatch,
                createdAt: { $gte: startOfYear, $lt: endOfYear },
            },
        },
        {
            $group: {
                _id: { $month: '$createdAt' },
                donation: sumIf(isDonation),
                standard: sumIf(isStandard),
                premium: sumIf(isPremium),
            },
        },
        { $sort: { _id: 1 } },
    ]);

    const months = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
    ];

    const chartData = Array.from({ length: 12 }, (_, index) => {
        const found = monthAgg.find((r: any) => r._id === index + 1);
        return {
            period: months[index],
            donation: found?.donation || 0,
            standard: found?.standard || 0,
            premium: found?.premium || 0,
        };
    });

    return {
        chartData,
        yearsDropdown,
        currency: cur,
        granularity: 'month',
    };
};

const MetaService = {
    getDashboardMetaData,
    getIncomeChartData,
    getUserChartData,
    getAudioPieChartData,
    donorGrowthChartData,
    getInstitutionChartData,
    bondChartData,
    getEarningChartData,
    getDonationStats,
    getSubscriptionStats,
    getUserGeoAggregation,
};

export default MetaService;
