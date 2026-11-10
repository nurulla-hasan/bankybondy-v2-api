import { Schema, model } from 'mongoose';
import { TUser, UserModel } from './user.interface';
import config from '../../config';
import bcrypt from 'bcrypt';

const userSchema = new Schema<TUser>(
    {
        profileId: {
            type: String,
            default: null,
        },
        email: {
            type: String,
            required: true,
            unique: true,
        },
        password: {
            type: String,
            required: true,
            select: false,
        },
        passwordChangedAt: {
            type: Date,
        },
        role: {
            type: String,
            enum: ['user', 'superAdmin', 'admin'],
            required: true,
        },
        isBlocked: {
            type: Boolean,
            default: false,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        verifyCode: {
            type: Number,
        },
        resetCode: {
            type: Number,
        },
        isVerified: {
            type: Boolean,
            default: false,
        },
        isResetVerified: {
            type: Boolean,
            default: false,
        },
        codeExpireIn: {
            type: Date,
        },
        // C2 hardening: failed OTP attempt counter + temporary lockout.
        verifyAttempts: {
            type: Number,
            default: 0,
        },
        verifyBlockedUntil: {
            type: Date,
            default: null,
        },
        // Same for the password RESET OTP (lockout per account, not just per IP).
        resetAttempts: {
            type: Number,
            default: 0,
        },
        resetBlockedUntil: {
            type: Date,
            default: null,
        },
        isDeleted: {
            type: Boolean,
            default: false,
        },
        appleId: {
            type: String,
        },
        googleId: {
            type: String,
        },
    },
    {
        timestamps: true,
    }
);

userSchema.pre('save', async function (next) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const user = this;
    // Re-hash only when the password changed; otherwise any later .save() (e.g. another
    // field) would hash the hash and break login.
    if (!user.isModified('password')) return next();
    user.password = await bcrypt.hash(
        user.password,
        Number(config.bcrypt_salt_rounds)
    );
    next();
});

userSchema.post('save', function (doc, next) {
    doc.password = '';
    next();
});
// Checks existence by EMAIL: the only caller (admin.services) passes an email; it used
// to query `phoneNumber` and never matched.
userSchema.statics.isUserExists = async function (email: string) {
    return await User.findOne({ email }).select('+password');
};
userSchema.statics.isPasswordMatched = async function (
    plainPasswords: string,
    hashPassword: string
) {
    return await bcrypt.compare(plainPasswords, hashPassword);
};

userSchema.statics.isJWTIssuedBeforePasswordChange = async function (
    passwordChangeTimeStamp,
    jwtIssuedTimeStamp
) {
    const passwordChangeTime =
        new Date(passwordChangeTimeStamp).getTime() / 1000;

    return passwordChangeTime > jwtIssuedTimeStamp;
};

// SCALE. The incomplete-signup cleanup cron (user.services.ts, every 2 min) queries
// `{ isVerified:false, codeExpireIn:$lte, createdAt:$gte }` and this collection had no
// index but the unique one on `email`: without this it's a full collection scan forever.
// Equality first, range last. `createdAt` is not added: it's a second range and the
// `isVerified` + `codeExpireIn` slice is already tiny.
userSchema.index({ isVerified: 1, codeExpireIn: 1 });
// Admin-banned users (`isBlocked: true`) are excluded on every load: People uses
// `distinct('_id', ...)` and search uses `distinct('profileId', ...)`.
userSchema.index({ isBlocked: 1 });

export const User = model<TUser, UserModel>('User', userSchema);
