class AppError extends Error {
  public statusCode: number;
  // Optional machine-readable code so the frontend need not parse messages.
  public code?: string;
  constructor(statusCode: number, message: string, code?: string, stack = '') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export default AppError;
