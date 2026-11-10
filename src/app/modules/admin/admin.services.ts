/* eslint-disable @typescript-eslint/no-explicit-any */

import QueryBuilder from '../../builder/QueryBuilder';

import bcrypt from 'bcrypt';
import httpStatus from 'http-status';
import mongoose from 'mongoose';
import config from '../../config';
import AppError from '../../error/appError';
import { USER_ROLE } from '../user/user.constant';
import { TUser } from '../user/user.interface';
import { User } from '../user/user.model';
import { IAdmin } from './admin.interface';
import Admin from './admin.model';

const createAdmin = async (payload: IAdmin & { password: string }) => {
    const { password } = payload;
    // Explicit whitelist: spreading payload let the client set _id, user or isDeleted.
    const adminData: Partial<IAdmin> = {
        name: payload.name,
        email: payload.email,
        phoneNumber: payload.phoneNumber,
        profile_image: payload.profile_image,
    };
    const admin = await User.isUserExists(payload.email);
    if (admin) {
        throw new AppError(httpStatus.BAD_REQUEST, 'This admin already exists');
    }
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const userData: Partial<TUser> = {
            email: adminData?.email,
            phone: adminData?.phoneNumber,
            password: password,
            role: USER_ROLE.admin,
            isActive: true,
            isVerified: true,
        };

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const user = await User.create([userData], { session });

        const adminPayload = {
            ...adminData,
            user: user[0]._id,
        };
        const admin = await Admin.create([adminPayload], { session });
        await User.findByIdAndUpdate(
            user[0]._id,
            { profileId: admin[0]._id },
            { session }
        );

        await session.commitTransaction();
        session.endSession();

        return admin[0];
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        throw error;
    }
};

const updateAdminProfile = async (
    id: string,
    payload: Partial<IAdmin> & { password: string }
) => {
    // Check the `:id` IS an Admin before writing: the old order could change the
    // password of a User whose profileId matched, then answer 200 with data: null.
    const admin = await Admin.findById(id).select('_id');
    if (!admin) {
        throw new AppError(httpStatus.NOT_FOUND, 'Admin not found');
    }

    if (payload.password) {
        const hashedPassword = await bcrypt.hash(
            payload.password,
            Number(config.bcrypt_salt_rounds)
        );
        await User.findOneAndUpdate(
            { profileId: id },
            {
                password: hashedPassword,
                // Required: auth middleware compares this against token iat, so
                // without it an admin password change left old sessions alive.
                passwordChangedAt: new Date(),
            }
        );
    }
    // Email is identity (login uses User.email): reject only a real attempt to change
    // it, because the edit modal always submits the field.
    if (payload.email) {
        const actual = await Admin.findById(id).select('email').lean();
        if (actual && payload.email !== actual.email) {
            throw new AppError(
                httpStatus.BAD_REQUEST,
                'Email cannot be changed from here'
            );
        }
    }

    // Depth defense: validateRequest doesn't replace req.body, so extra fields still
    // arrive; accept only the editable ones (no user, isDeleted, _id, email).
    const safePayload: Partial<IAdmin> = {};
    for (const key of ['name', 'phoneNumber', 'profile_image'] as const) {
        if (payload[key] !== undefined) safePayload[key] = payload[key];
    }

    const result = await Admin.findByIdAndUpdate(id, safePayload, {
        new: true,
        runValidators: true,
    });
    return result;
};

const deleteAdminFromDB = async (id: string) => {
    const session = await mongoose.startSession();

    try {
        session.startTransaction();

        const admin = await Admin.findById(id).session(session);
        if (!admin) {
            throw new AppError(httpStatus.NOT_FOUND, 'Admin not found');
        }

        await User.findByIdAndDelete(admin.user).session(session);
        await Admin.findByIdAndDelete(id).session(session);

        await session.commitTransaction();
        return null;
    } catch (error) {
        await session.abortTransaction();
        throw error;
    } finally {
        session.endSession();
    }
};

const getAllAdminFromDB = async (query: Record<string, any>) => {
    const AdminQuery = new QueryBuilder(
        Admin.find().populate({ path: 'user', select: 'isBlocked' }),
        query
    )
        .search(['name'])
        .fields()
        .filter()
        .paginate()
        .sort();
    const meta = await AdminQuery.countTotal();
    const result = await AdminQuery.modelQuery;

    return {
        meta,
        result,
    };
};

const getSingleAdmin = async (id: string) => {
    const result = await Admin.findById(id).populate({
        path: 'user',
        select: 'isBlocked',
    });
    return result;
};

const AdminServices = {
    createAdmin,
    updateAdminProfile,
    getAllAdminFromDB,
    deleteAdminFromDB,
    getSingleAdmin,
};

export default AdminServices;
