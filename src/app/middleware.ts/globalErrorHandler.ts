import { NextFunction, Request, Response } from "express"
import { envVars } from "../../config/env";
import status from "http-status";
import z from "zod";
import { TErrorResponse, TErrorSources } from "../interfaces/error.interface";
import { handleZodError } from "../errorHelpers/handleZodError";
import AppError from "../errorHelpers/appError";


export const globalErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {

    if (envVars.NODE_ENV === "development") {
        console.error("Error from Global Error Handler", err);
    }


    let errorSource: TErrorSources[] = []
    let statusCode: number = status.INTERNAL_SERVER_ERROR
    let message: string = "Internal Server Error";
    let stack: string | undefined = undefined;

    if (err instanceof z.ZodError) {
        const simplifiedError = handleZodError(err);
        statusCode = simplifiedError.statusCode as number,
            message = simplifiedError.message;
        errorSource = [...simplifiedError.errorSources]
    } else if (err instanceof AppError) {
        statusCode = err.statusCode
        message = err.message;
        stack = err.stack;
    } else if(err instanceof Error){
        statusCode = status.INTERNAL_SERVER_ERROR;
        message = err.message;
        stack = err.stack;
    }

    const errorResponse: TErrorResponse = {
        success: false,
        message: message,
        errorSources: errorSource,
        stack: envVars.NODE_ENV === "development" ? stack : undefined,
        error: envVars.NODE_ENV === "development" ? err : undefined
    }


    res.status(statusCode).json(errorResponse);
}