import type { Role } from "@sys4sys/shared";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
    authSessionId?: string;
  }
}
