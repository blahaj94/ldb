export function cleanupFailure(): Error {
  const error = new Error('Authentication cleanup failed')
  error.stack = `${error.name}: ${error.message}`
  return error
}
