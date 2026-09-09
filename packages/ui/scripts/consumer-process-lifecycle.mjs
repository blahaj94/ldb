export async function stopOwnedProcessGroup({ child, exited, kill = process.kill }) {
  const hasNoExitCode = child.exitCode == null
  const hasNoSignalCode = child.signalCode == null
  const isRunning = hasNoExitCode && hasNoSignalCode
  if (isRunning) {
    kill(-child.pid, 'SIGTERM')
  }
  await exited
}
