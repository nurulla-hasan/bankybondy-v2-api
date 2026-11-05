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
        // C2 hardening: contador de intentos fallidos de OTP + lockout temporal.
        verifyAttempts: {
            type: Number,
            default: 0,
        },
        verifyBlockedUntil: {
            type: Date,
            default: null,
        },
        // Idem para el OTP de RESET de contraseña (lockout por cuenta, no solo por IP).
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
    // Solo re-hashear si la contrasena cambio; si no, cualquier .save() futuro
    // (p.ej. actualizar otro campo) volveria a hashear el hash y romperia el login.
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
// statics method for check is user exists (por EMAIL: el único caller —
// admin.services — le pasa un email, pero antes consultaba por `phoneNumber`,
// así que el findOne nunca matcheaba. Bug latente: se consulta por email).
userSchema.statics.isUserExists = async function (email: string) {
    return await User.findOne({ email }).select('+password');
};
// statics method for check password match  ----
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

// ESCALA. El cron de limpieza de altas incompletas (user.services.ts, cada 2
// minutos) consulta `{ isVerified:false, codeExpireIn:{$lte}, createdAt:{$gte} }`,
// y esta colección NO tenía más índice que el único de `email`. Sin este, esa
// consulta es un ESCANEO DE COLECCIÓN COMPLETA cada 2 minutos, para siempre: con
// 46 usuarios no se nota y con 100.000 es el cron más caro del sistema.
// Compuesto con la igualdad primero y el rango después, que es el orden que
// Mongo puede aprovechar. `createdAt` NO se agrega: es un SEGUNDO rango y el
// índice no lo usaría para acotar; con `isVerified` + `codeExpireIn` la porción
// escaneada ya es diminuta (solo cuentas sin verificar y vencidas).
userSchema.index({ isVerified: 1, codeExpireIn: 1 });
// Los baneados por admin (`isBlocked: true`) se excluyen en cada carga: Personas
// con `distinct('_id', …)` y el buscador con `distinct('profileId', …)`.
userSchema.index({ isBlocked: 1 });

export const User = model<TUser, UserModel>('User', userSchema);
