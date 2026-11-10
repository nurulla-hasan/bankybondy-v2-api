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
    // Shared clamp helper: feeds $skip/$limit of the chat listing, so negatives or
    // Infinity (e.g. ?page=-3, ?page=1e999) must be rejected before Mongo.
    const page = clampPage(options.page);
    const limit = clampLimit(options.limit); // cap 500, same as QueryBuilder
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
