import Bond from './bond.model';
import AppError from '../../error/appError';
import httpStatus from 'http-status';
import { IBond } from './bond.interface';
import QueryBuilder from '../../builder/QueryBuilder';
import mongoose from 'mongoose';

const createBondIntoDB = async (userId: string, payload: IBond) => {
    // Allowlist (anti mass-assignment, same as update): `user` is forced.
    return await Bond.create({
        offer: payload.offer,
        want: payload.want,
        tag: payload.tag,
        user: userId,
    });
};

const getMyBonds = async (userId: string, query: Record<string, unknown>) => {
    const resultQuery = new QueryBuilder(Bond.find({ user: userId }), query)
        .search(['name'])
        .fields()
        .filter()
        .paginate()
        .sort();

    const result = await resultQuery.modelQuery;
    const meta = await resultQuery.countTotal();
    return {
        meta,
        result,
    };
};

const getSingleBond = async (id: string) => {
    // Narrow populate: plain `populate('user')` returned the owner's FULL profile
    // (email/phone/address/dateOfBirth...). Only public fields are exposed.
    const bond = await Bond.findById(id).populate({
        path: 'user',
        select: 'name profile_image',
    });
    if (!bond) throw new AppError(httpStatus.NOT_FOUND, 'Bond not found');
    return bond;
};

const updateBondIntoDB = async (
    userId: string,
    id: string,
    payload: Partial<IBond>
) => {
    const bond = await Bond.findOne({ _id: id, user: userId });
    if (!bond) throw new AppError(httpStatus.NOT_FOUND, 'Bond not found');

    // Mass-assignment: only editable fields (validateRequest doesn't trim the
    // body). Without this a user could inject `user` and reassign the bond.
    const safePayload: Partial<IBond> = {};
    for (const k of ['offer', 'want', 'tag'] as const) {
        if ((payload as any)[k] !== undefined) {
            (safePayload as any)[k] = (payload as any)[k];
        }
    }

    return await Bond.findByIdAndUpdate(id, safePayload, { new: true });
};

const deleteBondFromDB = async (userId: string, id: string) => {
    const bond = await Bond.findOne({ user: userId, _id: id });
    if (!bond) throw new AppError(httpStatus.NOT_FOUND, 'Bond not found');

    return await Bond.findByIdAndDelete(id);
};

const getFilterItemsForMatchingBond = async (userId: string) => {
    const result = await Bond.aggregate([
        {
            $match: {
                user: new mongoose.Types.ObjectId(userId),
            },
        },
        {
            $group: {
                _id: null,
                wantItems: { $addToSet: '$want' },
                offerItems: { $addToSet: '$offer' },
            },
        },
    ]);

    if (result.length > 0) {
        return {
            wantItems: result[0].wantItems,
            offerItems: result[0].offerItems,
        };
    } else {
        return {
            wantItems: [],
            offerItems: [],
        };
    }
};

const bondService = {
    createBondIntoDB,
    getMyBonds,
    getSingleBond,
    updateBondIntoDB,
    deleteBondFromDB,
    getFilterItemsForMatchingBond,
};

export default bondService;
