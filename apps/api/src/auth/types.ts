import type { AuthMethod, Role, TokenScope } from "@sys4sys/shared";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface AuthTokenInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  expiresAt: string;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
    authSessionId?: string;
    authToken?: AuthTokenInfo;
    authMethod?: AuthMethod;
    authScopes?: TokenScope[];
  }

  interface FastifyContextConfig {
    /** Bearer 認証時に必要なスコープ。未設定は既定拒否。 */
    scopes?: TokenScope[];
    /** 認証だけで許可するルート。 */
    authOnly?: boolean;
  }
}
