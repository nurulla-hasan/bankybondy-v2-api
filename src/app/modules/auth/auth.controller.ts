import httpStatus from 'http-status';
import catchAsync from '../../utilities/catchasync';
import sendResponse from '../../utilities/sendResponse';
import authServices from './auth.services';
import AppError from '../../error/appError';
import {
  clearAuthCookies,
  clearRefreshCookie,
  setAccessCookie,
  setAuthCookies,
  setRefreshCookie,
} from './refreshCookie';

// CONTRATO EXPLÍCITO web vs. nativo para el refresh token.
//
// El refresh token viaja SIEMPRE en la cookie HttpOnly, que el JS del browser no
// puede leer. Además venía en el JSON de la respuesta, y ahí un XSS que
// interceptara la respuesta del login se lo llevaba pese a la cookie segura.
//
// No se puede sacar del JSON y listo: hay una app nativa proyectada para Play
// Store, y una app nativa NO puede depender de cookies de navegador — necesita el
// token para guardarlo en su almacenamiento seguro. Así que en vez de cerrar la
// puerta, se hace explícita: el cliente nativo la pide con `x-client-type: native`.
//
// Por qué un header alcanza en ESTE punto: para leer el refresh token del JSON hay
// que provocar un login, y para eso hacen falta las credenciales del usuario. Un
// atacante que pueda hacer eso ya tiene la contraseña, así que el header no le
// suma nada. El endpoint que SÍ es alcanzable con sólo la cookie
// (`/refresh-token`) nunca devuelve un refresh token: sólo `accessToken`. Por ahí
// no hay fuga posible.
const CLIENT_TYPE_HEADER = 'x-client-type';

// Exportada para que la use también user.controller (verifyCode). Cualquier
// endpoint que pueda devolver un refresh token DEBE pasar por acá, o el token se
// filtra en el JSON para el browser.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const withRefreshTokenPolicy = (result: any, req: { headers: any }) => {
    if (!result || typeof result !== 'object') return result;
    const isNative =
        String(req.headers?.[CLIENT_TYPE_HEADER] ?? '').toLowerCase() ===
        'native';
    if (isNative) return result;
    // Browser: se omite del JSON. La cookie HttpOnly ya lo lleva.
    // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
    const { refreshToken: _omitted, ...rest } = result;
    return rest;
};

const loginUser = catchAsync(async (req, res) => {
  const result = await authServices.loginUserIntoDB(req.body);
  // Seteamos tanto access token como refresh token en cookies HttpOnly para el browser
  if (result?.accessToken || result?.refreshToken) {
    setAuthCookies(res, {
      accessToken: result?.accessToken,
      refreshToken: result?.refreshToken,
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User login successfully',
    data: withRefreshTokenPolicy(result, req),
  });
});
const changePassword = catchAsync(async (req, res) => {
  const { ...passwordData } = req.body;
  const result = await authServices.changePasswordIntoDB(
    req.user,
    passwordData,
  );

  // Cambiar la contraseña actualiza passwordChangedAt → invalida los tokens viejos.
  // El service emite tokens NUEVOS: seteamos cookies nuevas para el browser.
  if (result?.accessToken || result?.refreshToken) {
    setAuthCookies(res, {
      accessToken: result?.accessToken,
      refreshToken: result?.refreshToken,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Password is updated successfully',
    data: withRefreshTokenPolicy(result, req),
  });
});

const refreshToken = catchAsync(async (req, res) => {
  // Browser: la cookie HttpOnly `refreshToken` (el JS del front ya NO la manda ni
  // la ve). Móvil / otros clientes: el refresh token por el body. Se prioriza la
  // cookie y se cae al body por compatibilidad.
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Refresh token is required');
  }
  const result = await authServices.refreshToken(token);
  // Seteamos el nuevo accessToken en cookie HttpOnly también
  if (result?.accessToken) {
    setAccessCookie(res, result.accessToken);
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Access token is retrieved successfully',
    data: result,
  });
});

// Logout: borra las cookies HttpOnly (el browser no puede hacerlo desde JS).
// Idempotente y público.
const logoutUser = catchAsync(async (req, res) => {
  clearAuthCookies(res);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Logged out successfully',
    data: null,
  });
});
const forgetPassword = catchAsync(async (req, res) => {
  const email = req.body.email;
  const result = await authServices.forgetPassword(email);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    // Mensaje CONDICIONAL a propósito (anti-enumeración): no confirma que la
    // cuenta exista. El service manda el código sólo si la cuenta es válida.
    message: 'Si esa cuenta existe, te enviamos un código para restablecer tu contraseña.',
    data: result,
  });
});

const resetPassword = catchAsync(async (req, res) => {
  // const token = req?.headers?.authorization;

  // if (!token) {
  //   throw new AppError(httpStatus.BAD_REQUEST, 'Your token is invalid');
  // }
  const result = await authServices.resetPassword(req.body);
  // Seteamos cookies HttpOnly de sesión para el browser
  if (result?.accessToken || result?.refreshToken) {
    setAuthCookies(res, {
      accessToken: result?.accessToken,
      refreshToken: result?.refreshToken,
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Password reset successfully',
    data: withRefreshTokenPolicy(result, req),
  });
});
const verifyResetOtp = catchAsync(async (req, res) => {
  const result = await authServices.verifyResetOtp(
    req.body.email,
    req.body.resetCode,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Reset code verified',
    data: result,
  });
});

const resendResetCode = catchAsync(async (req, res) => {
  const result = await authServices.resendResetCode(req?.body.email);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    // Condicional a propósito, igual que forgetPassword.
    message: 'Si esa cuenta existe, te reenviamos el código.',
    data: result,
  });
});
const resendVerifyCode = catchAsync(async (req, res) => {
  const result = await authServices.resendVerifyCode(req?.body.email);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Verify code resend successfully',
    data: result,
  });
});

const oAuthLogin = catchAsync(async (req, res) => {
  const { provider, token, role } = req.body;
  if (!['google', 'apple', 'facebook'].includes(provider)) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid provider');
  }
  const result = await authServices.loginWithOAuth(provider, token, role);
  if (result?.accessToken || result?.refreshToken) {
    setAuthCookies(res, {
      accessToken: result?.accessToken,
      refreshToken: result?.refreshToken,
    });
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'User login successfully',
    data: withRefreshTokenPolicy(result, req),
  });
});

const authControllers = {
  loginUser,
  changePassword,
  refreshToken,
  logoutUser,
  forgetPassword,
  resetPassword,
  verifyResetOtp,
  resendResetCode,
  resendVerifyCode,
  oAuthLogin,
};

export default authControllers;
