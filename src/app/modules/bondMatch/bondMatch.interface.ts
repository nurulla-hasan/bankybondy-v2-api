import { Types } from 'mongoose';

export type BondMatchType = 'entry' | 'surprise' | 'empty';

export interface IMatchScoreParts {
    sem: number; // calidad semántica (eslabón más débil)
    rep: number; // reputación (eslabón más débil de la contraparte/ciclo)
    prox: number; // proximidad (1 si es online / sin geo)
    fresh: number; // frescura (última actividad)
}

/** Un trato posible precomputado para un bond de partida (`sourceBond`).
 *  Denormalizado: el mismo trato puede guardarse una vez por cada bond
 *  participante, para servir "mis matches" con una sola lectura. */
export interface IBondMatch {
    sourceBond: Types.ObjectId; // bond para el que se computó este match
    bonds: Types.ObjectId[]; // todos los bonds del trato (incluye sourceBond), en orden
    users: Types.ObjectId[]; // dueños de esos bonds
    score: number; // finalScore compuesto (0–1)
    parts: IMatchScoreParts; // desglose del puntaje
    type: BondMatchType;
    size: number; // 2 = par; >=3 = ciclo
    computedAt: Date;
}
