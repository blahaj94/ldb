const configurationError = 'Invalid server configuration'

export function parsePort(value: string | undefined): number {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    throw new Error(configurationError)
  }

  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(configurationError)
  }

  return port
}
