import httpStatus from 'http-status';
import { ISuperAdmin } from './superAdmin.interface';
import AppError from '../../error/appError';
import SuperAdmin from './superAdmin.model';

const updateSuperAdminProfile = async (
    id: string,
    payload: Partial<ISuperAdmin>
) => {
    if (payload.email) {
        throw new AppError(
            httpStatus.BAD_REQUEST,
            'You can not change the email'
        );
    }
    const user = await SuperAdmin.findById(id);
    if (!user) {
        throw new AppError(httpStatus.NOT_FOUND, 'Profile not found');
    }
    // Defensa en profundidad, igual que en admin.services: solo campos editables,
    // para que un payload con `user`/`isDeleted`/`_id` no escriba lo que quiera.
    const safePayload: Partial<ISuperAdmin> = {};
    for (const key of ['name', 'profile_image', 'contact', 'address'] as const) {
        if (payload[key] !== undefined) safePayload[key] = payload[key];
    }

    const result = await SuperAdmin.findByIdAndUpdate(id, safePayload, {
        new: true,
        runValidators: true,
    });
    return result;
};

const SuperAdminServices = {
    updateSuperAdminProfile,
};

export default SuperAdminServices;
