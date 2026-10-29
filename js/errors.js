// Errors carry an i18n key so the UI can show them in the user's language.
export class AppError extends Error {
  constructor(code, vars = {}) {
    super(code);
    this.code = code;
    this.vars = vars;
  }
}
