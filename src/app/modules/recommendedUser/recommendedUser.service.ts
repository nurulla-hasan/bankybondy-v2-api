import QueryBuilder from '../../builder/QueryBuilder';
import { IRecommendedUser } from './recommendedUser.interface';
import { RecommendedUser } from './recommendedUser.model';

const createRecommendedUsers = async (users: IRecommendedUser[]) => {
    const result = await RecommendedUser.insertMany(users);
    return result;
};

const getRecommendedUsers = async (query: Record<string, unknown>) => {
    // PII: NO exponer email/phone de terceros recomendados. Hard-select (sin
    // `.fields()` para que el cliente no pueda re-pedir email con `?fields=email`).
    const AdminQuery = new QueryBuilder(
        RecommendedUser.find()
            .select('name skill recommendBy createdAt')
            .populate('skill'),
        query
    )
        .search(['name'])
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

const RecommendedUserServices = { createRecommendedUsers, getRecommendedUsers };
export default RecommendedUserServices;
