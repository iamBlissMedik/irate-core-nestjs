import type { User } from '../../generated/prisma/client.js';

/** The public identity of a user (never includes the password hash). */
export interface AuthUserView {
  id: string;
  email: string;
  role: User['role'];
  createdAt: string;
}

export function toAuthUserView(user: User): AuthUserView {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}
