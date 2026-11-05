export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new HttpError(400, message, 'bad_request');
export const blocked = (message) => new HttpError(403, message, 'blocked_target');
