export function buildRateLimitErrorResponse(_request: unknown, context: { statusCode: number; after: string }): Error {
  const error = new Error('Too many requests, please try again later') as Error & {
    statusCode: number
    retryAfter: string
  }
  error.statusCode = context.statusCode
  error.retryAfter = context.after
  return error
}
