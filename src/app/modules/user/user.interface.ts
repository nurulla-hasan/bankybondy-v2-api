/* eslint-disable no-unused-vars */
import { Model } from 'mongoose';
import { USER_ROLE } from './user.constant';

export interface TUser {
    _id: string;
    profileId: string;
    email: string;
    phone: string;
    password: string;
    passwordChangedAt?: Date;
    role: 'user' | 'superAdmin' | 'admin';
    isBlocked: boolean;
    verifyCode: number;
    resetCode: number;
    isVerified: boolean;
    isResetVerified: boolean;
    codeExpireIn: Date;
    // C2 hardening: intentos fallidos de OTP y lockout temporal por cuenta.
    verifyAttempts?: number;
    verifyBlockedUntil?: Date | null;
    resetAttempts?: number;
    resetBlockedUntil?: Date | null;
    isActive: boolean;
    isDeleted: boolean;
    appleId: string;
    googleId: string;
}

export interface TLoginUser {
    email: string;
    password: string;
}

export interface UserModel extends Model<TUser> {
    // myStaticMethod(): number;
    isUserExists(email: string): Promise<TUser>;
    //   isUserDeleted(email: string): Promise<boolean>;
    //   isUserBlocked(email: string): Promise<boolean>;
    isPasswordMatched(
        plainPassword: string,
        hashPassword: string
    ): Promise<TUser>;
    isJWTIssuedBeforePasswordChange(
        passwordChangeTimeStamp: Date,
        jwtIssuedTimeStamp: number
    ): Promise<boolean>;
}

export type TUserRole = keyof typeof USER_ROLE;
