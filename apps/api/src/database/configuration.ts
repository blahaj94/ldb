export interface DatabaseConfiguration {
  host: string
  port: number
  username: string
  password: string
  database: string
}

const configurationError = 'Invalid database configuration'

function required(value: string | undefined): string {
  const isValueMissing = value === undefined
  const isValueEmpty = !isValueMissing && value.length === 0
  const isValueInvalid = isValueMissing || isValueEmpty
  if (isValueInvalid) {
    throw new Error(configurationError)
  }
  return value
}

export function readDatabaseConfiguration(env: NodeJS.ProcessEnv): DatabaseConfiguration {
  const portText = required(env.DB_PORT)
  const isPortDecimal = /^[0-9]+$/.test(portText)
  if (!isPortDecimal) {
    throw new Error(configurationError)
  }
  const port = Number(portText)
  const isPortSafeInteger = Number.isSafeInteger(port)
  const isPortBelowMinimum = port < 1
  const isPortAboveMaximum = port > 65_535
  const isPortInvalid = !isPortSafeInteger || isPortBelowMinimum || isPortAboveMaximum
  if (isPortInvalid) {
    throw new Error(configurationError)
  }

  return {
    host: required(env.DB_HOST),
    port,
    username: required(env.DB_USERNAME),
    password: required(env.DB_PASSWORD),
    database: required(env.DB_NAME)
  }
}
