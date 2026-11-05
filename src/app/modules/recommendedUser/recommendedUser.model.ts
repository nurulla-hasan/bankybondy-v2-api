import { Schema, model } from 'mongoose';
import { IRecommendedUser } from './recommendedUser.interface';

const recommendedUserSchema = new Schema<IRecommendedUser>(
    {
        recommendBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        },
        // Id de la CUENTA (User) que recomendó. Antes NO estaba declarado, así que
        // Mongoose lo descartaba en silencio al insertar: el registro lo escribe
        // (user.services) y el cron de limpieza de cuentas no verificadas filtra por
        // él (`deleteMany({ recommendByUserId: { $in: expiredUserIds } })`), pero al
        // no persistirse el cron nunca borraba nada. `recommendBy` guarda el perfil
        // (NormalUser); este guarda la cuenta (User), que es contra la que corre el
        // cron. Se indexa porque el cron consulta por este campo.
        recommendByUserId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
        },
        phone: {
            type: String,
            required: true,
            trim: true,
        },
        skill: {
            type: Schema.Types.ObjectId,
            ref: 'Skill',
            required: true,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

export const RecommendedUser = model<IRecommendedUser>(
    'RecommendedUser',
    recommendedUserSchema
);
