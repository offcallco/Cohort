import { z } from "zod";

// Request bodies and response shapes for the Cohort HTTP API.
// The server validates with these; the web app uses the inferred types.

export const credentials = z.object({
  username: z
    .string()
    .trim()
    .min(1, "Username is required")
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/, "Use letters, numbers, dots, dashes or underscores"),
  password: z.string().min(8, "Password must be at least 8 characters").max(256),
});
export type Credentials = z.infer<typeof credentials>;

export const createTokenBody = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
});
export type CreateTokenBody = z.infer<typeof createTokenBody>;

export interface User {
  id: number;
  username: string;
}

export interface Status {
  // True until the first account has been created on this install.
  setupRequired: boolean;
  user: User | null;
  version: string;
}

export interface AccessToken {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// Returned once, when a token is created. The plain token is never shown again.
export interface CreatedAccessToken extends AccessToken {
  token: string;
}

export interface ApiError {
  error: string;
}
