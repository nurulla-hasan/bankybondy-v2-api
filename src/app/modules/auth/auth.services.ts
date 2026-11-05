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
// OTP con CSPRNG (crypto.randomInt), no Math.random (predecible). Usado por el
// flujo de reset de contraseña. randomInt(min, max) es [min, max) → 100000..999999.
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
    // checking if the password is correct ----
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

// change password
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
    //hash new password
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

    // MISMA guarda que auth.ts, y acá es AÚN MÁS importante: ésta es la ruta que
    // ACUÑA tokens. `User.findById(undefined)` da filtro `{}` y devuelve el PRIMER
    // usuario de la colección (el superAdmin sembrado por DB/index, que además
    // nace con isVerified:true y pasa los cuatro chequeos de abajo). Sin esta
    // guarda, más abajo se firmaría un access token con el `id`, el `profileId` y
    // el ROL de ese superAdmin: una credencial GENUINA, que después atraviesa el
    // middleware endurecido sin despeinarse porque todos sus valores son reales.
    // O sea: blindar sólo auth.ts movía el agujero en vez de cerrarlo.
    // (`jwt.sign` DESCARTA las claims undefined —verificado—, así que un token
    // firmado sin `id` no tiene la clave y llega acá como undefined.)
    // La ruta es pública y sin rate limit (auth.routes: /refresh-token).
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
    // Defensa en profundidad: una cuenta NO verificada no debe poder renovar su
    // access token. Mismo criterio (y mensaje) que el login. Sin esto, un token
    // de refresh emitido antes de invalidar/verificar seguía rindiendo accesos.
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

// forgot password
const forgetPassword = async (email: string) => {
    const user = await User.findOne({ email: email });

    // ANTI-ENUMERACIÓN: la respuesta es SIEMPRE la misma, exista la cuenta o no
    // (y esté borrada o bloqueada o no). Antes se lanzaba "This user does not
    // exist" / "is blocked" / "is deleted", y con eso cualquiera —sin loguearse—
    // podía averiguar qué emails tienen cuenta en la plataforma, o si una cuenta
    // fue moderada. El mismo criterio que usan bancos y Google: "si esa cuenta
    // existe, te enviamos un código". El controller responde ese texto genérico.
    //
    // El código sólo se genera y el mail sólo se manda cuando la cuenta es válida
    // (existe, no borrada, no bloqueada); en cualquier otro caso se devuelve como
    // si todo hubiera salido bien, sin efecto.
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

        // Console Reset OTP for easy development / debugging
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

// verify forgot otp

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

    // Lockout POR CUENTA (además del rate limit por IP): tras varios códigos
    // errados, se bloquea la verificación de reset por un rato. Cierra el brute-force
    // distribuido del OTP de 6 dígitos (varias IPs) que el límite por IP no frena.
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
        // Código errado. El conteo es ATÓMICO ($inc): con el read-modify-write
        // anterior, varios intentos concurrentes leían el mismo valor y pisaban el
        // incremento (lost update), así el contador subía menos que los intentos
        // reales y el lockout quedaba burlable paralelizando. Leemos el valor ya
        // incrementado y, al tocar el tope, bloqueamos la cuenta un rato.
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
            // Ventana FRESCA para completar el cambio de contraseña (paso siguiente):
            // resetPassword exige codeExpireIn > ahora, así el permiso de reset no
            // queda abierto para siempre tras verificar el OTP.
            codeExpireIn: new Date(Date.now() + 10 * 60000),
            // Éxito: se reinicia el contador y se libera el lockout.
            resetAttempts: 0,
            resetBlockedUntil: null,
        },
        { new: true, runValidators: true }
    );
    return null;
};

// reset password
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

    //hash new password
    const newHashedPassword = await bcrypt.hash(
        payload.password,
        Number(config.bcrypt_salt_rounds)
    );
    // update the new password.
    // IMPORTANTE: consumir el flag de verificación y limpiar el código, para
    // que no se pueda volver a resetear sin un OTP nuevo (toma de cuenta).
    // Atómico + con expiración: consumir el flag verificado SOLO si sigue vigente
    // (codeExpireIn > ahora) en el MISMO write. Antes era check-then-update sin
    // rechequeo de expiración → quien verificaba un OTP tenía tiempo ilimitado para
    // completar el reset (toma de cuenta), y dos requests concurrentes podían
    // colarse (TOCTOU). Ahora una sola operación guardada.
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

    // ANTI-ENUMERACIÓN: misma política que forgetPassword (ver la nota allá). La
    // respuesta es siempre igual; el código se genera y el mail se manda sólo si
    // la cuenta es válida.
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

        // Console Resend Reset OTP for easy development / debugging
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
    // SEGURIDAD (P0): esta ruta es PÚBLICA y solo pide el email. Si desverificaba
    // una cuenta ya activa (isVerified:false), el cron de limpieza de no
    // verificados la borraba a los pocos minutos → cualquiera que supiera un email
    // podía eliminar esa cuenta con una sola request. Se corta de raíz: una cuenta
    // YA verificada no tiene nada que reenviar. Y no se vuelve a tocar isVerified
    // (para un no verificado ya es false; para un verificado, jamás se baja).
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

    // Console Resend Registration OTP for easy development / debugging
    console.log(`\n========================================`);
    console.log(`🔑 Resend Verify Registration OTP for [${user.email}]: ${verifyCode}`);
    console.log(`========================================\n`);

    // Es un código de VERIFICACIÓN de cuenta (no de reseteo): mismo asunto y
    // cuerpo que el mail de alta, para no confundir al usuario.
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
    // Seguridad: por ahora SOLO Google. Facebook/Apple no validan la audiencia
    // del token ni el email verificado de forma equivalente (riesgo de
    // account-takeover al vincular por email), así que se rechazan hasta
    // implementarlos bien.
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
            // Seguridad (anti pre-account-takeover): solo confiamos en el email de
            // Google si esta verificado, antes de vincularlo a una cuenta existente.
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

        // Si no hay usuario con este provider id pero YA existe una cuenta con ese
        // email (registrada por email/contrasena u otro proveedor), vincular el
        // proveedor a esa cuenta y loguear, en vez de crear un duplicado (que
        // fallaria por el email unico). Usamos findByIdAndUpdate para NO re-hashear
        // la contrasena existente.
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
                // Password aleatorio: los usuarios sociales entran por el proveedor,
                // nunca usan esta contrasena (satisface el `required` del schema User).
                // PERO `loginUserIntoDB` no excluye cuentas sociales y el alta social
                // marca isVerified:true, asi que esta password ES UN CREDENCIAL VIVO
                // por /login. La anterior (`Math.random()` + `Date.now()`) usaba un
                // PRNG NO criptografico y un sufijo derivable del minuto de alta:
                // adivinable. Ahora 32 bytes de entropia criptografica.
                password: randomBytes(32).toString('base64url'),
                // Seguridad: nunca aceptar el rol del cliente en registro social
                role: USER_ROLE.user,
                // El proveedor social ya verifico el email (para Google lo exigimos
                // arriba con payload.email_verified). Sin esto el usuario queda
                // isVerified:false por default y el middleware auth lo rechaza en
                // TODA ruta protegida -> "sesion sin usuario, funciones inactivas".
                isVerified: true,
            });
            await user.save();

            const result = await NormalUser.create({
                user: user._id,
                // NormalUser.name es obligatorio; usar el nombre de Google o un fallback.
                name: name || (email ? email.split('@')[0] : 'User'),
                email: email,
                profile_image: picture,
            });
            // { new: true } es IMPRESCINDIBLE: sin el, findByIdAndUpdate devuelve el
            // documento VIEJO (sin profileId) y el token se firmaba con
            // profileId=undefined -> sesion "sin usuario" (funciones inactivas).
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

        // Seguridad: no emitir tokens a cuentas bloqueadas/eliminadas. Aplica
        // tambien a usuarios que YA tenian el provider vinculado y reentran (el
        // findOne({providerId}) saltea el chequeo del alta por email).
        if (user.isBlocked || user.isDeleted) {
            throw new AppError(
                httpStatus.FORBIDDEN,
                'Your account is blocked or deleted'
            );
        }

        // Auto-sanado: un login social con email verificado es prueba de identidad.
        // Si la cuenta quedo isVerified:false (p.ej. creada por un OAuth previo sin
        // el flag, o alta por email sin confirmar), la marcamos verificada aqui para
        // que el middleware auth no la bloquee en las rutas protegidas.
        if (user && !user.isVerified) {
            const healed = await User.findByIdAndUpdate(
                user._id,
                { isVerified: true },
                { new: true }
            );
            if (healed) user = healed;
        }

        // Auto-sanado del profileId. ESTE es el que cierra la FÁBRICA de cuentas
        // rotas: el alta social de más arriba hace `user.save()` y RECIÉN DESPUÉS
        // `NormalUser.create()`, fuera de transacción (a diferencia de los otros
        // tres caminos de alta, que sí usan sesión). Si esa creación falla, el User
        // queda persistido con profileId null, y en el reintento el
        // `findOne({[provider]Id})` lo encuentra → el `if (!user)` da false → el
        // bloque que crea el perfil NO se vuelve a ejecutar nunca. Antes eso dejaba
        // una sesión degradada; con la guarda nueva del middleware sería un 401
        // permanente y sin salida. Acá se repara: el perfil se busca por la FK y,
        // si no está, por email (que es unique en las dos colecciones).
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
        // Preservar los errores intencionales (token inválido -> 400, cuenta
        // bloqueada -> 403, usuario inexistente -> 404, etc.). Antes se envolvía
        // TODO en 500 y el cliente no distinguía un fallo real del proveedor de
        // un rechazo esperado. Solo los fallos inesperados caen a 500.
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
