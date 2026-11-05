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
// C2 hardening: OTP con CSPRNG (crypto.randomInt), no Math.random (predecible).
// randomInt(min, max) es [min, max) → 100000..999999 (6 dígitos).
const generateVerifyCode = (): number => {
    return randomInt(100000, 1000000);
};

// C2 hardening: tras MAX_VERIFY_ATTEMPTS fallos, se bloquea la verificación de esa
// cuenta por VERIFY_LOCK_MINUTES. Defensa en profundidad sobre el authLimiter por IP.
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

        // SEGURIDAD (mass-assignment): NO esparcir el body crudo en NormalUser.
        // El schema de registro no es `.strict()` y `validateRequest` no recorta,
        // así que sin esto un registrante podía setear subscriptionType/bondLimit/
        // reputation/bondsPublic/listedInPeople. Solo se aceptan campos de perfil
        // del alta; el resto queda en su default del schema. (Mismo criterio que
        // PROFILE_EDITABLE_FIELDS en updateUserProfile.)
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
            // `skills` faltaba: el formulario de registro las hace elegir y el
            // backend las descartaba en silencio, así que el perfil quedaba sin
            // ellas y la persona tenía que volver a cargarlas desde su perfil sin
            // saber por qué. No es un campo sensible (no es subscriptionType ni
            // bondLimit ni reputation): ya figura en PROFILE_EDITABLE_FIELDS, o
            // sea que el usuario puede editarlo cuando quiera. Sólo faltaba en el
            // alta.
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

        // FEATURE DORMIDA (recommendedUsers / "relatives"): el alta pública NO
        // siembra recomendados. Antes esto leía `payload.recommendedUsers` del
        // body CRUDO (el schema de registro no es `.strict()` y validateRequest
        // no recorta), así que un ANÓNIMO podía persistir filas en RecommendedUser
        // por mass-assignment (P0). Se apaga la vía de escritura anónima detrás de
        // un flag OFF por defecto, SIN borrar el bloque: cuando se despierte el
        // feature, se lo alimenta por un endpoint autenticado propio, no por el
        // signup. Flipear ALLOW_SIGNUP_RECOMMENDED_SEED=true para reactivar.
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
    // C2 hardening: lockout temporal por cuenta tras demasiados fallos.
    if (
        user.verifyBlockedUntil &&
        new Date(user.verifyBlockedUntil) > new Date(Date.now())
    ) {
        // 429 literal (equivalente a TOO_MANY_REQUESTS) para no depender de la
        // variante de nombre de la versión de http-status instalada en el server.
        throw new AppError(
            429,
            'Too many attempts. Please wait a few minutes and try again.'
        );
    }
    if (user.codeExpireIn < new Date(Date.now())) {
        throw new AppError(httpStatus.BAD_REQUEST, 'Verify code is expired');
    }
    if (verifyCode !== user.verifyCode) {
        // C2 hardening: cada fallo suma; al llegar al tope se bloquea la cuenta un
        // rato (y se reinicia el contador). Sin esto, un OTP de 6 dígitos era
        // brute-forceable dentro de su ventana. El conteo es ATÓMICO ($inc): el
        // read-modify-write anterior perdía incrementos con intentos concurrentes
        // (lost update), dejando el lockout burlable al paralelizar. Leemos el
        // valor ya incrementado y decidimos el bloqueo con él.
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
    // Éxito: verificar, resetear intentos/lockout e INVALIDAR el código (se pone
    // codeExpireIn en el pasado) para que no pueda reutilizarse.
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

    // Create JWT tokens
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
    // C2 hardening: un código NUEVO reinicia el presupuesto de intentos (0). NO se
    // limpia un lockout activo (verifyBlockedUntil): si la cuenta está bloqueada,
    // el reenvío rota el código pero el bloqueo sigue vigente hasta vencer, para
    // que no sirva como bypass del lockout.
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

    // Borrado en cascada: limpiar todo lo que referencia al usuario, atómico
    // donde haya soporte de transacciones (Atlas replica set).
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await cascadeDeleteUserData(user.profileId, session);
            await NormalUser.findByIdAndDelete(user.profileId).session(session);
            await User.findByIdAndDelete(user.id).session(session);
        });
    } catch (err: any) {
        // Fallback secuencial SOLO cuando el entorno no soporta transacciones
        // (Mongo standalone sin replica set). Ante cualquier otro error se
        // propaga para no arriesgar datos huérfanos por reintentos ciegos.
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

        // Entorno sin transacciones (Mongo standalone): best-effort secuencial.
        await cascadeDeleteUserData(user.profileId);
        await NormalUser.findByIdAndDelete(user.profileId);
        await User.findByIdAndDelete(user.id);
    } finally {
        session.endSession();
    }

    return null;
};

const getMyProfile = async (userData: JwtPayload) => {
    let result: any = null;
    if (userData.role === USER_ROLE.user) {
        result = await NormalUser.findOne({ email: userData.email });
    } else if (userData.role === USER_ROLE.superAdmin) {
        result = await SuperAdmin.findOne({ email: userData.email });
    }
    return result;
};

// all cron jobs for users---

cron.schedule('*/2 * * * *', async () => {
    try {
        const now = new Date();

        // Find unverified users whose expiration time has passed.
        // SEGURIDAD (defensa en profundidad, P0): SOLO se barren cuentas RECIÉN
        // creadas (altas incompletas de las últimas 24h). Un signup sin verificar
        // se borra a los ~minutos (código vence en 5', el cron corre c/2'), así
        // que la ventana de 24h sobra para la limpieza legítima; pero garantiza
        // que una cuenta ESTABLECIDA nunca pueda ser elegible para borrado
        // automático aunque algún otro path la deje isVerified:false por error.
        const deletableSince = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const expiredUsers = await User.find({
            isVerified: false,
            codeExpireIn: { $lte: now },
            createdAt: { $gte: deletableSince },
        });

        if (expiredUsers.length > 0) {
            const expiredUserIds = expiredUsers.map((user) => user._id);

            // Delete corresponding NormalUser documents
            const normalUserDeleteResult = await NormalUser.deleteMany({
                user: { $in: expiredUserIds },
            });

            // Delete the expired User documents
            const userDeleteResult = await User.deleteMany({
                _id: { $in: expiredUserIds },
            });

            // delete recommended users
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

    // Ocultar/mostrar los audios del usuario según el nuevo estado. IMPORTANTE:
    // Audio.user guarda el profileId (NormalUser._id), NO el User._id — antes se
    // filtraba por `id` (User._id) y no matcheaba ninguna fila, así que el bloqueo
    // no ocultaba nada. Además lo hacemos simétrico: al desbloquear, se reactivan.
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
