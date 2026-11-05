import { z } from 'zod';

const loginValidationSchema = z.object({
  body: z.object({
    email: z.string({ required_error: 'Email is required' }),
    password: z.string({ required_error: 'Password is required' }),
  }),
});

const googleSignUpValidationSchema = z.object({
  body: z.object({
    name: z.string({ required_error: 'Name is required' }),
    email: z.string({ required_error: 'Email is required' }),
    profile_image: z.string().optional(),
  }),
});

const changePasswordValidationSchema = z.object({
  body: z.object({
    oldPassword: z.string({ required_error: 'Old password is required' }),
    newPassword: z.string({ required_error: 'Password is required' }),
    confirmNewPassword: z.string({
      required_error: 'Confirm password is required',
    }),
  }),
});

// refresh token validation schema -----------
// El refresh token ahora puede venir por la cookie HttpOnly (browser) en vez del
// body (móvil), así que acá es OPCIONAL. La presencia real se valida en el
// controller (cookie || body) devolviendo 400 si faltan ambos.
const refreshTokenValidationSchema = z.object({
  body: z.object({
    refreshToken: z.string().optional(),
  }),
});

// forget password validation schema
const forgetPasswordValidationSchema = z.object({
  body: z.object({
    email: z.string({ required_error: 'Email is required' }),
  }),
});
// reset password validation schema
const resetPasswordValidationSchema = z.object({
  body: z.object({
    email: z.string({ required_error: 'Email is required' }),
    password: z.string({ required_error: 'Password is required' }),
    confirmPassword: z.string({
      required_error: 'Confirm password is required',
    }),
  }),
});

const verifyResetOtpValidationSchema = z.object({
  body: z.object({
    email: z.string({ required_error: 'Email is required' }),
    resetCode: z.number({
      required_error: 'Reset code is required',
      invalid_type_error: 'Reset code must be number',
    }),
  }),
});

const resendResetCodeValidationSchema = z.object({
  body: z.object({
    email: z.string({ required_error: 'Email is required' }),
  }),
});

const authValidations = {
  loginValidationSchema,
  changePasswordValidationSchema,
  refreshTokenValidationSchema,
  forgetPasswordValidationSchema,
  resetPasswordValidationSchema,
  verifyResetOtpValidationSchema,
  resendResetCodeValidationSchema,
  googleSignUpValidationSchema,
};

export default authValidations;
