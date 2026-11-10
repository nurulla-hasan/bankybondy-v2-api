/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import { clampLimit, clampPage } from '../../utilities/pagination';
import { escapeRegex } from '../../utilities/escapeRegex';
import AppError from '../../error/appError';
import { deleteFileFromS3 } from '../../helper/deleteFromS3';
import { ENUM_AUDIO_MODERATION_STATUS } from '../audio/audio.interface';
import { ITopic } from './topic.interface';
import { Topic } from './topic.model';

const createTopic = async (payload: ITopic) => {
    const result = await Topic.create(payload);
    return result;
};

// const getAllTopics = async (query: Record<string, unknown>) => {
//     const topicQuery = new QueryBuilder(Topic.find({ isDeleted: false }), query)
//         .search(['name'])
//         .fields()
//         .filter()
//         .paginate()
//         .sort();

//     const result = await topicQuery.modelQuery;
//     const meta = await topicQuery.countTotal();
//     return {
//         meta,
//         result,
//     };
// };

const getAllTopics = async (query: Record<string, unknown>) => {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const skip = (page - 1) * limit;
    const searchTerm = query.searchTerm || '';

    const filters: any = {};
    Object.keys(query).forEach((key) => {
        if (!['searchTerm', 'page', 'limit'].includes(key)) {
            filters[key] = query[key];
        }
    });

    const matchStage: any = { isDeleted: false };

    if (searchTerm) {
        matchStage.$or = [
            { name: { $regex: escapeRegex(searchTerm), $options: 'i' } },
            { description: { $regex: escapeRegex(searchTerm), $options: 'i' } },
        ];
    }

    const topics = await Topic.aggregate([
        { $match: matchStage },
        {
            // `totalAudios` must match what the feed can show: only approved
            // audios (feed filters `moderationStatus: 'ready'`, `isBlocked: false`).
            // Counting every row advertised topics still processing or failed.
            $lookup: {
                from: 'audios',
                let: { topicId: '$_id' },
                pipeline: [
                    {
                        $match: {
                            $expr: { $eq: ['$audioTopic', '$$topicId'] },
                            moderationStatus:
                                ENUM_AUDIO_MODERATION_STATUS.READY,
                            isBlocked: false,
                        },
                    },
                    { $count: 'count' },
                ],
                as: 'audios',
            },
        },
        {
            $addFields: {
                totalAudios: { $ifNull: [{ $first: '$audios.count' }, 0] },
            },
        },
        { $project: { audios: 0 } },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
    ]);

    const totalCount = await Topic.countDocuments(matchStage);

    return {
        meta: {
            page,
            limit,
            totalCount,
            totalPages: Math.ceil(totalCount / limit),
        },
        result: topics,
    };
};

const getTopicById = async (topicId: string) => {
    const topic = await Topic.findById(topicId);
    if (!topic) {
        throw new AppError(httpStatus.NOT_FOUND, 'Topic not found');
    }
    return topic;
};

const updateTopic = async (topicId: string, payload: ITopic) => {
    const topic = await Topic.findById(topicId);
    if (!topic) {
        throw new AppError(httpStatus.NOT_FOUND, 'Topic not found');
    }

    const updatedTopic = await Topic.findByIdAndUpdate(
        topicId,
        { ...payload },
        { new: true }
    );

    if (payload.topic_image && topic.topic_image) {
        deleteFileFromS3(topic.topic_image);
    }

    return updatedTopic;
};

const deleteTopic = async (topicId: string) => {
    const topic = await Topic.findById(topicId);
    if (!topic) {
        throw new AppError(httpStatus.NOT_FOUND, 'Topic not found');
    }
    const result = await Topic.findByIdAndUpdate(
        topicId,
        { isDeleted: true },
        { new: true, runValidators: true }
    );
    if (topic.topic_image) {
        deleteFileFromS3(topic.topic_image);
    }
    return result;
};

const TopicServices = {
    createTopic,
    getAllTopics,
    getTopicById,
    updateTopic,
    deleteTopic,
};

export default TopicServices;
