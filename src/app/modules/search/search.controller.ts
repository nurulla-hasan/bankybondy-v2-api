import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import SearchService from './search.service';

// GET /search/global?q=<term>
// Busqueda global ligera para el usuario autenticado. Nunca lanza sobre
// entrada vacia: si q falta o es demasiado corto, el servicio devuelve listas
// vacias sin tocar la base.
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
