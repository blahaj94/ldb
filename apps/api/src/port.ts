const configurationError = 'Invalid server configuration'

export function parsePort(value: string | undefined): number {
  const isValueMissing = value === undefined
  const isAsciiDecimal = !isValueMissing && /^[0-9]+$/.test(value)
  const isInputInvalid = isValueMissing || !isAsciiDecimal
  if (isInputInvalid) {
    throw new Error(configurationError)
  }

  const port = Number(value)
  const isPortInteger = Number.isInteger(port)
  const isBelowMinimum = isPortInteger && port < 1
  const isAboveMaximum = isPortInteger && !isBelowMinimum && port > 65_535
  const isPortInvalid = !isPortInteger || isBelowMinimum || isAboveMaximum
  if (isPortInvalid) {
    throw new Error(configurationError)
  }

  return port
}
