/* eslint-disable @typescript-eslint/no-explicit-any */
import httpStatus from 'http-status';
import { getCloudFrontUrl } from '../../helper/mutler-s3-uploader';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import PlaylistService from './playlist.service';
import { USER_ROLE } from '../user/user.constant';

const createPlaylist = catchAsync(async (req, res) => {
    const file: any = req.files?.playlist_cover;
    if (req.files?.playlist_cover) {
        req.body.cover_image = getCloudFrontUrl(file[0].key);
    }
    const result = await PlaylistService.createPlaylist(
        req.user.profileId,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.CREATED,
        success: true,
        message: 'Playlist created successfully',
        data: result,
    });
});

const getAllPlaylists = catchAsync(async (req, res) => {
    const result = await PlaylistService.getAllPlaylists(
        req.query,
        req.user.profileId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Playlists retrieved successfully',
        data: result,
    });
});
const getMyPlaylists = catchAsync(async (req, res) => {
    const result = await PlaylistService.getMyPlaylists(
        req.user.profileId,
        req.query
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Playlists retrieved successfully',
        data: result,
    });
});

const getPlaylistById = catchAsync(async (req, res) => {
    const { playlistId } = req.params;
// The viewer is passed so blocking is applied (hide the playlist and audios of
// blocked owners). An admin/superAdmin has no NormalUser profileId, so it travels
// as undefined and no block filter runs — correct, admins don't block peers.
    const result = await PlaylistService.getPlaylistById(
        playlistId,
        req.user.profileId
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Playlist retrieved successfully',
        data: result,
    });
});

const updatePlaylist = catchAsync(async (req, res) => {
    const file: any = req.files?.playlist_cover;
    if (req.files?.playlist_cover) {
        req.body.cover_image = getCloudFrontUrl(file[0].key);
    }
    const { playlistId } = req.params;
    const result = await PlaylistService.updatePlaylist(
        req.user.profileId,
        playlistId,
        req.body
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Playlist updated successfully',
        data: result,
    });
});

const deletePlaylist = catchAsync(async (req, res) => {
    const { playlistId } = req.params;
    // The route lets admin/superAdmin through as well (moderation). Without this the
    // service required ownership and the admin (no profileId) got a 404.
    const isAdmin =
        req.user.role === USER_ROLE.admin ||
        req.user.role === USER_ROLE.superAdmin;
    const result = await PlaylistService.deletePlaylist(
        req.user.profileId,
        playlistId,
        isAdmin
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Playlist deleted successfully',
        data: result,
    });
});

const PlaylistController = {
    createPlaylist,
    getAllPlaylists,
    getPlaylistById,
    updatePlaylist,
    deletePlaylist,
    getMyPlaylists,
};

export default PlaylistController;
