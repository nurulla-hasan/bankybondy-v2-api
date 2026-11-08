/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { ENUM_GENDER } from '../user/user.enum';
import { ENUM_SUBSCRIPTION_TYPE } from './normalUser.enum';

export interface INormalUser {
    user: Types.ObjectId;
    // username: string;
    name: string;
    email: string;
    phone: string;
    profile_image: string;
    cover_image: string;
    gender: (typeof ENUM_GENDER)[keyof typeof ENUM_GENDER];
    dateOfBirth: Date;
    address: string;
    bio: string;
    skills: [Types.ObjectId];
    socialLinks: string[];
    subscriptionType: (typeof ENUM_SUBSCRIPTION_TYPE)[keyof typeof ENUM_SUBSCRIPTION_TYPE];
    bondLimit: number;
    // Rastro de la palanca manual del plan (admin): quién, cuándo y por qué. Es
    // la única vía por la que un plan puede BAJAR (contracargos) o subir sin pago
    // (reparaciones), y las dos mueven plata.
    subscriptionSetBy?: Types.ObjectId;
    subscriptionSetAt?: Date;
    subscriptionSetReason?: string;
    // Historial completo de los cambios manuales (append-only, acotado a 50).
    // Es lo que permite reconstruir una disputa; los tres campos de arriba son
    // el denormalizado del ultimo, para poder listar sin abrir el array.
    subscriptionHistory?: {
        type?: string;
        by?: Types.ObjectId;
        at?: Date;
        reason?: string;
        from?: string;
    }[];
    // Último tope (bondLimit) por el que ya se avisó el empujón de suscripción, para
    // no repetir el aviso. Al subir de plan cambia el bondLimit y se vuelve a avisar.
    subscriptionNudgeAt?: number;
    // Checkout iniciado sin pagar (reutilización de URL / anti-duplicado).
    pendingSubscriptionCheckout?: {
        plan?: 'Standard' | 'Premium';
        provider?: 'paypal' | 'mercadopago';
        url?: string;
        createdAt?: Date;
    };
    // Contador-guardia interno (fix de carrera del bondLimit): se incrementa dentro
    // de la transacción de creación de vínculos para forzar un WriteConflict entre
    // creaciones concurrentes del mismo usuario. No tiene significado de negocio.
    bondSeq?: number;
    bondsPublic?: boolean;
    // Privacidad: si es false, el perfil NO aparece en el listado de Personas
    // ni en su busqueda. NO afecta el matcheo (sigue generando cadenas) ni el
    // acceso por link directo al perfil. Default true (listado, comportamiento actual).
    listedInPeople?: boolean;
    // Interno (vinculosVivos.ts): tiene al menos un vínculo vivo.
    hasActiveBonds?: boolean;
    // Categorías de notificación silenciadas (Tanda C). No suman al globito.
    mutedNotificationCategories?: string[];
    // Baja del resumen/digest semanal (List-Unsubscribe de un clic). true = NO recibe
    // el digest automático. No afecta los correos transaccionales (activación/reset).
    digestOptOut?: boolean;
    reputation?: {
        avg: number;
        count: number;
        score: number;
    };
    // Geolocalizacion del usuario (GeoJSON Point [lng, lat]). Opcional.
    // NUNCA se expone en las respuestas de Personas (solo se usa para el
    // modo "near" y para heredar la ubicacion al crear un bond).
    location?: {
        type: 'Point';
        coordinates: [number, number];
    };
    locationUpdatedAt?: Date;
    locationMode?: 'auto' | 'manual';
}
