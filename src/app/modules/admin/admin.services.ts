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

// register Admin
const createAdmin = async (payload: IAdmin & { password: string }) => {
    const { password } = payload;
    // Antes: `const { password, ...adminData } = payload` → TODO lo que mandara el
    // cliente entraba al `Admin.create` (incluidos `_id`, `user`, `isDeleted`).
    // Verificado con mongoose contra el schema: `new Admin({isDeleted:true,_id:...})`
    // conserva ambos, o sea que el cliente podía elegir su propio _id. Whitelist
    // explícita de los únicos campos que este alta necesita.
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
    // Confirmar que el `:id` ES un Admin ANTES de escribir nada. El orden viejo
    // (escribir el password y recién después buscar el Admin) tenía una rareza: con
    // un id que no es un Admin pero sí es el `profileId` de algún User —por ejemplo
    // el del SuperAdmin— se le cambiaba la contraseña y la respuesta igual era 200
    // "Admin profile updated successfully" con `data: null`. Era un no-op silencioso
    // y ahora, con el `passwordChangedAt` de abajo, pasaría a ser un DESLOGUEO
    // silencioso. No es alcanzable desde el panel, pero un write que miente sobre a
    // quién tocó no se deja pasar.
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
                // Sin esto, cambiarle la contraseña a un admin NO cerraba sus
                // sesiones: `middlewares/auth.ts` invalida los tokens comparando
                // `passwordChangedAt` contra el `iat` del token, y acá nunca se
                // seteaba. O sea que el token viejo seguía válido hasta expirar
                // (hasta 30 días) — justo en el escenario donde uno le cambia la
                // contraseña a un admin: porque sospecha que la cuenta está
                // comprometida. El cambio normal (auth.services) y el reset SÍ lo
                // setean; había quedado sin cerrar sólo el camino administrativo.
                passwordChangedAt: new Date(),
            }
        );
    }
    // El email es IDENTIDAD: el login usa `User.email`, no `Admin.email`. Escribir
    // sólo el segundo (lo que hacía este endpoint) DESINCRONIZA el login. Por eso
    // queda fuera de la whitelist de abajo. Pero dejarlo caer en silencio es peor
    // para el operador: el `EditAdminModal` lo manda SIEMPRE (campo requerido) y el
    // dashboard cierra el modal mostrando "actualizado" aunque no se haya guardado.
    // Solución: sólo se rechaza si de verdad INTENTA cambiarlo. Mandarlo igual —el
    // 99% de los submits— pasa sin ruido. (ChatGPT tiraba 400 ante CUALQUIER email
    // presente, lo que habría roto el 100% de las ediciones.)
    if (payload.email) {
        const actual = await Admin.findById(id).select('email').lean();
        if (actual && payload.email !== actual.email) {
            throw new AppError(
                httpStatus.BAD_REQUEST,
                'Email cannot be changed from here'
            );
        }
    }

    // Defensa en profundidad: `validateRequest` valida contra Zod pero NO reemplaza
    // `req.body` por el objeto parseado, así que campos extra siguen llegando acá.
    // Solo se aceptan los editables (nada de `user`, `isDeleted`, `_id`, `email`).
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

        // Delete associated User and Admin within the transaction
        await User.findByIdAndDelete(admin.user).session(session);
        await Admin.findByIdAndDelete(id).session(session);

        await session.commitTransaction();
        return null;
    } catch (error) {
        await session.abortTransaction();
        throw error; // re-throw the error for further handling
    } finally {
        session.endSession();
    }
};

// get all Admin

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
