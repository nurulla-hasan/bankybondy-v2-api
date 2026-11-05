/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import { escapeRegex } from '../../utilities/escapeRegex';
import AppError from '../../error/appError';
import Project from '../project/project.model';
import ProjectMember from './projectMember.model';

// const getAllProjectMember = async (
//     projectId: string,
//     query: Record<string, unknown>
// ) => {
//     const mumberQuery = new QueryBuilder(
//         ProjectMember.find({ project: projectId }).populate({
//             path: 'user',
//             select: 'name profile_image',
//         }),
//         query
//     )
//         .search(['user.name', 'description'])
//         .filter()
//         .sort()
//         .paginate()
//         .fields();

//     const result = await mumberQuery.modelQuery;
//     const meta = await mumberQuery.countTotal();

//     return {
//         meta,
//         result,
//     };
// };

import mongoose, { Types } from 'mongoose';
import Conversation from '../conversation/conversation.model';
import NormalUser from '../normalUser/normalUser.model';

const getAllProjectMember = async (
    projectId: string,
    query: Record<string, any>
) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 10;
    const skip = (page - 1) * limit;
    const searchTerm = query.searchTerm || '';

    const matchStage: any = {
        project: new Types.ObjectId(projectId),
    };
    if (query.type) {
        matchStage.type = query.type;
    }

    const searchMatchStage = searchTerm
        ? {
              'user.name': { $regex: escapeRegex(searchTerm), $options: 'i' },
          }
        : {};

    const pipeline: any[] = [
        { $match: matchStage },
        {
            $lookup: {
                from: 'normalusers',
                localField: 'user',
                foreignField: '_id',
                as: 'user',
            },
        },
        { $unwind: '$user' },
        { $match: searchMatchStage },
        {
            $facet: {
                meta: [{ $count: 'total' }],
                result: [
                    {
                        $project: {
                            _id: 1,
                            project: 1,
                            type: 1,
                            role: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            user: {
                                _id: '$user._id',
                                name: '$user.name',
                                profile_image: '$user.profile_image',
                            },
                        },
                    },
                    { $sort: { createdAt: -1 } },
                    { $skip: skip },
                    { $limit: limit },
                ],
            },
        },
    ];

    const aggResult = await ProjectMember.aggregate(pipeline);
    const result = aggResult[0]?.result || [];
    const total = aggResult[0]?.meta[0]?.total || 0;
    const totalPages = Math.ceil(total / limit);

    return {
        meta: {
            page,
            limit,
            total,
            totalPages,
        },
        result,
    };
};

const addMember = async (
    profileId: string,
    projectId: string,
    payload: any
) => {
    const project = await Project.findOne({
        owner: new mongoose.Types.ObjectId(profileId),
        _id: new mongoose.Types.ObjectId(projectId),
    });
    if (!project) {
        throw new AppError(httpStatus.NOT_FOUND, 'This is not your project');
    }
    const userExist = await NormalUser.exists({ _id: payload.user });
    if (!userExist) {
        throw new AppError(httpStatus.NOT_FOUND, 'This user not found');
    }
    const result = await ProjectMember.findOneAndUpdate(
        { project: projectId, user: payload.user },
        { project: projectId, ...payload },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    await Conversation.findOneAndUpdate(
        { project: projectId },
        { $addToSet: { participants: payload.user } }
    );
    return result;
};

const removeMember = async (userId: string, id: string) => {
    const member = await ProjectMember.findById(id);
    if (!member) {
        throw new AppError(httpStatus.NOT_FOUND, 'Member not found');
    }
    // Authz: solo el DUEÑO del proyecto puede expulsar, o el propio miembro
    // puede auto-removerse. Antes no se validaba nada → cualquiera con el id de
    // un ProjectMember echaba a cualquiera de cualquier proyecto.
    const ownsProject = await Project.findOne({
        _id: (member as any).project,
        owner: userId,
    }).select('_id');
    const isSelf = (member as any).user?.toString() === userId?.toString();
    if (!ownsProject && !isSelf) {
        throw new AppError(
            httpStatus.FORBIDDEN,
            'You are not allowed to remove this member'
        );
    }
    const result = await ProjectMember.findByIdAndDelete(id);
    await Conversation.findOneAndUpdate(
        { project: member.project },
        { $pull: { participants: member.user } },
        { new: true }
    );
    return result;
};

const ProjectMemberServices = { getAllProjectMember, addMember, removeMember };
export default ProjectMemberServices;
