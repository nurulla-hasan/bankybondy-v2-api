import { Types } from 'mongoose';

export interface IBondRating {
    rated: Types.ObjectId;
    ratedBy: Types.ObjectId;
    rating: number;
    bondLink: Types.ObjectId;
    want: string;
    offer: string;
    // D.3 (Tanda 2): comentario breve opcional que acompana a la puntuacion.
    comment?: string;
    // Tanda 2 (rating en SUSPENSO): la calificación NO impacta la reputación hasta
    // que TODO el trueque cierra (todos marcan completado). Se crea en `false` y pasa
    // a `true` en LOTE al transicionar el BondLink a Completed. Un trueque inconcluso
    // deja sus ratings en `false` para siempre (no genera reputación).
    applied?: boolean;
}
