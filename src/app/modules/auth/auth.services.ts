/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-unused-vars */
import appleSigninAuth from 'apple-signin-auth';
import axios from 'axios';
import bcrypt from 'bcrypt';
import { randomBytes, randomInt } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import httpStatus from 'http-status';
import { JwtPayload } from 'jsonwebtoken';
import mongoose from 'mongoose';
import config from '../../config';
import AppError from '../../error/appError';
import resetPasswordEmailBody from '../../mailTemplate/resetPasswordEmailBody';
import registrationSuccessEmailBody from '../../mailTemplate/registerSucessEmail';
import sendEmail from '../../utilities/sendEmail';
import { esObjectIdUsable } from '../../utilities/objectId';
import NormalUser from '../normalUser/normalUser.model';
import { USER_ROLE } from '../user/user.constant';
import { TUserRole } from '../user/user.interface';
import { User } from '../user/user.model';
import { createToken, verifyToken } from '../user/user.utils';
import { TLoginUser } from './auth.interface';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
// OTP via CSPRNG (crypto.randomInt, not predictable Math.random) for password reset.
// randomInt(min, max) is [min, max) → 100000..999999.
const MAX_RESET_ATTEMPTS = 5;
const RESET_LOCK_MINUTES = 15;
const generateVerifyCode = (): number => {
    return randomInt(100000, 1000000);
};
const loginUserIntoDB = async (payload: TLoginUser) => {
    const user = await User.findOne({ email: payload.email }).select(
        '+password'
    );
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'This user does not exist');
    }
    if (user.isDeleted) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'This user is already deleted'
        );
    }
    if (user.isBlocked) {
        throw new AppError(httpStatus.FORBIDDEN, 'This user is blocked');
    }
    if (!user.isVerified) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'You are not verified user . Please verify your email'
        );
    }
    if (!(await User.isPasswordMatched(payload?.password, user?.password))) {
        throw new AppError(httpStatus.FORBIDDEN, 'Password do not match');
    }
    const jwtPayload = {
        id: user?._id,
        profileId: user.profileId,
        email: user?.email,
        role: user?.role as TUserRole,
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

const changePasswordIntoDB = async (
    userData: JwtPayload,
    payload: {
        oldPassword: string;
        newPassword: string;
        confirmNewPassword: string;
    }
) => {
    if (payload.newPassword !== payload.confirmNewPassword) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            "Password and confirm password doesn't match"
        );
    }
    const user = await User.findById(userData.id).select('+password');
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'This user does not exist');
    }
    if (user.isDeleted) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'This user is already deleted'
        );
    }
    if (user.isBlocked) {
        throw new AppError(httpStatus.FORBIDDEN, 'This user is blocked');
    }

    if (!(await User.isPasswordMatched(payload?.oldPassword, user?.password))) {
        throw new AppError(httpStatus.FORBIDDEN, 'Password do not match');
    }
    const newHashedPassword = await bcrypt.hash(
        payload.newPassword,
        Number(config.bcrypt_salt_rounds)
    );
    await User.findOneAndUpdate(
        {
            _id: userData.id,
            role: userData.role,
        },
        {
            password: newHashedPassword,
            passwordChangedAt: new Date(),
        }
    );

    const jwtPayload = {
        id: user?._id,
        profileId: user.profileId,
        email: user?.email,
        role: user?.role as TUserRole,
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

const refreshToken = async (token: string) => {
    const decoded = verifyToken(token, config.jwt_refresh_secret as string);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { username, email, iat, id } = decoded;

    // Same guard as auth.ts, more critical here: this route MINTS tokens.
    // User.findById(undefined) returns the first user (seeded superAdmin), so a
    // missing `id` would sign genuine admin credentials on a public, unthrottled route.
    if (!esObjectIdUsable(id)) {
        throw new AppError(
            httpStatus.UNAUTHORIZED,
            'Invalid refresh token',
            'INVALID_TOKEN'
        );
    }

    const user = await User.findById(id);
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'This user does not exist');
    }
    if (user.isDeleted) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'This user is already deleted'
        );
    }
    if (user.isBlocked) {
        throw new AppError(httpStatus.FORBIDDEN, 'This user is blocked');
    }
    // Defense in depth: unverified accounts must not renew access tokens
    // (same check and message as login).
    if (!user.isVerified) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'You are not verified user . Please verify your email'
        );
    }
    if (
        user?.passwordChangedAt &&
        (await User.isJWTIssuedBeforePasswordChange(
            user?.passwordChangedAt,
            iat as number
        ))
    ) {
        throw new AppError(httpStatus.FORBIDDEN, 'You are not authorized');
    }
    const jwtPayload = {
        id: user?._id,
        profileId: user?.profileId,
        email: user?.email,
        role: user?.role as TUserRole,
    };
    const accessToken = createToken(
        jwtPayload,
        config.jwt_access_secret as string,
        config.jwt_access_expires_in as string
    );
    return { accessToken };
};

const forgetPassword = async (email: string) => {
    const user = await User.findOne({ email: email });

    // Anti-enumeration: response is always the same, whether the account exists,
    // is deleted, or blocked. The code is generated and mailed only for a valid
    // account; the controller returns the generic text.
    if (user && !user.isDeleted && !user.isBlocked) {
        const resetCode = generateVerifyCode();
        await User.findOneAndUpdate(
            { email: email },
            {
                resetCode: resetCode,
                isResetVerified: false,
                codeExpireIn: new Date(Date.now() + 5 * 60000),
            }
        );

        // Dev only: print OTP for debugging
        console.log(`\n========================================`);
        console.log(`🔑 Password Reset OTP for [${user.email}]: ${resetCode}`);
        console.log(`========================================\n`);

        sendEmail({
            email: user.email,
            subject: 'Reset password code',
            html: resetPasswordEmailBody('Dear', resetCode),
        });
    }

    return null;

    // const jwtPayload = {
    //   id: user?._id,
    //   email: user?.email,
    //   role: user?.role as TUserRole,
    // };
    // const resetToken = createToken(
    //   jwtPayload,
    //   config.jwt_access_secret as string,
    //   '10m',
    // );
    // const resetUiLink = `${config.reset_password_ui_link}?${user._id}&token=${resetToken}`;
    // const emailContent = generateResetPasswordEmail(resetUiLink);

    // // Send the email
    // sendEmail(user?.email, 'Reset your password within 10 mins!', emailContent);
};

const verifyResetOtp = async (email: string, resetCode: number) => {
    const user = await User.findOne({ email: email });
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'This user does not exist');
    }
    if (user.isDeleted) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'This user is already deleted'
        );
    }
    if (user.isBlocked) {
        throw new AppError(httpStatus.FORBIDDEN, 'This user is blocked');
    }

    // Per-account lockout on top of the per-IP rate limit: closes distributed
    // brute force of the 6-digit OTP across many IPs.
    if (user.resetBlockedUntil && user.resetBlockedUntil > new Date()) {
        throw new AppError(
            httpStatus.TOO_MANY_REQUESTS,
            'Demasiados intentos. Probá de nuevo en unos minutos.'
        );
    }

    if (user.codeExpireIn < new Date(Date.now())) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Reset code is expire');
    }
    if (user.resetCode !== Number(resetCode)) {
        // Atomic $inc: read-modify-write lost concurrent increments, making the
        // lockout bypassable by parallelizing. Block once the incremented value
        // reaches the cap.
        const updated = await User.findOneAndUpdate(
            { email: email },
            { $inc: { resetAttempts: 1 } },
            { new: true }
        );
        if ((updated?.resetAttempts ?? 0) >= MAX_RESET_ATTEMPTS) {
            await User.updateOne(
                { email: email },
                {
                    resetBlockedUntil: new Date(
                        Date.now() + RESET_LOCK_MINUTES * 60000
                    ),
                }
            );
        }
        throw new AppError(httpStatus.BAD_REQUEST, 'Reset code is invalid');
    }
    await User.findOneAndUpdate(
        { email: email },
        {
            isResetVerified: true,
            // Fresh window to finish the password change: resetPassword requires
            // codeExpireIn > now, so the reset permission does not stay open forever.
            codeExpireIn: new Date(Date.now() + 10 * 60000),
            // Success also clears the attempt counter and lockout.
            resetAttempts: 0,
            resetBlockedUntil: null,
        },
        { new: true, runValidators: true }
    );
    return null;
};

const resetPassword = async (payload: {
    email: string;
    password: string;
    confirmPassword: string;
}) => {
    if (payload.password !== payload.confirmPassword) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            "Password and confirm password doesn't match"
        );
    }
    const user = await User.findOne({ email: payload.email });
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'This user does not exist');
    }
    if (!user.isResetVerified) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'You need to verify reset code before reset password'
        );
    }

    if (user.isDeleted) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'This user is already deleted'
        );
    }
    if (user.isBlocked) {
        throw new AppError(httpStatus.FORBIDDEN, 'This user is blocked');
    }
    // verify token -------------
    // const decoded = jwt.verify(
    //   token,
    //   config.jwt_access_secret as string,
    // ) as JwtPayload;
    // // console.log(decoded.userId, payload.id);
    // if (decoded?.userId !== payload?.email) {
    //   throw new AppError(
    //     httpStatus.FORBIDDEN,
    //     'You are forbidden to access this',
    //   );
    // }

    const newHashedPassword = await bcrypt.hash(
        payload.password,
        Number(config.bcrypt_salt_rounds)
    );
    // Consume the verified flag only while still valid (codeExpireIn > now), in one
    // atomic write: otherwise the reset window is unbounded (account takeover) and
    // concurrent requests can slip through (TOCTOU).
    const consumed = await User.findOneAndUpdate(
        {
            email: payload.email,
            isResetVerified: true,
            codeExpireIn: { $gt: new Date() },
        },
        {
            password: newHashedPassword,
            passwordChangedAt: new Date(),
            isResetVerified: false,
            resetCode: null,
        },
        { new: true }
    );
    if (!consumed) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Reset session expired, please request a new code'
        );
    }
    const jwtPayload = {
        id: user?._id,
        profileId: user?.profileId,
        email: user?.email,
        role: user?.role as TUserRole,
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

    return { accessToken, refreshToken };
};

const resendResetCode = async (email: string) => {
    const user = await User.findOne({ email: email });

    // Anti-enumeration: same policy as forgetPassword. Response is always the
    // same; code is generated and mailed only for a valid account.
    if (user && !user.isDeleted && !user.isBlocked) {
        const resetCode = generateVerifyCode();
        await User.findOneAndUpdate(
            { email: email },
            {
                resetCode: resetCode,
                isResetVerified: false,
                codeExpireIn: new Date(Date.now() + 5 * 60000),
            }
        );

        // Dev only: print OTP for debugging
        console.log(`\n========================================`);
        console.log(`🔑 Resend Password Reset OTP for [${user.email}]: ${resetCode}`);
        console.log(`========================================\n`);

        sendEmail({
            email: user.email,
            subject: 'Reset password code',
            html: resetPasswordEmailBody('Dear', resetCode),
        });
    }

    return null;
};
const resendVerifyCode = async (email: string) => {
    const user = await User.findOne({ email: email });
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'This user does not exist');
    }
    if (user.isDeleted) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'This user is already deleted'
        );
    }
    if (user.isBlocked) {
        throw new AppError(httpStatus.FORBIDDEN, 'This user is blocked');
    }
    // SECURITY (P0): this route is public and only asks for an email. Unverifying
    // an active account would let the cleanup cron delete it within minutes, so
    // anyone knowing an email could erase it. A verified account has nothing to
    // resend, and isVerified is never lowered here.
    if (user.isVerified) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'This account is already verified'
        );
    }

    const verifyCode = generateVerifyCode();
    await User.findOneAndUpdate(
        { email: email },
        {
            verifyCode: verifyCode,
            codeExpireIn: new Date(Date.now() + 5 * 60000),
        }
    );

    // Dev only: print OTP for debugging
    console.log(`\n========================================`);
    console.log(`🔑 Resend Verify Registration OTP for [${user.email}]: ${verifyCode}`);
    console.log(`========================================\n`);

    // Account verification code, not a reset: reuse the signup mail so the user
    // is not confused.
    sendEmail({
        email: user.email,
        subject: 'Activate Your Account',
        html: registrationSuccessEmailBody('Dear', verifyCode),
    });

    return null;
};

const loginWithOAuth = async (
    provider: string,
    token: string,
    role: TUserRole
) => {
    // Security: Google only for now. Facebook/Apple do not validate audience or
    // verified email equivalently (account-takeover risk when linking by email).
    if (provider !== 'google') {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'Por ahora solo se puede iniciar sesion con Google.'
        );
    }

    let email, id, name, picture;

    try {
        if (provider === 'google') {
            const ticket = await googleClient.verifyIdToken({
                idToken: token,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
            const payload = ticket.getPayload();
            if (!payload) {
                throw new AppError(httpStatus.BAD_REQUEST, 'Invalid token');
            }
            email = payload.email!;
            id = payload.sub;
            name = payload.name!;
            picture = payload.picture!;
            // Anti pre-account-takeover: only trust a verified Google email before
            // linking it to an existing account.
            if (!payload.email_verified) {
                throw new AppError(
                    httpStatus.FORBIDDEN,
                    'Tu email de Google no esta verificado; no podemos iniciar sesion asi.'
                );
            }
        } else if (provider === 'facebook') {
            const response: any = await axios.get(
                `https://graph.facebook.com/me?fields=id,email,name,picture&access_token=${token}`
            );
            email = response.data.email;
            id = response.data.id;
            name = response.data.name;
            picture = response.data.picture.data.url;
        } else if (provider === 'apple') {
            const appleUser = await appleSigninAuth.verifyIdToken(token, {
                audience: process.env.APPLE_CLIENT_ID!,
                ignoreExpiration: false,
            });
            email = appleUser.email;
            id = appleUser.sub;
            name = 'Apple User';
        } else {
            throw new AppError(
                httpStatus.BAD_REQUEST,
                'Invalid token, Please try again'
            );
        }

        let user = await User.findOne({ [`${provider}Id`]: id });

        // No user with this provider id but an account already has the email: link
        // the provider to it instead of creating a duplicate (unique email would
        // fail). findByIdAndUpdate avoids re-hashing the existing password.
        if (!user) {
            const existingByEmail = await User.findOne({ email });
            if (existingByEmail) {
                if (existingByEmail.isBlocked || existingByEmail.isDeleted) {
                    throw new AppError(
                        httpStatus.FORBIDDEN,
                        'Your account is blocked or deleted'
                    );
                }
                user = await User.findByIdAndUpdate(
                    existingByEmail._id,
                    { [`${provider}Id`]: id, isVerified: true },
                    { new: true }
                );
            }
        }

        if (!user) {
            user = new User({
                email,
                [`${provider}Id`]: id,
                name,
                profilePic: picture,
                // Random password: social users sign in via the provider, but /login
                // does not exclude them and isVerified is true, so this is a live
                // credential. 32 crypto bytes; the old Math.random()+Date.now() was
                // guessable.
                password: randomBytes(32).toString('base64url'),
                // Security: never accept the client role on social signup
                role: USER_ROLE.user,
                // The provider already verified the email (Google enforced above);
                // otherwise the default isVerified:false makes the auth middleware
                // reject the user on every protected route.
                isVerified: true,
            });
            await user.save();

            const result = await NormalUser.create({
                user: user._id,
                name: name || (email ? email.split('@')[0] : 'User'),
                email: email,
                profile_image: picture,
            });
            // { new: true } is required: without it findByIdAndUpdate returns the OLD
            // doc (no profileId) and the token is signed with profileId=undefined.
            const updatedUser = await User.findByIdAndUpdate(
                user._id,
                { profileId: result._id },
                { new: true }
            );
            user = updatedUser;
        }
        if (!user) {
            throw new AppError(httpStatus.NOT_FOUND, 'user not found');
        }

        // Security: no tokens for blocked/deleted accounts, including users who
        // already had the provider linked (the findOne skipped the email check).
        if (user.isBlocked || user.isDeleted) {
            throw new AppError(
                httpStatus.FORBIDDEN,
                'Your account is blocked or deleted'
            );
        }

        // Self-heal: a social login with verified email proves identity, so mark the
        // account verified to keep the auth middleware from blocking protected routes.
        if (user && !user.isVerified) {
            const healed = await User.findByIdAndUpdate(
                user._id,
                { isVerified: true },
                { new: true }
            );
            if (healed) user = healed;
        }

        // Self-heal profileId: social signup saves the User, then creates the
        // NormalUser outside a transaction. If that fails, the retry finds the user
        // and never re-runs the profile creation. Lookup by FK, then by unique email.
        if (user && !esObjectIdUsable(user.profileId)) {
            const perfil =
                (await NormalUser.findOne({ user: user._id }).select('_id')) ||
                (user.email
                    ? await NormalUser.findOne({ email: user.email }).select('_id')
                    : null);
            if (perfil) {
                const healed = await User.findByIdAndUpdate(
                    user._id,
                    { profileId: perfil._id },
                    { new: true }
                );
                if (healed) user = healed;
            }
        }

        const jwtPayload = {
            id: user?._id,
            profileId: user?.profileId,
            email: user?.email,
            role: user?.role as TUserRole,
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

        return { accessToken, refreshToken };
    } catch (error) {
        // Preserve intentional AppErrors (400/403/404); only unexpected provider
        // failures fall through to 500.
        if (error instanceof AppError) throw error;
        console.error(error);
        throw new AppError(
            httpStatus.INTERNAL_SERVER_ERROR,
            'Something went wrong'
        );
    }
};

const authServices = {
    loginUserIntoDB,
    changePasswordIntoDB,
    refreshToken,
    forgetPassword,
    resetPassword,
    verifyResetOtp,
    resendResetCode,
    resendVerifyCode,
    loginWithOAuth,
};

export default authServices;
