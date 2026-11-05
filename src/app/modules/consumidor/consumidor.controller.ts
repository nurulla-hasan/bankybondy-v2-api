import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import { ConsumidorService } from './consumidor.service';
import { ConsumidorValidations } from './consumidor.validation';

export const crearSolicitud = catchAsync(async (req: Request, res: Response) => {
    // `validateRequest` valida pero DESCARTA el resultado del parse: sin esto, lo
    // que se guarda y se manda por mail es el `req.body` crudo, y los `.trim()` y
    // `.max()` del schema no acotan nada (se midió: 8 MB entraban a Mongo).
    // `parseAsync` y no `parse`: con un refinement async, `parse` lanza un error
    // que no es ZodError y el globalErrorHandler lo devolvería como 500.
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
