export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

export class AuthError extends CliError {
  constructor(message: string) {
    super(message, 3);
    this.name = "AuthError";
  }
}
