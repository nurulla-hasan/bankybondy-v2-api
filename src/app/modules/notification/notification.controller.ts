import { Request, Response } from 'express';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import notificationService from './notification.services';
import {
    digestService,
    unsubscribeFromDigest,
} from '../notificationDigest/digest.service';

const getAllNotification = catchAsync(async (req, res) => {
    const result = await notificationService.getAllNotificationFromDB(
        req?.query,
        req?.user
    );

    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Notification retrieved successfully',
        data: result,
    });
});

// Unseen count + last notification (same shape the socket emits).
const getUnseenCount = catchAsync(async (req, res) => {
    const result = await notificationService.getUnseenCount(req?.user);

    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Notification count retrieved successfully',
        data: result,
    });
});

const seeNotification = catchAsync(async (req, res) => {
    const result = await notificationService.seeNotification(req?.user);

    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Notification seen successfully',
        data: result,
    });
});
// Marks ONE notification as seen (when opening that specific one).
const seeOneNotification = catchAsync(async (req, res) => {
    const result = await notificationService.seeOneNotification(
        req?.user,
        req.params.id
    );

    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Notification seen successfully',
        data: result,
    });
});
const deleteNoficiation = catchAsync(async (req, res) => {
    const result = await notificationService.deleteNoficiation(
        req.params.id,
        req?.user.profileId
    );

    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Notification deleted successfully',
        data: result,
    });
});

// Per-category mute preferences (Tanda C).
const getPreferences = catchAsync(async (req, res) => {
    const result = await notificationService.getPreferences(req?.user);
    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Notification preferences retrieved successfully',
        data: result,
    });
});

const updatePreferences = catchAsync(async (req, res) => {
    const result = await notificationService.updatePreferences(
        req?.user,
        req.body?.mutedCategories
    );
    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: 'Notification preferences updated successfully',
        data: result,
    });
});

// Digest preview: sends only to the CALLER's own inbox (force = sample data if
// there is no real activity), so they can see the real render. Self-only.
const digestPreview = catchAsync(async (req, res) => {
    const result = await digestService.sendDigestToUser(req?.user?.profileId, {
        force: true,
    });
    sendResponse(res, {
        statusCode: 200,
        success: true,
        message: result.sent
            ? `Digest de preview enviado a ${result.email}`
            : `No se pudo enviar el preview (${result.reason})`,
        data: result,
    });
});

// Digest unsubscribe (List-Unsubscribe). Public, token-signed: the token in the
// email URL is the only auth. POST = Gmail one-click (200, no body); GET = simple
// confirmation page. `unsubscribeFromDigest` never throws (fails closed).
const digestUnsubscribe = async (req: Request, res: Response) => {
    const token = req.params.token || '';
    const result = await unsubscribeFromDigest(token);

    if (req.method === 'POST') {
        res.status(result.ok ? 200 : 400).end();
        return;
    }

    const page = (title: string, msg: string) =>
        `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#eef2f9;font-family:Arial,Helvetica,sans-serif"><div style="max-width:520px;margin:60px auto;background:#fff;border-radius:16px;padding:36px 28px;text-align:center;color:#0f2044;box-shadow:0 10px 30px rgba(15,32,72,.1)"><h2 style="margin:0 0 10px">${title}</h2><p style="color:#475467;line-height:1.6;margin:0">${msg}</p></div></body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(result.ok ? 200 : 400).send(
        result.ok
            ? page(
                  'Listo ✅',
                  'Te diste de baja del resumen semanal de Bankybondy. Podés volver a activarlo cuando quieras desde la campana, en tu cuenta.'
              )
            : page(
                  'Enlace inválido o vencido',
                  'No pudimos procesar la baja. Podés ajustar tus avisos desde la campana, en tu cuenta.'
              )
    );
};

const notificationController = {
    getAllNotification,
    getUnseenCount,
    seeNotification,
    seeOneNotification,
    deleteNoficiation,
    getPreferences,
    updatePreferences,
    digestPreview,
    digestUnsubscribe,
};

export default notificationController;
