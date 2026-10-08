export interface TErrorSources {
    path: string,
    message: string,
}

export interface TErrorResponse {
    statusCode?: number,
    success: boolean,
    message: string,
    stack?: string,
    errorSources: TErrorSources[],
    error?: unknown
}
