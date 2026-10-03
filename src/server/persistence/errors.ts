/** Errors the caller can act on, with the HTTP status the library API maps them to. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message)
    this.name = 'RequestError'
  }
}

export const notFound = () => new RequestError('Session not found', 404)
