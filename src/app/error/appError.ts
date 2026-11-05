class AppError extends Error {
  public statusCode: number;
  // Codigo maquina-legible opcional (ej. 'BOND_LIMIT_REACHED') para que el
  // front pueda reaccionar de forma inequivoca sin parsear el mensaje.
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
