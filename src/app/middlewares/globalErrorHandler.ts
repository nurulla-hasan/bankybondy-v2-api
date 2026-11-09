// /* eslint-disable @typescript-eslint/no-explicit-any */
// import { ErrorRequestHandler } from 'express';
// import { ZodError } from 'zod';
// import config from '../config';
// import handleZodError from '../error/handleZodError';
// import { TErrorSources } from '../interface/error.interface';
// import handleValidationError from '../error/handleValidationError';
// import handleCastError from '../error/handleCastError';
// import handleDuplicateError from '../error/handleDuplicateError';
// import AppError from '../error/appError';

// // dynamic error handling and send error after make formatting ----------------------------------

// const globalErrorHandler: ErrorRequestHandler = (
//   err,
//   req,
//   res,
//   // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
//   next,
// ) => {
//   // setting default values
//   let statusCode = 500;
//   let message = 'Something went wrong';

//   let errorSources: TErrorSources = [
//     {
//       path: '',
//       message: 'Something went wrong',
//     },
//   ];

//   if (err instanceof ZodError) {
//     const simplifiedError = handleZodError(err);
//     statusCode = simplifiedError?.statusCode;
//     message = simplifiedError?.message;
//     errorSources = simplifiedError?.errorSources;
//   } else if (err?.name === 'ValidationError') {
//     const simplifiedError = handleValidationError(err);
//     statusCode = simplifiedError?.statusCode;
//     message = simplifiedError?.message;
//     errorSources = simplifiedError?.errorSources;
//   } else if (err?.name === 'CastError') {
//     const simplifiedError = handleCastError(err);
//     statusCode = simplifiedError?.statusCode;
//     message = simplifiedError?.message;
//     errorSources = simplifiedError?.errorSources;
//   } else if (err?.code === 11000) {
//     const simplifiedError = handleDuplicateError(err);
//     statusCode = simplifiedError?.statusCode;
//     message = simplifiedError?.message;
//     errorSources = simplifiedError?.errorSources;
//   } else if (err instanceof AppError) {
//     statusCode = err?.statusCode;
//     message = err?.message;
//     errorSources = [
//       {
//         path: '',
//         message: err.message,
//       },
//     ];
//   } else if (err instanceof Error) {
//     message = err?.message;
//     errorSources = [
//       {
//         path: '',
//         message: err.message,
//       },
//     ];
//   }

//   // ultimate return -----------
//   return res.status(statusCode).json({
//     success: false,
//     message,
//     errorSources,
//     // err,
//     stack: config.NODE_ENV === 'development' ? err.stack : null,
//   });
// };

// export default globalErrorHandler;

// new global error handler-------------------
// import { ErrorRequestHandler } from 'express';
// import { ZodError } from 'zod';
// import AppError from '../error/appError';
// import mongoose from 'mongoose';
// const globalErrorHandler: ErrorRequestHandler = (
//   err,
//   req,
//   res,
//   // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
//   next,
// ) => {
//   let statusCode = 500;
//   let message = 'Something went wrong';
//   let errorMessage = '';
//   let errorDetails = {};

//   if (err.code === 11000) {
//     message = 'Duplicate Error';
//     const match = err.message.match(/"([^"]*)"/);
//     const extractedMessage = match && match[1];
//     errorMessage = `${extractedMessage} is already exists`;
//     statusCode = 400;
//   } else if (err instanceof ZodError) {
//     message = 'Validation Error';
//     const concatedMessage = err.issues.map((issue, index) => {
//       if (index === err.issues.length - 1) {
//         return issue.message;
//       } else {
//         return issue.message + '.';
//       }
//     });
//     errorMessage = concatedMessage.join(' ') + '.';
//     errorDetails = {
//       issues: err.issues,
//     };
//   } else if (err instanceof mongoose.Error.ValidationError) {
//     message = 'Mongoose Validation Error';
//     errorMessage = Object.values(err.errors)
//       .map((val) => val.message)
//       .join(', ');
//     errorDetails = err.errors;
//     statusCode = 400;
//   } else if (err instanceof AppError) {
//     statusCode = err.statusCode;
//     errorMessage = err.message;
//   } else if (err?.name === 'CastError') {
//     statusCode = 400;
//     message = 'Invalid ID';
//     errorMessage = `${err.value} is not a valid ID!`;
//     errorDetails = err;
//   }
//   return res.status(statusCode).json({
//     success: false,
//     message: message,
//     errorMessage: errorMessage,
//     errorDetails,
//     stack: process.env.NODE_ENV === 'development' ? (err?.stack || null) : undefined,
//     // err,
//   });
// };

// export default globalErrorHandler;

import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import AppError from '../error/appError';
import mongoose from 'mongoose';
import { errorLogger } from '../shared/logger';
const globalErrorHandler: ErrorRequestHandler = (
  err,
  req,
  res,
  // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
  next,
) => {
  let statusCode = 500;
  // let message = 'Something went wrong';
  let errorMessage = 'Something went wrong';
  let errorDetails = {};
  // Codigo maquina-legible opcional (ej. 'BOND_LIMIT_REACHED').
  let errorCode: string | undefined;

  if (err.code === 11000) {
    // message = 'Duplicate Error';
    const match = err.message.match(/"([^"]*)"/);
    const extractedMessage = match && match[1];
    errorMessage = `${extractedMessage} is already exists`;
    statusCode = 400;
  } else if (err instanceof ZodError) {
    // message = 'Validation Error';
    const concatedMessage = err.issues.map((issue, index) => {
      if (index === err.issues.length - 1) {
        return issue.message;
      } else {
        return issue.message + '.';
      }
    });
    errorMessage = concatedMessage.join(' ') + '.';
    errorDetails = {
      issues: err.issues,
    };
    // Un body invalido es culpa del cliente, no del server. Faltaba esta linea
    // (las ramas vecinas si la tienen) y los errores de validacion salian con el
    // statusCode inicial 500, ensuciando el monitoreo como error interno.
    statusCode = 400;
  } else if (err instanceof mongoose.Error.ValidationError) {
    // message = 'Mongoose Validation Error';
    errorMessage = Object.values(err.errors)
      .map((val) => val.message)
      .join(', ');
    errorDetails = err.errors;
    statusCode = 400;
  } else if (err instanceof AppError) {
    statusCode = err.statusCode;
    errorMessage = err.message;
    errorCode = err.code;
  } else if (err?.name === 'CastError') {
    statusCode = 400;
    // message = 'Invalid ID';
    errorMessage = `${err.value} is not a valid ID!`;
    // No serializar el objeto de error crudo al cliente (fuga de internals).
    errorDetails = { path: err?.path, value: err?.value };
  } else if (err?.name === 'MulterError') {
    // Multer (and multer-s3) failures used to fall through to the default 500.
    // A size overflow is the client's fault and deserves a 413, not an
    // "Internal Server Error" toast with no information.
    statusCode = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    errorMessage = err.message;
  }

  // Los 5xx se registran con stack: sin esto, un fallo de multer/S3 salía
  // como 500 opaco y no dejaba rastro en logs/winston/errors.
  if (statusCode >= 500) {
    errorLogger.error(
      `[http] ${req.method} ${req.originalUrl} -> ${statusCode}`,
      err
    );
  }

  return res.status(statusCode).json({
    success: false,
    message: errorMessage,
    // errorMessage: errorMessage,
    // Solo se incluye cuando el error trae un codigo maquina-legible.
    ...(errorCode ? { code: errorCode } : {}),
    errorDetails,
    stack: process.env.NODE_ENV === 'development' ? (err?.stack || null) : undefined,
    // err,
  });
};

export default globalErrorHandler;
