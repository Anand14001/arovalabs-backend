const { z } = require('zod');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Email is required.')
  .email('Enter a valid email address.')
  .max(191);

/*
 * Password rules for *new* passwords only.
 *
 * Login does not apply them — an existing password that no longer meets the
 * policy must still be able to sign in, otherwise tightening the rules locks
 * people out of their own accounts.
 */
const newPassword = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(128, 'That is too long.')
  .refine((v) => /[a-z]/.test(v), 'Include a lowercase letter.')
  .refine((v) => /[A-Z]/.test(v), 'Include an uppercase letter.')
  .refine((v) => /[0-9]/.test(v), 'Include a number.');

const loginSchema = {
  body: z.object({
    email,
    password: z.string().min(1, 'Password is required.').max(128),
  }),
};

const changePasswordSchema = {
  body: z
    .object({
      currentPassword: z.string().min(1, 'Enter your current password.'),
      newPassword,
    })
    .refine((v) => v.currentPassword !== v.newPassword, {
      message: 'Choose a password different from the current one.',
      path: ['newPassword'],
    }),
};

const forgotPasswordSchema = { body: z.object({ email }) };

const resetPasswordSchema = {
  body: z.object({
    token: z.string().min(1, 'Reset link is incomplete.'),
    password: newPassword,
  }),
};

module.exports = {
  loginSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
};
