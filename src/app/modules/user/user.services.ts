/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-unused-vars */

import { randomInt } from 'crypto';
import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import mongoose from 'mongoose';
import cron from 'node-cron';
import config from '../../config';
import AppError from '../../error/appError';
import registrationSuccessEmailBody from '../../mailTemplate/registerSucessEmail';
import sendEmail from '../../utilities/sendEmail';
import Audio from '../audio/audio.model';
import Admin from '../admin/admin.model';
import { INormalUser } from '../normalUser/normalUser.interface';
import NormalUser from '../normalUser/normalUser.model';
import { IRecommendedUser } from '../recommendedUser/recommendedUser.interface';
import { RecommendedUser } from '../recommendedUser/recommendedUser.model';
import SuperAdmin from '../superAdmin/superAdmin.model';
import { USER_ROLE } from './user.constant';
import cascadeDeleteUserData from './cascadeDelete';
import { TUser, TUserRole } from './user.interface';
import { User } from './user.model';
import { createToken } from './user.utils';
// C2 hardening: OTP via CSPRNG (crypto.randomInt), not predictable Math.random.
// randomInt(min, max) is [min, max) → 6 digits.
const generateVerifyCode = (): number => {
    return randomInt(100000, 1000000);
};

// C2 hardening: after MAX_VERIFY_ATTEMPTS failures the account's verification is
// locked for VERIFY_LOCK_MINUTES (defense in depth over the per-IP authLimiter).
const MAX_VERIFY_ATTEMPTS = 5;
const VERIFY_LOCK_MINUTES = 15;
const registerUser = async (
    payload: INormalUser & {
        password: string;
        confirmPassword: string;
        recommendedUsers?: IRecommendedUser[];
    }
) => {
    const { password, confirmPassword, ...userData } = payload;
    if (password !== confirmPassword) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            "Password and confirm password doesn't match"
        );
    }

    const emailExist = await User.findOne({ email: userData.email });
    if (emailExist) {
        throw new AppError(httpStatus.BAD_REQUEST, 'This email already exist');
    }
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const verifyCode = generateVerifyCode();
        const userDataPayload: Partial<TUser> = {
            email: userData?.email,
            password: password,
            role: USER_ROLE.user,
            verifyCode,
            codeExpireIn: new Date(Date.now() + 5 * 60000),
        };

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const user = await User.create([userDataPayload], { session });

        // Security (mass-assignment): never spread the raw body into NormalUser.
        // The signup schema isn't `.strict()` and validateRequest doesn't trim, so
        // otherwise a registrant could set subscriptionType/bondLimit/reputation/
        // bondsPublic/listedInPeople. Same rule as PROFILE_EDITABLE_FIELDS.
        const REGISTER_ALLOWED_FIELDS: (keyof INormalUser)[] = [
            'name',
            'email',
            'phone',
            'profile_image',
            'cover_image',
            'gender',
            'dateOfBirth',
            'address',
            'bio',
            // `skills` was missing: signup collects them and the backend dropped
            // them silently. Not sensitive — already in PROFILE_EDITABLE_FIELDS.
            'skills',
        ];
        const normalUserPayload: Record<string, unknown> = {
            user: user[0]._id,
        };
        for (const key of REGISTER_ALLOWED_FIELDS) {
            if (userData[key] !== undefined) {
                normalUserPayload[key] = userData[key];
            }
        }
        const result = await NormalUser.create([normalUserPayload], {
            session,
        });

        await User.findByIdAndUpdate(
            user[0]._id,
            { profileId: result[0]._id },
            { session }
        );

        // DORMANT FEATURE (recommendedUsers): public signup does NOT seed
        // recommendees. It used to read the raw body, letting an anonymous user
        // mass-assign rows (P0). Flag OFF by default; flip to re-enable.
        const ALLOW_SIGNUP_RECOMMENDED_SEED =
            process.env.ALLOW_SIGNUP_RECOMMENDED_SEED === 'true';
        if (
            ALLOW_SIGNUP_RECOMMENDED_SEED &&
            payload.recommendedUsers &&
            payload.recommendedUsers.length > 0
        ) {
            const updatedUsers = payload.recommendedUsers.map((rmUser: any) => {
                return {
                    recommendBy: result[0]._id,
                    ...rmUser,
                    recommendByUserId: user[0]._id,
                };
            });
            await RecommendedUser.insertMany(updatedUsers, { session });
        }

        // Console OTP for easy development / debugging
        console.log(`\n========================================`);
        console.log(`🔑 Registration OTP for [${userData.email}]: ${user[0].verifyCode}`);
        console.log(`========================================\n`);

        sendEmail({
            email: userData.email,
            subject: 'Activate Your Account',
            html: registrationSuccessEmailBody(
                result[0].name,
                user[0].verifyCode
            ),
        });

        await session.commitTransaction();
        session.endSession();

        return result[0];
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        throw error;
    }
};

const verifyCode = async (email: string, verifyCode: number) => {
    const user = await User.findOne({ email: email });
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }
    // C2 hardening: temporary per-account lockout after too many failures.
    if (
        user.verifyBlockedUntil &&
        new Date(user.verifyBlockedUntil) > new Date(Date.now())
    ) {
        // Literal 429 so we don't depend on the http-status name variant installed.
        throw new AppError(
            429,
            'Too many attempts. Please wait a few minutes and try again.'
        );
    }
    if (user.codeExpireIn < new Date(Date.now())) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Verify code is expired');
    }
    if (verifyCode !== user.verifyCode) {
        // C2 hardening: each failure counts; at the cap the account is locked and
        // the counter resets. Counting is ATOMIC ($inc): the old read-modify-write
        // lost increments under concurrency, making the lockout bypassable.
        const updated = await User.findOneAndUpdate(
            { email: email },
            { $inc: { verifyAttempts: 1 } },
            { new: true }
        );
        if ((updated?.verifyAttempts || 0) >= MAX_VERIFY_ATTEMPTS) {
            await User.updateOne(
                { email: email },
                {
                    verifyAttempts: 0,
                    verifyBlockedUntil: new Date(
                        Date.now() + VERIFY_LOCK_MINUTES * 60000
                    ),
                }
            );
        }
        throw new AppError(httpStatus.BAD_REQUEST, "Code doesn't match");
    }
    // Success: verify, reset attempts/lockout and INVALIDATE the code (expiry in
    // the past) so it can't be reused.
    const result = await User.findOneAndUpdate(
        { email: email },
        {
            isVerified: true,
            verifyAttempts: 0,
            verifyBlockedUntil: null,
            codeExpireIn: new Date(0),
        },
        { new: true, runValidators: true }
    );

    if (!result) {
        throw new AppError(
            httpStatus.SERVICE_UNAVAILABLE,
            'Server temporary unable please try again letter'
        );
    }

    const jwtPayload = {
        id: result?._id,
        profileId: result?.profileId,
        email: result?.email,
        role: result?.role as TUserRole,
    };

    const accessToken = createToken(
        jwtPayload,
        config.jwt_access_secret as string,
        config.jwt_access_expires_in as string
    );
    const refreshToken = createToken(
        jwtPayload,
        config.jwt_refresh_secret as string,
        config.jwt_refresh_expires_in as string
    );

    return {
        accessToken,
        refreshToken,
    };
};

const resendVerifyCode = async (email: string) => {
    const user = await User.findOne({ email: email });
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }
    const verifyCode = generateVerifyCode();
    // C2 hardening: a NEW code resets the attempt budget (0) but does NOT clear an
    // active lockout, so resending can't bypass it.
    const updateUser = await User.findOneAndUpdate(
        { email: email },
        {
            verifyCode: verifyCode,
            codeExpireIn: new Date(Date.now() + 5 * 60000),
            verifyAttempts: 0,
        },
        { new: true, runValidators: true }
    );
    if (!updateUser) {
        throw new AppError(
            httpStatus.INTERNAL_SERVER_ERROR,
            'Something went wrong . Please again resend the code after a few second'
        );
    }
    // Console Resend OTP for easy development / debugging
    console.log(`\n========================================`);
    console.log(`🔑 Resend Registration OTP for [${user.email}]: ${updateUser.verifyCode}`);
    console.log(`========================================\n`);

    sendEmail({
        email: user.email,
        subject: 'Activate Your Account',
        html: registrationSuccessEmailBody('Dear', updateUser.verifyCode),
    });
    return null;
};

const deleteUserAccount = async (user: JwtPayload, password: string) => {
    const userData = await User.findById(user.id).select('+password');

    if (!userData) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }
    if (!(await User.isPasswordMatched(password, userData?.password))) {
        throw new AppError(httpStatus.FORBIDDEN, 'Password do not match');
    }

    // Cascade delete, atomic where transactions are supported (Atlas replica set).
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await cascadeDeleteUserData(user.profileId, session);
            await NormalUser.findByIdAndDelete(user.profileId).session(session);
            await User.findByIdAndDelete(user.id).session(session);
        });
    } catch (err: any) {
        // Sequential fallback ONLY when the environment lacks transactions
        // (standalone Mongo). Any other error propagates: blind retries risk orphans.
        const message: string = err?.message || '';
        const code = err?.code ?? err?.codeName;
        const isTxnUnsupported =
            code === 20 ||
            code === 263 ||
            code === 'IllegalOperation' ||
            err?.codeName === 'IllegalOperation' ||
            /Transaction numbers are only allowed on a replica set/i.test(
                message
            );

        if (!isTxnUnsupported) {
            throw err;
        }

        // No transactions (standalone Mongo): best-effort sequential delete.
        await cascadeDeleteUserData(user.profileId);
        await NormalUser.findByIdAndDelete(user.profileId);
        await User.findByIdAndDelete(user.id);
    } finally {
        session.endSession();
    }

    return null;
};

const getMyProfile = async (userData: JwtPayload) => {
    if (userData.role === USER_ROLE.user) {
        return NormalUser.findOne({ email: userData.email });
    }
    if (userData.role === USER_ROLE.admin) {
        return Admin.findOne({ email: userData.email, isDeleted: false });
    }
    if (userData.role === USER_ROLE.superAdmin) {
        return SuperAdmin.findOne({ email: userData.email });
    }
    return null;
};

// User cleanup cron jobs.

cron.schedule('*/2 * * * *', async () => {
    try {
        const now = new Date();

        // Security (defense in depth, P0): only accounts created within the last
        // 24h are swept — incomplete recent signups. This guarantees an ESTABLISHED
        // account is never auto-deleted even if some path leaves it isVerified:false.
        const deletableSince = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const expiredUsers = await User.find({
            isVerified: false,
            codeExpireIn: { $lte: now },
            createdAt: { $gte: deletableSince },
        });

        if (expiredUsers.length > 0) {
            const expiredUserIds = expiredUsers.map((user) => user._id);

            const normalUserDeleteResult = await NormalUser.deleteMany({
                user: { $in: expiredUserIds },
            });

            const userDeleteResult = await User.deleteMany({
                _id: { $in: expiredUserIds },
            });

            const recommendedUserDeleteResult =
                await RecommendedUser.deleteMany({
                    recommendByUserId: { $in: expiredUserIds },
                });

            console.log(
                `Deleted ${userDeleteResult.deletedCount} expired inactive users`
            );
            console.log(
                `Deleted ${normalUserDeleteResult.deletedCount} associated NormalUser documents`
            );
            console.log(
                `Deleted ${recommendedUserDeleteResult.deletedCount} associated recommended user documents`
            );
        }
    } catch (error) {
        console.log('Error deleting expired users and associated data:', error);
    }
});

const changeUserStatus = async (id: string) => {
    const user = await User.findById(id);
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'User not found');
    }

    const result = await User.findByIdAndUpdate(
        id,
        { isBlocked: !user.isBlocked },
        { new: true, runValidators: true }
    );

    // Hide/show the user's audios. Audio.user stores the profileId (NormalUser._id),
    // NOT the User._id: filtering by `id` matched nothing, so blocking hid nothing.
    // Symmetric: unblocking reactivates them.
    if (user.profileId) {
        await Audio.updateMany(
            { user: user.profileId },
            { isBlocked: !user.isBlocked },
            { runValidators: true }
        );
    }

    return result;
};
const userServices = {
    registerUser,
    verifyCode,
    resendVerifyCode,
    getMyProfile,
    changeUserStatus,
    deleteUserAccount,
};

export default userServices;
