/* eslint-disable @typescript-eslint/no-explicit-any */
import Audio from '../audio/audio.model';
import { ENUM_BOND_LINK_STATUS } from '../bondLink/bondLink.enum';
import { BondLink } from '../bondLink/bondLink.model';
import BondRequest from '../bondRequest/bondRequest.model';
import { ENUM_DONATE_STATUS } from '../donate/donate.enum';
import { Donate } from '../donate/donate.model';
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
            // Donate stores status 'Paid' (ENUM_DONATE_STATUS), not 'PAID'; the old match never hit.
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

    // Fill missing months so the chart always has 12 points.
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

    // Years that have bonds, for the dropdown.
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
                // Same status bug as above: must use ENUM_DONATE_STATUS.Paid.
                status: ENUM_DONATE_STATUS.Paid,
            },
        },
        {
            $group: {
                _id: { $month: '$createdAt' },
                totalEarning: { $sum: '$amount' },
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
 * Donation stats (admin): distinct donors, total amount and count, using Donate status 'Paid'.
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
 * Users per subscription type (admin). Total always equals the NormalUser count:
 * users without `subscriptionType` count as Free via the schema default.
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
        // Users without subscriptionType (null/undefined) count as Free.
        const key = row._id || ENUM_SUBSCRIPTION_TYPE.Free;
        counts[key] = (counts[key] || 0) + row.count;
    }

    const free = counts[ENUM_SUBSCRIPTION_TYPE.Free];
    const standard = counts[ENUM_SUBSCRIPTION_TYPE.Standard];
    const premium = counts[ENUM_SUBSCRIPTION_TYPE.Premium];

    return {
        free, // free
        standard, // 10 USD
        premium, // 25 USD
        total: free + standard + premium,
    };
};

/**
 * Geo aggregation for the heat map (admin). NormalUser has no coordinates, only an
 * `address`; real coords live in BondRequest.location. Returns byCoordinate (distinct
 * users per rounded point) and byCity (textual fallback).
 */
const getUserGeoAggregation = async () => {
    // --- By coordinate (from BondRequest, counting distinct users) ---
    const byCoordinate = await BondRequest.aggregate([
        {
            $match: {
                'location.coordinates': { $exists: true, $type: 'array' },
            },
        },
        {
            // Round to ~2 decimals (~1.1 km) to group nearby points.
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

    // --- By city (from NormalUser.address) ---
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
 * Income per category for the dashboard, from Transaction (real charges settled by
 * PayPal/MercadoPago). Categories by type/plan: Donation, Standard, Premium; old ARS
 * subscriptions have no `plan` so they fall outside Standard/Premium. USD and ARS are
 * never summed together (always filter by one currency). `granularity` is 'month' or 'year'.
 */
const getIncomeChartData = async (
    year: number,
    currency = 'USD',
    granularity = 'month'
) => {
    const cur = currency === 'ARS' ? 'ARS' : 'USD';

    // For USD also count records with no `currency` (pre-field history; schema default is 'USD').
    const currencyMatch: any =
        cur === 'USD'
            ? { $or: [{ currency: 'USD' }, { currency: { $exists: false } }] }
            : { currency: 'ARS' };

    // Conditional sum of amount per category (all in one $group).
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

    // Years with data in the chosen currency (for the dashboard selector).
    const yearsResult = await Transaction.aggregate([
        { $match: currencyMatch },
        { $group: { _id: { $year: '$createdAt' } } },
        { $project: { year: '$_id', _id: 0 } },
        { $sort: { year: 1 } },
    ]);
    const yearsDropdown = yearsResult.map((r: any) => r.year);

    // ---- Yearly mode: total per year, all years ----
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

    // ---- Monthly mode: 12 months of one year ----
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
    bondChartData,
    getEarningChartData,
    getDonationStats,
    getSubscriptionStats,
    getUserGeoAggregation,
};

export default MetaService;
