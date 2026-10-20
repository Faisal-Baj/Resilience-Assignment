import { z } from 'zod';

// Throw this from a route to send an error with a status code and a message.
export class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields; // optional messages for each field, like { title: ['Title is required.'] }
  }
}

// Express sends every error here.
// The browser only gets a short message. For unexpected errors, the details are printed
// in the server console and nowhere else.
export function errorHandler(err, req, res, next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, fields: err.fields });
  }

  if (err instanceof z.ZodError) {
    const { formErrors, fieldErrors } = z.flattenError(err);
    return res.status(400).json({ error: formErrors[0] || 'Please correct the highlighted fields.', fields: fieldErrors });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON.' });
  }

  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
}
