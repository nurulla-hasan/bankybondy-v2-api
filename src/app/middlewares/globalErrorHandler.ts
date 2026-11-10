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
  // Optional machine-readable code (e.g. 'BOND_LIMIT_REACHED').
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
    // An invalid body is the client's fault: without this the Zod branch returned
    // the initial 500 and polluted internal-error monitoring.
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
    // Do not serialize the raw error object to the client (internals leak).
    errorDetails = { path: err?.path, value: err?.value };
  } else if (err?.name === 'MulterError') {
    // Multer (and multer-s3) failures used to fall through to the default 500.
    // A size overflow is the client's fault and deserves a 413.
    statusCode = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    errorMessage = err.message;
  }

  // Log 5xx with stack; otherwise a multer/S3 failure leaves no trace in errors log.
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
    // Only included when the error carries a machine-readable code.
    ...(errorCode ? { code: errorCode } : {}),
    errorDetails,
    stack: process.env.NODE_ENV === 'development' ? (err?.stack || null) : undefined,
    // err,
  });
};

export default globalErrorHandler;
