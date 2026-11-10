/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import SkillServices from './skill.service';

const createSkill = catchAsync(async (req, res) => {
    const result = await SkillServices.createSkill(req.body);
    sendResponse(res, {
        statusCode: httpStatus.CREATED,
        success: true,
        message: 'Skill created successfully',
        data: result,
    });
});

const getAllSkills = catchAsync(async (req, res) => {
    const result = await SkillServices.getAllSkill(req.query);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Skills retrieved successfully',
        data: result,
    });
});

const getSkillById = catchAsync(async (req, res) => {
    const { skillId } = req.params;
    const result = await SkillServices.getSkillById(skillId);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Skill retrieved successfully',
        data: result,
    });
});

const updateSkill = catchAsync(async (req, res) => {
    const { skillId } = req.params;
    const result = await SkillServices.updateSkill(skillId, req.body);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Skill updated successfully',
        data: result,
    });
});

const deleteSkill = catchAsync(async (req, res) => {
    const { skillId } = req.params;
    const result = await SkillServices.deleteTopic(skillId);
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Skill deleted successfully',
        data: result,
    });
});

const SkillController = {
    createSkill,
    getAllSkills,
    getSkillById,
    updateSkill,
    deleteSkill,
};

export default SkillController;
