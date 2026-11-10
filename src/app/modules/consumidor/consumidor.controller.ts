import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import { ConsumidorService } from './consumidor.service';
import { ConsumidorValidations } from './consumidor.validation';

export const crearSolicitud = catchAsync(async (req: Request, res: Response) => {
    // `validateRequest` validates but discards the parse result: without this,
    // the raw `req.body` is what gets stored and emailed, so the schema's `.trim()`
    // and `.max()` bound nothing (8 MB reached Mongo). `parseAsync`, not `parse`:
    // with an async refinement `parse` throws a non-ZodError that
    // globalErrorHandler would return as 500.
    const { body } = await ConsumidorValidations.crearSolicitudSchema.parseAsync({
        body: req.body,
    });
    const result = await ConsumidorService.crearSolicitud(body as any);
    sendResponse(res, {
        statusCode: httpStatus.CREATED,
        success: true,
        message: 'Request received',
        data: result,
    });
});
