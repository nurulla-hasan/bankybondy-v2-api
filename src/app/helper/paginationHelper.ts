import { SortOrder } from 'mongoose';
import { clampLimit, clampPage } from '../utilities/pagination';

type IOptions = {
    page?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: SortOrder;
};

type IOptionResult = {
    page: number;
    limit: number;
    skip: number;
    sortBy: string;
    sortOrder: SortOrder;
};

const calculatePagination = (options: IOptions): IOptionResult => {
    // Clamp con el helper común (ya testeado). Antes era `Number(options.page || 1)`
    // pelado: sin piso, sin techo y sin chequeo de finitud. Este helper alimenta
    // directamente el `$skip`/`$limit` del LISTADO DE CHATS (conversation.service
    // `getConversation`, montado), así que `?page=-3` daba skip negativo,
    // `?page=1e999` daba Infinity y `?limit=-5` pasaba el `Math.min` del caller
    // porque ese Math.min pone techo pero NO piso. Los tres son 500 de Mongo, y
    // rompen la lista entera de conversaciones del usuario.
    // Es la contracara de `QueryBuilder.paginate()`, que ya usaba el helper: eran
    // dos paginadores genéricos y sólo uno estaba cerrado.
    const page = clampPage(options.page);
    const limit = clampLimit(options.limit); // tope 500, igual que QueryBuilder
    const skip = (page - 1) * limit;

    const sortBy = options.sortBy || 'createdAt';
    const sortOrder = options.sortOrder || 'desc';

    return {
        page,
        limit,
        skip,
        sortBy,
        sortOrder,
    };
};

export default calculatePagination;
