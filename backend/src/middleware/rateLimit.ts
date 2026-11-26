import type { Request, Response, NextFunction } from "express";

const pass = (_req: Request, _res: Response, next: NextFunction) => next();

export const globalRateLimiter = pass;
export const publicRateLimiter = pass;
export const applicationRateLimiter = pass;
export const authRateLimiter = pass;
export const totpRateLimiter = pass;

export const resetRateLimits = () => {};
