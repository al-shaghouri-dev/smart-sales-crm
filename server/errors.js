/**
 * Errors carry a stable machine-readable `code`; the frontend translates it (errors.<code>).
 * `message` is an English fallback for API clients and logs.
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const unauthorized = (code = 'auth.required', message = 'Authentication required') => new AppError(401, code, message);
const forbidden = (code = 'auth.forbidden', message = 'You do not have permission to do this') => new AppError(403, code, message);
const notFound = (code = 'common.not_found', message = 'Not found') => new AppError(404, code, message);
const conflict = (code, message) => new AppError(409, code, message);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound, conflict };
