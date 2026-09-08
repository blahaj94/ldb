export interface DatabaseConfiguration {
  host: string
  port: number
  username: string
  password: string
  database: string
}

const configurationError = 'Invalid database configuration'

function required(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(configurationError)
  }
  return value
}

export function readDatabaseConfiguration(env: NodeJS.ProcessEnv): DatabaseConfiguration {
  const portText = required(env.DB_PORT)
  if (!/^[0-9]+$/.test(portText)) {
    throw new Error(configurationError)
  }
  const port = Number(portText)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
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
