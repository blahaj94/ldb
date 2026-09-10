const configurationError = 'Invalid server configuration'

export function parsePort(value: string | undefined): number {
  const isValueMissing = value === undefined
  if (isValueMissing) {
    throw new Error(configurationError)
  }

  const isAsciiDecimal = /^[0-9]+$/.test(value)
  if (!isAsciiDecimal) {
    throw new Error(configurationError)
  }

  const port = Number(value)
  const isPortInteger = Number.isInteger(port)
  if (!isPortInteger) {
    throw new Error(configurationError)
  }

  const isBelowMinimum = port < 1
  const isAboveMaximum = port > 65_535
  const isPortInvalid = isBelowMinimum || isAboveMaximum
  if (isPortInvalid) {
    throw new Error(configurationError)
  }

  return port
}
