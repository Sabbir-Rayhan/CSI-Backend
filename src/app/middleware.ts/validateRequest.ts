import { NextFunction, Request, Response } from "express";
import z from "zod";

export const validateRequest = (zodSchema: z.ZodType) => {
    return (req: Request, res: Response, next: NextFunction) => {
        const parsedResult = zodSchema.safeParse(req.body ?? {});
        if (!parsedResult.success) {
            return next(parsedResult.error);
        }
        req.body = parsedResult.data;
        next();
    };
};