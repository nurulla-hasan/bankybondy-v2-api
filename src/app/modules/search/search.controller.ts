import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import SearchService from './search.service';

// GET /search/global?q=<term>
// Lightweight global search for the authenticated user. Never throws on empty
// input: a missing/too-short q returns empty lists without touching the DB.
const globalSearch = catchAsync(async (req, res) => {
    const result = await SearchService.globalSearch(
        req.user.profileId,
        req.query.q
    );
    sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: 'Search results retrieved successfully',
        data: result,
    });
});

const SearchController = {
    globalSearch,
};

export default SearchController;
