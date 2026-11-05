import { Types } from 'mongoose';
import { BondModality, ENUM_BOND_REQUEST_STATUS } from './bondRequest.enum';

export interface IBondRequest {
    user: Types.ObjectId;
    offer: string;
    want: string;
    location?: {
        type: 'Point';
        coordinates: [number, number];
    };
    description?: string;
    radius?: number;
    // 'physical' (con radio) u 'online' (global). Ausente = físico (legado).
    modality?: BondModality;
    status: (typeof ENUM_BOND_REQUEST_STATUS)[keyof typeof ENUM_BOND_REQUEST_STATUS];
    isLinked: boolean;
    createdAt?: Date;
    updatedAt?: Date;
    isPause: boolean;
    // Soft-delete: ver la nota en bondRequest.model.ts. Sobrevive para el
    // historial del vínculo completado y la reseña, pero no se lista ni ocupa cupo.
    isDeleted?: boolean;
    offerVector: number[];
    wantVector: number[];
    // Fijado por el robot al terminar de computar/cachear los matches del bond.
    // Se usa para distinguir "computando" de "computado sin matches" en el serving.
    matchesComputedAt?: Date;
    // AGENDA del próximo recómputo (TTL adaptativo; ver matching.schedule.ts).
    // Instante FUTURO. Ausente = elegible ya.
    matchesNextAt?: Date;
    // Generación de la caché de matches: la invalidación la incrementa y el
    // cómputo sólo sella su resultado si no cambió mientras corría.
    matchesGen?: number;
    // Última vez que el dueño abrió las coincidencias de este vínculo. Señal de
    // interés real que decide la temperatura (y por lo tanto el TTL).
    lastServedAt?: Date;
}
